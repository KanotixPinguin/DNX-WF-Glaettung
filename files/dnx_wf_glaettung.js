/* ============================================================================
   DNX Wasserfall-Glaettung (Variante 2b+: Vollband + Zeilenblitz + Schraegstrich + Rauschboden)
   Version: 1.3.1
   ----------------------------------------------------------------------------
   Glaettet breite Stoerteppiche (50-200 kHz Buckel sowie >550 kHz Breitband-
   Stoerwolken), waagerechte Zeilenblitze, schraege Wanderstoerungen
   (Schraegstriche / Chirps / Schaltnetzteil-Drifts) sowie unruhiges Rauschboden-
   Grieseln NUR im Wasserfall. Schmale Nutzsignale (CW, FT8, SSB, AM, NFM, CB)
   bleiben dabei vollstaendig scharf erhalten.

   Neu in v1.3.x:
     - Signalerhaltende Rauschboden-Beruhigung (Stufe 3: gated 7-Tap + EMA)
     - Automatischer Breitband-Schutz fuer UKW-FM (WFM) und DAB+
     - Kein automatisches Panel-Popup beim Styler-Start (oeffnet nur per Klick)

   Unveraendert bleiben:
     - Spektrum-Anzeige & Spek: Pegel (Range/Offset)
     - S-Meter, Scanner, Squelch & Audio
     - Alle Profilwerte auf dem Server (settings.json, waterfall_levels, RF-Gain)

   Standardzustand beim ersten Laden: AUS (enabled = false).
   ============================================================================ */
(function () {
    "use strict";
    if (window.__dnxWfGlaettung) return;
    window.__dnxWfGlaettung = true;

    var VERSION = "1.3.1";
    var STORE_KEY = "dnx_wfg_cfg_v1";
    var BTN_ID = "dnx-master-wfglaettung";
    var SOLO_ID = "dnx-wfg-standalone";
    var PANEL_ID = "dnx-wfg-panel";
    var ROW_ID = "dnx-master-tool-row";

    var DEFAULTS = {
        enabled: false,     // WICHTIG: Standard = AUS
        strength: 100,      // % (20..100)
        widthKhz: 65,       // kHz Fenster fuer gleitenden Median (20..150)
        wideband: true,     // Vollband-Basislinie (glaettet auch >550 kHz breite Stoerwolken)
        rowStabilize: true, // Zeitlicher Zielboden (beruhigt waagerechte Zeilenblitze)
        diagonal: true,     // Schraegstrich-Glaettung (schraege Wanderstoerungen / Chirps)
        floorPolish: true,  // Signalerhaltende Rauschboden-Beruhigung (gegen Grieseln)
        deadzoneDb: 0.35,   // Kleine Rauschschwankungen unter 0.35 dB nicht anfassen
        perProfile: false,  // Optional: Ein/Aus je OpenWebRX-Profil merken
        profileMap: {}
    };

    var cfg = loadCfg();
    var lastStats = { quietDb: null, maxExDb: 0, diagCount: 0, active: false };
    var uiRefs = { panel: null, open: false };

    // Zeitlicher Zielboden & Schraegstrich-Verfolgung fuer Live-Zeilen / Diagnose
    var liveFloor = { ema: null, bw: 0, cf: 0, n: 0 };
    var diagFloor = { ema: null, bw: 0, cf: 0, n: 0 };
    var liveDiag = makeDiagState();
    var diagDiag = makeDiagState();
    var livePolish = makePolishState();
    var diagPolish = makePolishState();

    function makePolishState() {
        return {
            n: 0, bw: 0, cf: 0, lastMed: NaN,
            baseArr: null, clamped: null, quiet: null,
            ema: null, prevQuiet: null, out: null,
            medSample: new Float32Array(33)
        };
    }

    function makeDiagState() {
        return {
            n: 0, bw: 0, cf: 0,
            B: 0, step: 1, H: 9,
            rowIdx: 0, kFl: 21, kSm: 5,
            minV: 1.0, maxV: 80,
            hist: null, peaks: null,
            statEma: null,
            sm: null, diagOut: null,
            bMean: null, bPeak: null, bFloor: null,
            ex: null, kill: null, cand: null, statMask: null
        };
    }

    // Fallback-Ringpuffer, falls DNX Styler (__dnxWfHist) nicht geladen ist
    var FB = { w: 0, cap: 260, n: 0, db: [], ziel: [] };

    // Vorgemerkte Rechenpuffer (keine GC-Last pro Zeile)
    var scratch = {
        n: 0,
        m: 0,
        lastM: 0,
        lastStep: 1,
        blocks: null,
        med65: null,
        wideIn: null,
        sortBuf: null,
        wideBase: null,
        exBlock: null,
        outRow: null,
        winBuf: null,
        wideBuf: null
    };

    // --------------------------------------------------------- CSS laden
    function ensureCss() {
        if (document.getElementById("dnx-wfg-css")) return;
        try {
            var base = "";
            var scripts = document.getElementsByTagName("script");
            for (var i = scripts.length - 1; i >= 0; i--) {
                var src = scripts[i].src || "";
                if (src.indexOf("dnx_wf_glaettung") >= 0) {
                    base = src.replace(/dnx_wf_glaettung\.js.*$/, "");
                    break;
                }
            }
            if (!base) base = "static/plugins/receiver/dnx_wf_glaettung/";
            var l = document.createElement("link");
            l.id = "dnx-wfg-css";
            l.rel = "stylesheet";
            l.href = base + "dnx_wf_glaettung.css?v=" + VERSION + "-1";
            (document.head || document.documentElement).appendChild(l);
        } catch (e) { }
    }

    // --------------------------------------------------------- Konfiguration
    function loadCfg() {
        var c = {
            enabled: DEFAULTS.enabled,
            strength: DEFAULTS.strength,
            widthKhz: DEFAULTS.widthKhz,
            wideband: DEFAULTS.wideband,
            rowStabilize: DEFAULTS.rowStabilize,
            diagonal: DEFAULTS.diagonal,
            floorPolish: DEFAULTS.floorPolish,
            deadzoneDb: DEFAULTS.deadzoneDb,
            perProfile: DEFAULTS.perProfile,
            profileMap: {}
        };
        try {
            var raw = localStorage.getItem(STORE_KEY);
            if (raw) {
                var p = JSON.parse(raw);
                if (p && typeof p === "object") {
                    if (typeof p.enabled === "boolean") c.enabled = p.enabled;
                    if (isFinite(p.strength)) c.strength = clamp(Math.round(p.strength), 20, 100);
                    if (isFinite(p.widthKhz)) c.widthKhz = clamp(Math.round(p.widthKhz), 20, 150);
                    if (typeof p.wideband === "boolean") c.wideband = p.wideband;
                    if (typeof p.rowStabilize === "boolean") c.rowStabilize = p.rowStabilize;
                    if (typeof p.diagonal === "boolean") c.diagonal = p.diagonal;
                    if (typeof p.floorPolish === "boolean") c.floorPolish = p.floorPolish;
                    if (typeof p.perProfile === "boolean") c.perProfile = p.perProfile;
                    if (p.profileMap && typeof p.profileMap === "object") c.profileMap = p.profileMap;
                }
            }
        } catch (e) { }
        return c;
    }

    function saveCfg() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
        } catch (e) { }
    }

    function clamp(v, lo, hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    function activeProfileId() {
        try {
            var el = document.getElementById("openwebrx-sdr-profiles-listbox");
            if (el && el.value) return String(el.value);
        } catch (e) { }
        return "";
    }

    function isEnabled() {
        if (cfg.perProfile) {
            var pid = activeProfileId();
            if (pid && Object.prototype.hasOwnProperty.call(cfg.profileMap, pid)) {
                return !!cfg.profileMap[pid];
            }
            return false; // Unbekannte Profile im Profil-Modus sicherheitshalber AUS
        }
        return !!cfg.enabled;
    }

    function setEnabled(val) {
        val = !!val;
        if (cfg.perProfile) {
            var pid = activeProfileId();
            if (pid) cfg.profileMap[pid] = val;
            cfg.enabled = val;
        } else {
            cfg.enabled = val;
        }
        saveCfg();
        try {
            var rawTools = localStorage.getItem("dnx_styler_tools");
            if (rawTools) {
                var tm = JSON.parse(rawTools);
                if (tm && typeof tm === "object" && Object.prototype.hasOwnProperty.call(tm, "t_wfglaettung")) {
                    tm.t_wfglaettung = val ? 1 : 0;
                    localStorage.setItem("dnx_styler_tools", JSON.stringify(tm));
                }
            }
        } catch (eT) { }
        syncUi();
        repaintAll();
    }

    // --------------------------------------------------------- Mathe: Variante 2b+
    function ensureScratch(N, M, innerLen) {
        if (scratch.n !== N) {
            scratch.n = N;
            scratch.outRow = new Float32Array(N);
        }
        if (scratch.m !== M) {
            scratch.m = M;
            scratch.blocks = new Float32Array(M);
            scratch.med65 = new Float32Array(M);
            scratch.wideBase = new Float32Array(M);
            scratch.exBlock = new Float32Array(M);
        }
        if (!scratch.wideIn || scratch.wideIn.length < innerLen) {
            scratch.wideIn = new Float32Array(innerLen);
        }
        if (!scratch.sortBuf || scratch.sortBuf.length < innerLen) {
            scratch.sortBuf = new Float32Array(innerLen);
        }
    }

    function insertionSortSmall(arr, len) {
        for (var i = 1; i < len; i++) {
            var x = arr[i];
            var j = i - 1;
            while (j >= 0 && arr[j] > x) {
                arr[j + 1] = arr[j];
                j--;
            }
            arr[j + 1] = x;
        }
    }

    function sortedWindowMedian(src, len, kWin, outArr) {
        var half = (kWin - 1) >> 1;
        if (!scratch.winBuf || scratch.winBuf.length < kWin) {
            scratch.winBuf = new Float32Array(kWin);
        }
        var win = scratch.winBuf;
        for (var j = 0; j < kWin; j++) {
            var idx = j - half;
            if (idx < 0) idx = 0;
            else if (idx >= len) idx = len - 1;
            win[j] = src[idx];
        }
        insertionSortSmall(win, kWin);
        var mid = kWin >> 1;
        outArr[0] = win[mid];

        for (var b = 1; b < len; b++) {
            var outIdx = b - 1 - half;
            if (outIdx < 0) outIdx = 0;
            var inIdx = b + half;
            if (inIdx >= len) inIdx = len - 1;
            var outVal = src[outIdx];
            var inVal = src[inIdx];
            if (outVal !== inVal) {
                var lo = 0, hi = kWin - 1;
                while (lo < hi) {
                    var m = (lo + hi) >> 1;
                    if (win[m] < outVal) lo = m + 1;
                    else hi = m;
                }
                var pos = lo;
                if (inVal > outVal) {
                    while (pos + 1 < kWin && win[pos + 1] < inVal) {
                        win[pos] = win[pos + 1];
                        pos++;
                    }
                } else {
                    while (pos > 0 && win[pos - 1] > inVal) {
                        win[pos] = win[pos - 1];
                        pos--;
                    }
                }
                win[pos] = inVal;
            }
            outArr[b] = win[mid];
        }
    }

    function sortedWindowQuantile(src, len, kWin, qFrac, outArr) {
        var half = (kWin - 1) >> 1;
        if (!scratch.wideBuf || scratch.wideBuf.length < kWin) {
            scratch.wideBuf = new Float32Array(kWin);
        }
        var win = scratch.wideBuf;
        for (var j = 0; j < kWin; j++) {
            var idx = j - half;
            if (idx < 0) idx = 0;
            else if (idx >= len) idx = len - 1;
            win[j] = src[idx];
        }
        insertionSortSmall(win, kWin);
        var qIdx = clamp(Math.floor(kWin * qFrac), 0, kWin - 1);
        outArr[0] = win[qIdx];

        for (var b = 1; b < len; b++) {
            var outIdx = b - 1 - half;
            if (outIdx < 0) outIdx = 0;
            var inIdx = b + half;
            if (inIdx >= len) inIdx = len - 1;
            var outVal = src[outIdx];
            var inVal = src[inIdx];
            if (outVal !== inVal) {
                var lo = 0, hi = kWin - 1;
                while (lo < hi) {
                    var m = (lo + hi) >> 1;
                    if (win[m] < outVal) lo = m + 1;
                    else hi = m;
                }
                var pos = lo;
                if (inVal > outVal) {
                    while (pos + 1 < kWin && win[pos + 1] < inVal) {
                        win[pos] = win[pos + 1];
                        pos++;
                    }
                } else {
                    while (pos > 0 && win[pos - 1] > inVal) {
                        win[pos] = win[pos - 1];
                        pos--;
                    }
                }
                win[pos] = inVal;
            }
            outArr[b] = win[qIdx];
        }
    }

    var s5 = new Float32Array(5);

    function isWideBroadcast() {
        try {
            var pid = activeProfileId().toLowerCase();
            if (pid.indexOf("dab_") >= 0 || pid.indexOf("wfm") >= 0 || pid.indexOf("ukw") >= 0) return true;
            var el = document.getElementById("openwebrx-sdr-profiles-listbox");
            if (el && el.selectedIndex >= 0) {
                var txt = (el.options[el.selectedIndex].text || "").toLowerCase();
                if (txt.indexOf("dab") >= 0 || txt.indexOf("ukw") >= 0 || txt.indexOf("fm ") >= 0) return true;
            }
            var dm = document.querySelector(".openwebrx-demodulator-selected, .openwebrx-button.highlighted[data-mod]");
            if (dm) {
                var md = (dm.getAttribute("data-mod") || dm.textContent || "").toLowerCase();
                if (md === "wfm" || md === "dab") return true;
            }
            var cf = (typeof window.center_freq === "number") ? window.center_freq : 0;
            var bw = (typeof window.bandwidth === "number") ? window.bandwidth : 0;
            if (bw >= 1500000 && ((cf >= 87500000 && cf <= 108500000) || (cf >= 174000000 && cf <= 240000000))) return true;
        } catch (e) { }
        return false;
    }

    function computeFilteredRow(data, outArr, updateStats, floorState, skipSub) {
        var N = data.length;
        if (!N || N < 128) return data;
        var bw = (typeof window.bandwidth === "number" && window.bandwidth > 10000) ? window.bandwidth : 2400000;
        var dfHz = bw / N;
        var winBins = Math.round((cfg.widthKhz * 1000) / dfHz);
        winBins = clamp(winBins, 12, Math.max(20, Math.floor(N * 0.16)));

        var minStep = Math.max(1, Math.floor(N / 1600));
        var step = Math.max(minStep, Math.floor(winBins / 25));
        var M = Math.floor(N / step);
        var kMed = clamp(Math.round(winBins / step), 7, 25);
        if ((kMed & 1) === 0) kMed++;

        if (M < 40) {
            scratch.lastM = 0;
            for (var c0 = 0; c0 < N; c0++) outArr[c0] = data[c0];
            return outArr;
        }

        var i0 = Math.floor(M * 0.10);
        var i1 = Math.ceil(M * 0.90);
        var innerLen = i1 - i0;
        ensureScratch(N, M, innerLen);

        var blocks = scratch.blocks;
        var med65 = scratch.med65;
        var wideIn = scratch.wideIn;
        var wideBase = scratch.wideBase;
        var exBlock = scratch.exBlock;

        // 1) Schneller 5-Punkte-Median je Block
        for (var b = 0; b < M; b++) {
            var base = b * step;
            if (step <= 1) {
                blocks[b] = data[base];
            } else {
                var s = step - 1;
                s5[0] = data[base];
                s5[1] = data[base + ((s * 0.25) | 0)];
                s5[2] = data[base + ((s * 0.50) | 0)];
                s5[3] = data[base + ((s * 0.75) | 0)];
                s5[4] = data[base + s];
                insertionSortSmall(s5, 5);
                blocks[b] = s5[2];
            }
        }

        // 2) Gleitender Median ueber kMed Bloecke (20..150 kHz)
        sortedWindowMedian(blocks, M, kMed, med65);

        // 3) Breite Innenband-Basislinie (~550 kHz p25 auf den inneren 80 %)
        var blockHz = step * dfHz;
        var kWide = Math.round(550000 / blockHz);
        kWide = clamp(kWide, 31, Math.max(31, Math.floor(innerLen * 0.45)));
        if ((kWide & 1) === 0) kWide++;
        sortedWindowQuantile(med65.subarray(i0, i1), innerLen, kWide, 0.25, wideIn);

        for (var a = 0; a < i0; a++) wideBase[a] = wideIn[0];
        for (var k = 0; k < innerLen; k++) wideBase[i0 + k] = wideIn[k];
        for (var z = i1; z < M; z++) wideBase[z] = wideIn[innerLen - 1];

        // 3b) Vollband-Ruhigboden (p15 ueber innere 80 %) + optional zeitliche Zeilen-Stabilisierung
        if (cfg.wideband || cfg.rowStabilize) {
            var sb = scratch.sortBuf.subarray(0, innerLen);
            sb.set(med65.subarray(i0, i1));
            sb.sort();
            var qIdxG = clamp(Math.floor(innerLen * 0.15), 0, innerLen - 1);
            var curGlobal = sb[qIdxG];
            var targetFloor = curGlobal;

            if (cfg.rowStabilize && floorState) {
                var cfCur = (typeof window.center_freq === "number") ? window.center_freq : 0;
                if (floorState.ema === null || !isFinite(floorState.ema) ||
                    floorState.bw !== bw || floorState.cf !== cfCur || floorState.n !== N ||
                    Math.abs(curGlobal - floorState.ema) > 5.0) {
                    floorState.ema = curGlobal;
                    floorState.bw = bw;
                    floorState.cf = cfCur;
                    floorState.n = N;
                } else {
                    floorState.ema = 0.94 * floorState.ema + 0.06 * curGlobal;
                }
                targetFloor = floorState.ema;
            }

            if (cfg.wideband) {
                for (var wbIdx = 0; wbIdx < M; wbIdx++) {
                    if (wideBase[wbIdx] > targetFloor) wideBase[wbIdx] = targetFloor;
                }
            } else if (cfg.rowStabilize && curGlobal > targetFloor) {
                var rowBurst = Math.min(curGlobal - targetFloor, 10.0);
                for (var rbIdx = 0; rbIdx < M; rbIdx++) {
                    wideBase[rbIdx] -= rowBurst;
                }
            }
        }

        scratch.lastM = M;
        scratch.lastStep = step;

        // 4) Block-Ueberschuss berechnen (bei UKW-FM / DAB+ Block-Subtraktion ueberspringen)
        var strength = cfg.strength / 100.0;
        var dz = cfg.deadzoneDb;
        var maxEx = 0;
        var quietSum = 0;
        for (var b2 = 0; b2 < M; b2++) {
            var ex = skipSub ? 0 : (med65[b2] - wideBase[b2] - dz);
            ex = ex > 0 ? ex * strength : 0;
            exBlock[b2] = ex;
            if (ex > maxEx) maxEx = ex;
            if (b2 >= i0 && b2 < i1) quietSum += wideBase[b2];
        }

        if (updateStats) {
            lastStats.quietDb = quietSum / Math.max(1, innerLen);
            lastStats.maxExDb = maxEx;
            lastStats.active = isEnabled();
        }

        if (skipSub) {
            for (var is0 = 0; is0 < N; is0++) outArr[is0] = data[is0];
            return outArr;
        }

        // 5) Block-Ueberschuss weich auf alle N Bins interpolieren & abziehen
        var halfStep = step * 0.5;
        for (var i = 0; i < N; i++) {
            var pos = (i - halfStep) / step;
            var exVal;
            if (pos <= 0) {
                exVal = exBlock[0];
            } else if (pos >= M - 1) {
                exVal = exBlock[M - 1];
            } else {
                var idx0 = pos | 0;
                var frac = pos - idx0;
                exVal = exBlock[idx0] * (1 - frac) + exBlock[idx0 + 1] * frac;
            }
            outArr[i] = data[i] - exVal;
        }
        return outArr;
    }

    // --------------------------------------------------------- Stufe 2: Schraegstrich-Glaettung
    function ensureDiagState(stObj, N, bw, cfCur) {
        var dfHz = bw / N;
        var st = Math.max(1, Math.round(1600 / dfHz));
        if (Math.floor(N / st) > 1400) st = Math.max(1, Math.floor(N / 1400));
        var B = Math.floor(N / st);
        if (B < 40) return 0;

        if (stObj.n === N && stObj.bw === bw && stObj.cf === cfCur && stObj.B === B && stObj.hist) {
            return B;
        }
        stObj.n = N;
        stObj.bw = bw;
        stObj.cf = cfCur;
        stObj.B = B;
        stObj.step = st;
        stObj.rowIdx = 0;
        var blockHz = st * dfHz;
        stObj.kFl = clamp(Math.round(45000 / blockHz) | 1, 15, 35);
        stObj.kSm = Math.min(5, Math.max(1, st >> 1));
        stObj.minV = Math.max(0.85, 1600.0 / blockHz);
        stObj.maxV = Math.min(80, Math.max(15, Math.round(95000 / blockHz)));
        stObj.mh = Math.max(3, Math.round(18000 / blockHz));

        stObj.hist = [];
        stObj.peaks = [];
        for (var h = 0; h < stObj.H; h++) {
            stObj.hist.push(new Float32Array(B));
            stObj.peaks.push([]);
        }
        stObj.statEma = new Float32Array(B);
        stObj.bMean = new Float32Array(B);
        stObj.bPeak = new Float32Array(B);
        stObj.bFloor = new Float32Array(B);
        stObj.ex = new Float32Array(B);
        stObj.kill = new Uint8Array(B);
        stObj.statMask = new Uint8Array(B);
        stObj.cand = new Int32Array(B);
        if (!stObj.sm || stObj.sm.length !== N) stObj.sm = new Float32Array(N);
        if (!stObj.diagOut || stObj.diagOut.length !== N) stObj.diagOut = new Float32Array(N);
        return B;
    }

    var diagCenterTmp = [];

    function suppressDiagonalRow(row, stObj, strength, updateStats) {
        var N = row.length;
        if (!N || N < 128) return row;
        var bw = (typeof window.bandwidth === "number" && window.bandwidth > 10000) ? window.bandwidth : 2400000;
        var cfCur = (typeof window.center_freq === "number") ? window.center_freq : 0;
        var B = ensureDiagState(stObj, N, bw, cfCur);
        if (!B) return row;

        var st = stObj.step;
        var kSm = stObj.kSm;
        var sm = row;
        if (kSm > 1) {
            sm = stObj.sm;
            var halfSm = kSm >> 1;
            var invSm = 1.0 / kSm;
            var rSum = 0.0;
            for (var s0 = -halfSm; s0 <= halfSm; s0++) {
                var idxS = s0 < 0 ? 0 : (s0 >= N ? N - 1 : s0);
                rSum += row[idxS];
            }
            for (var i = 0; i < N; i++) {
                sm[i] = rSum * invSm;
                var oIdx = i - halfSm;
                var nIdx = i + halfSm + 1;
                rSum -= row[oIdx < 0 ? 0 : oIdx];
                rSum += row[nIdx >= N ? N - 1 : nIdx];
            }
        }

        var bMean = stObj.bMean;
        var bPeak = stObj.bPeak;
        var invSt = 1.0 / st;
        for (var b = 0; b < B; b++) {
            var base = b * st;
            var sumB = 0.0;
            var maxB = -1e9;
            for (var p = 0; p < st; p++) {
                var v = sm[base + p];
                sumB += v;
                if (v > maxB) maxB = v;
            }
            bMean[b] = sumB * invSt;
            bPeak[b] = maxB;
        }

        var bFloor = stObj.bFloor;
        sortedWindowMedian(bMean, B, stObj.kFl, bFloor);

        var ex = stObj.ex;
        var cur = stObj.rowIdx % stObj.H;
        var curHist = stObj.hist[cur];
        var cand = stObj.cand;
        var candLen = 0;
        for (var b1 = 0; b1 < B; b1++) {
            var ev = bPeak[b1] - bFloor[b1];
            if (ev < 0) ev = 0;
            ex[b1] = ev;
            curHist[b1] = ev;
            if (ev > 1.85) cand[candLen++] = b1;
        }

        var pList = stObj.peaks[cur];
        pList.length = 0;
        for (var ci = 0; ci < candLen; ci++) {
            var bc = cand[ci];
            var loP = bc > 2 ? bc - 2 : 0;
            var hiP = bc + 2 < B ? bc + 2 : B - 1;
            var mxP = ex[bc];
            var isPeak = true;
            for (var nb = loP; nb <= hiP; nb++) {
                if (ex[nb] > mxP + 1e-5) { isPeak = false; break; }
            }
            if (isPeak) pList.push(bc);
        }

        var statEma = stObj.statEma;
        var statMask = stObj.statMask;
        for (var si = 0; si < candLen; si++) {
            var bs = cand[si];
            var smHit = 0;
            var lo1 = bs > 0 ? bs - 1 : 0;
            var hi1 = bs + 1 < B ? bs + 1 : B - 1;
            for (var u = lo1; u <= hi1; u++) {
                if (statEma[u] >= 1.00) { smHit = 1; break; }
            }
            if (!smHit && stObj.rowIdx >= 4) {
                var cntOld = 0;
                var thrOld = Math.max(1.75, 0.30 * ex[bs]);
                var maxK = Math.min(7, stObj.rowIdx);
                for (var k = 3; k <= maxK; k++) {
                    var slOld = stObj.hist[(stObj.rowIdx - k) % stObj.H];
                    var mxO = 0;
                    for (var uo = lo1; uo <= hi1; uo++) {
                        if (slOld[uo] > mxO) mxO = slOld[uo];
                    }
                    if (mxO > thrOld) cntOld++;
                }
                if (cntOld >= 2) smHit = 1;
            }
            statMask[bs] = smHit;
        }

        var kill = stObj.kill;
        kill.fill(0);
        diagCenterTmp.length = 0;
        var hasKill = false;

        if (stObj.rowIdx >= 2 && pList.length > 0) {
            var minV = stObj.minV;
            var maxV = stObj.maxV;
            var avail = Math.min(7, stObj.rowIdx);
            for (var pi = 0; pi < pList.length; pi++) {
                var bCand = pList[pi];
                if (statMask[bCand]) continue;
                var matched = false;
                var minTrail = Math.max(1.75, Math.min(3.5, 0.28 * ex[bCand]));
                for (var ka = 1; ka <= 3 && ka <= stObj.rowIdx && !matched; ka++) {
                    var pkAnchor = stObj.peaks[(stObj.rowIdx - ka) % stObj.H];
                    for (var ai = 0; ai < pkAnchor.length; ai++) {
                        var ba = pkAnchor[ai];
                        var v = (bCand - ba) / ka;
                        var av = v < 0 ? -v : v;
                        if (av < minV || av > maxV) continue;

                        var hitsOut = 0;
                        var hk1 = false;
                        var hk2 = false;
                        for (var k2 = 1; k2 <= avail; k2++) {
                            var pred = Math.round(bCand - k2 * v);
                            if (pred < 0 || pred >= B || Math.abs(pred - bCand) <= 1) continue;
                            var tol = (k2 <= 2) ? 1 : (1 + ((k2 / 3) | 0));
                            var loT = pred - tol; if (loT < 0) loT = 0;
                            var hiT = pred + tol + 1; if (hiT > B) hiT = B;
                            if (v > 0 && hiT > bCand - 1) hiT = bCand - 1;
                            if (v < 0 && loT < bCand + 2) loT = bCand + 2;
                            if (loT >= hiT) continue;
                            var slT = stObj.hist[(stObj.rowIdx - k2) % stObj.H];
                            var hitRow = false;
                            for (var tx = loT; tx < hiT; tx++) {
                                if (slT[tx] > minTrail) { hitRow = true; break; }
                            }
                            if (hitRow) {
                                hitsOut++;
                                if (k2 === 1) hk1 = true;
                                else if (k2 === 2) hk2 = true;
                            }
                        }
                        if ((av >= 2.0 && hk1 && hk2) || hitsOut >= 3) {
                            matched = true;
                            diagCenterTmp.push(bCand);
                            break;
                        }
                    }
                }
            }

            if (diagCenterTmp.length > 0) {
                var mh = stObj.mh;
                for (var di = 0; di < diagCenterTmp.length; di++) {
                    var bHit = diagCenterTmp[di];
                    kill[bHit] = 1;
                    hasKill = true;
                    for (var sgn = -1; sgn <= 1; sgn += 2) {
                        for (var db = 1; db <= mh; db++) {
                            var nb2 = bHit + sgn * db;
                            if (nb2 < 0 || nb2 >= B) break;
                            if (ex[nb2] <= 0.60 || (statMask[nb2] && ex[nb2] > 1.50)) break;
                            kill[nb2] = 1;
                        }
                    }
                }
            }
        }

        for (var eIdx = 0; eIdx < B; eIdx++) statEma[eIdx] *= 0.90;
        for (var ui = 0; ui < candLen; ui++) {
            var bu = cand[ui];
            if (!kill[bu]) {
                var nv = statEma[bu] + 0.55;
                statEma[bu] = nv > 3.0 ? 3.0 : nv;
            }
        }

        stObj.rowIdx++;
        if (updateStats) lastStats.diagCount = diagCenterTmp.length;

        if (!hasKill) return row;

        var outArr = stObj.diagOut;
        var halfSt = st * 0.5;
        for (var j = 0; j < N; j++) {
            var posD = (j - halfSt) / st;
            var flBin, kmBin;
            if (posD <= 0) {
                flBin = bFloor[0];
                kmBin = kill[0];
            } else if (posD >= B - 1) {
                flBin = bFloor[B - 1];
                kmBin = kill[B - 1];
            } else {
                var i0D = posD | 0;
                var frD = posD - i0D;
                flBin = bFloor[i0D] * (1 - frD) + bFloor[i0D + 1] * frD;
                kmBin = kill[i0D] * (1 - frD) + kill[i0D + 1] * frD;
            }
            if (kmBin > 0) {
                var msk = kmBin * 1.4;
                if (msk > 1.0) msk = 1.0;
                var dEx = sm[j] - flBin;
                outArr[j] = dEx > 0 ? row[j] - dEx * msk * strength : row[j];
            } else {
                outArr[j] = row[j];
            }
        }
        return outArr;
    }

    // --------------------------------------------------------- Stufe 3: Rauschboden-Beruhigung
    function polishNoiseFloorRow(row, stObj, strength) {
        var N = row.length;
        var M = scratch.lastM;
        var step = scratch.lastStep;
        var wideBase = scratch.wideBase;
        if (!N || N < 128 || !M || M < 40 || !wideBase) return row;

        var bw = (typeof window.bandwidth === "number" && window.bandwidth > 10000) ? window.bandwidth : 2400000;
        var cfCur = (typeof window.center_freq === "number") ? window.center_freq : 0;
        var needInit = (stObj.n !== N || stObj.bw !== bw || stObj.cf !== cfCur || !stObj.ema);
        if (stObj.n !== N || !stObj.ema) {
            stObj.baseArr = new Float32Array(N);
            stObj.clamped = new Float32Array(N);
            stObj.quiet = new Uint8Array(N);
            stObj.ema = new Float32Array(N);
            stObj.prevQuiet = new Uint8Array(N);
            stObj.out = new Float32Array(N);
        }

        var baseArr = stObj.baseArr;
        var clamped = stObj.clamped;
        var quiet = stObj.quiet;
        var ema = stObj.ema;
        var prevQ = stObj.prevQuiet;
        var out = stObj.out;

        var halfStep = step * 0.5;
        for (var i = 0; i < N; i++) {
            var pos = (i - halfStep) / step;
            var bVal;
            if (pos <= 0) bVal = wideBase[0];
            else if (pos >= M - 1) bVal = wideBase[M - 1];
            else {
                var idx0 = pos | 0;
                var frac = pos - idx0;
                bVal = wideBase[idx0] * (1 - frac) + wideBase[idx0 + 1] * frac;
            }
            baseArr[i] = bVal;
            var val = row[i];
            var lo = bVal - 6.0;
            var hi = bVal + 3.5;
            quiet[i] = (val <= hi) ? 1 : 0;
            clamped[i] = (val < lo) ? lo : ((val > hi) ? hi : val);
        }

        var ms = stObj.medSample;
        var iStart = (N * 0.15) | 0;
        var iSpan = Math.max(33, ((N * 0.70) | 0));
        for (var s = 0; s < 33; s++) {
            ms[s] = baseArr[iStart + (((s * iSpan) / 33) | 0)];
        }
        insertionSortSmall(ms, 33);
        var curMed = ms[16];
        var doReset = needInit || !isFinite(stObj.lastMed) || Math.abs(curMed - stObj.lastMed) > 5.0;
        stObj.n = N;
        stObj.bw = bw;
        stObj.cf = cfCur;
        stObj.lastMed = curMed;

        var Nm3 = N - 3;
        for (var x = 0; x < N; x++) {
            var num = 0.0, den = 0.0;
            if (x >= 3 && x < Nm3) {
                if (quiet[x - 3]) { num += 0.08 * clamped[x - 3]; den += 0.08; }
                if (quiet[x - 2]) { num += 0.13 * clamped[x - 2]; den += 0.13; }
                if (quiet[x - 1]) { num += 0.18 * clamped[x - 1]; den += 0.18; }
                if (quiet[x])     { num += 0.22 * clamped[x];     den += 0.22; }
                if (quiet[x + 1]) { num += 0.18 * clamped[x + 1]; den += 0.18; }
                if (quiet[x + 2]) { num += 0.13 * clamped[x + 2]; den += 0.13; }
                if (quiet[x + 3]) { num += 0.08 * clamped[x + 3]; den += 0.08; }
            } else {
                var wArr = [0.08, 0.13, 0.18, 0.22, 0.18, 0.13, 0.08];
                for (var k = 0; k < 7; k++) {
                    var nx = x + k - 3;
                    if (nx < 0) nx = 0;
                    else if (nx >= N) nx = N - 1;
                    if (quiet[nx]) { num += wArr[k] * clamped[nx]; den += wArr[k]; }
                }
            }
            var sp = (den > 0.05) ? (num / den) : baseArr[x];
            if (doReset) {
                ema[x] = sp;
                prevQ[x] = quiet[x];
            } else if (quiet[x]) {
                ema[x] = prevQ[x] ? (0.40 * sp + 0.60 * ema[x]) : sp;
                prevQ[x] = 1;
            } else {
                prevQ[x] = 0;
            }

            var ex = row[x] - baseArr[x];
            if (ex >= 3.8) {
                out[x] = row[x];
            } else if (ex <= 2.2) {
                out[x] = row[x] + strength * (ema[x] - row[x]);
            } else {
                var wB = strength * ((3.8 - ex) / 1.6);
                out[x] = row[x] + wB * (ema[x] - row[x]);
            }
        }
        return out;
    }

    // --------------------------------------------------------- Farben & Neu-Malen
    function buildColorLut(colors) {
        var CL = colors.length;
        var lut = new Uint32Array(CL);
        for (var i = 0; i < CL; i++) {
            var c = colors[i], r = 0, g = 0, b = 0;
            if (typeof c === "number") {
                r = (c >> 16) & 255; g = (c >> 8) & 255; b = c & 255;
            } else if (c && typeof c.length === "number") {
                r = c[0] | 0; g = c[1] | 0; b = c[2] | 0;
            } else if (typeof c === "string") {
                var m = c.match(/\d+/g);
                if (m && m.length >= 3) { r = m[0] | 0; g = m[1] | 0; b = m[2] | 0; }
            }
            lut[i] = 0xFF000000 | (b << 16) | (g << 8) | r;
        }
        return lut;
    }

    function repaintFromBuffers(histObj, applyFilter) {
        var wf = window.Waterfall;
        if (!histObj || !histObj.n || !wf || !wf.colors || wf.colors.length < 2) return 0;
        var lv = wf.levels;
        if (!lv || !isFinite(lv.min) || !isFinite(lv.max) || lv.max <= lv.min) return 0;

        var W = histObj.w;
        var CL = wf.colors.length;
        var lut = buildColorLut(wf.colors);
        var lvMin = lv.min;
        var lvInv = (CL - 1) / (lv.max - lvMin);
        var maxIdx = CL - 1;
        var total = Math.min(histObj.n, histObj.cap);
        var start = histObj.n - total;

        var cur = null, ctx = null, img = null, out = null;
        var rawRow = new Float32Array(W);
        var filtRow = new Float32Array(W);
        var wideBc = isWideBroadcast();
        var repaintFloor = { ema: null, bw: 0, cf: 0, n: 0 };
        var repaintDiag = (applyFilter && cfg.diagonal && !wideBc) ? makeDiagState() : null;
        var repaintPolish = (applyFilter && cfg.floorPolish) ? makePolishState() : null;
        var strengthD = cfg.strength / 100.0;
        var anzahl = 0;

        for (var j = 0; j < total; j++) {
            var k = (start + j) % histObj.cap;
            var z = histObj.ziel[k];
            var dbSrc = histObj.db ? histObj.db[k] : null;
            if (!z || !z.cv || !z.cv.parentNode || !dbSrc || dbSrc.length !== W) continue;
            if (z.cv !== cur) {
                cur = z.cv; ctx = null; img = null; out = null;
                try { ctx = cur.getContext("2d"); } catch (eG) { ctx = null; }
                if (!ctx) continue;
                try { img = ctx.createImageData(W, 1); } catch (eI) { img = null; }
                if (!img || !img.data) continue;
                out = new Uint32Array(img.data.buffer);
            }
            for (var x = 0; x < W; x++) rawRow[x] = dbSrc[x] * 0.05;
            var srcRow = applyFilter ? computeFilteredRow(rawRow, filtRow, j === total - 1, repaintFloor, wideBc) : rawRow;
            if (repaintDiag) {
                srcRow = suppressDiagonalRow(srcRow, repaintDiag, strengthD, j === total - 1);
            }
            if (repaintPolish) {
                srcRow = polishNoiseFloorRow(srcRow, repaintPolish, strengthD);
            }
            for (var xd = 0; xd < W; xd++) {
                var ix = Math.round((srcRow[xd] - lvMin) * lvInv);
                out[xd] = lut[ix < 0 ? 0 : (ix > maxIdx ? maxIdx : ix)];
            }
            ctx.putImageData(img, 0, z.y);
            anzahl++;
        }
        if (applyFilter && repaintFloor.ema !== null) {
            liveFloor.ema = repaintFloor.ema;
            liveFloor.bw = repaintFloor.bw;
            liveFloor.cf = repaintFloor.cf;
            liveFloor.n = repaintFloor.n;
        }
        if (repaintDiag && repaintDiag.hist) {
            liveDiag = repaintDiag;
        } else {
            liveDiag.n = 0;
            liveDiag.rowIdx = 0;
        }
        if (repaintPolish && repaintPolish.ema) {
            livePolish = repaintPolish;
        } else {
            livePolish.n = 0;
        }
        return anzahl;
    }

    function repaintAll() {
        var on = isEnabled();
        var stylerHist = window.__dnxWfHist;
        if (stylerHist && stylerHist.n && stylerHist.db) {
            if (!on && typeof window.__dnxWfgOrigNeuMalen === "function") {
                try { window.__dnxWfgOrigNeuMalen("wfg-off"); } catch (e) { }
            } else {
                repaintFromBuffers(stylerHist, on);
            }
        } else if (FB.n) {
            repaintFromBuffers(FB, on);
        }
        updateStatsDom();
    }

    // --------------------------------------------------------- Haken in OpenWebRX
    function fbRecord(data) {
        try {
            if (window.__dnxWfHist && window.__dnxWfHist.an) return; // Styler merkt schon mit
            var cs = window.canvases;
            if (!data || !data.length || !cs || !cs.length) return;
            var w = data.length;
            if (w !== FB.w) {
                FB.w = w; FB.db = []; FB.ziel = []; FB.n = 0;
            }
            var k = FB.n % FB.cap;
            var dbBuf = FB.db[k];
            if (!dbBuf || dbBuf.length !== w) dbBuf = new Int16Array(w);
            for (var i = 0; i < w; i++) {
                var q = Math.round((isFinite(data[i]) ? data[i] : -150) * 20);
                dbBuf[i] = q < -32768 ? -32768 : (q > 32767 ? 32767 : q);
            }
            var cv = cs[cs.length - 1];
            var y = window.canvas_actual_line;
            FB.db[k] = dbBuf;
            FB.ziel[k] = (cv && cv.width >= w && y >= 0 && y < cv.height) ? { cv: cv, y: y } : null;
            FB.n++;
        } catch (e) { }
    }

    var diagSkip = 0;
    function installHooks() {
        // 1) Waterfall.drawLine fuer jede neue Zeile (nur Wasserfall, niemals Spektrum!)
        var wf = window.Waterfall;
        if (wf && typeof wf.drawLine === "function" && !wf.drawLine.__dnxWfgWrapped) {
            var origDrawLine = wf.drawLine;
            var wrappedDraw = function (out, data, offset) {
                try {
                    if (data && data.length >= 128) {
                        var on = isEnabled();
                        if (on) {
                            if (scratch.n !== data.length) {
                                scratch.n = data.length;
                                scratch.outRow = new Float32Array(data.length);
                            }
                            var wideBc = isWideBroadcast();
                            var filt = computeFilteredRow(data, scratch.outRow, true, liveFloor, wideBc);
                            if (cfg.diagonal && !wideBc) {
                                filt = suppressDiagonalRow(filt, liveDiag, cfg.strength / 100.0, true);
                            }
                            if (cfg.floorPolish) {
                                filt = polishNoiseFloorRow(filt, livePolish, cfg.strength / 100.0);
                            }
                            return origDrawLine.call(this, out, filt, offset);
                        } else if (uiRefs.open && ((diagSkip++ & 7) === 0)) {
                            if (scratch.n !== data.length) {
                                scratch.n = data.length;
                                scratch.outRow = new Float32Array(data.length);
                            }
                            computeFilteredRow(data, scratch.outRow, true, diagFloor, isWideBroadcast());
                            updateStatsDom();
                        }
                    }
                } catch (e) { }
                return origDrawLine.call(this, out, data, offset);
            };
            wrappedDraw.__dnxWfgWrapped = true;
            wf.drawLine = wrappedDraw;
        }

        // 2) Fallback-Recorder in waterfall_add (falls Styler nicht aktiv)
        if (typeof window.waterfall_add === "function" && !window.waterfall_add.__dnxWfgRec) {
            var origAdd = window.waterfall_add;
            var wrappedAdd = function (data) {
                var r = origAdd.apply(this, arguments);
                fbRecord(data);
                return r;
            };
            wrappedAdd.__dnxWfgRec = true;
            if (origAdd.__dnx3d) wrappedAdd.__dnx3d = true;
            window.waterfall_add = wrappedAdd;
        }

        // 3) Styler __dnxWfNeuMalen-Bruecke (fuer Contrast / Palette / Resize)
        if (typeof window.__dnxWfNeuMalen === "function" && !window.__dnxWfNeuMalen.__dnxWfgBridge) {
            var origNeu = window.__dnxWfNeuMalen;
            window.__dnxWfgOrigNeuMalen = origNeu;
            var bridgedNeu = function (grund) {
                if (isEnabled() && window.__dnxWfHist && window.__dnxWfHist.n) {
                    return repaintFromBuffers(window.__dnxWfHist, true);
                }
                return origNeu.apply(this, arguments);
            };
            bridgedNeu.__dnxWfgBridge = true;
            window.__dnxWfNeuMalen = bridgedNeu;
            if (typeof window.dnxWfNeuMalen === "function") {
                window.dnxWfNeuMalen = bridgedNeu;
            }
        }
    }

    // --------------------------------------------------------- UI & Panel
    function buttonLabelText() {
        return "WF-Glättung: " + (isEnabled() ? "An" : "Aus");
    }

    function updateStatsDom() {
        var qEl = document.getElementById("dnx-wfg-stat-quiet");
        var eEl = document.getElementById("dnx-wfg-stat-ex");
        if (qEl) {
            qEl.textContent = (lastStats.quietDb !== null && isFinite(lastStats.quietDb))
                ? lastStats.quietDb.toFixed(1).replace(".", ",") + " dBFS"
                : "–";
        }
        if (eEl) {
            if (lastStats.maxExDb > 0.1) {
                eEl.textContent = "+" + lastStats.maxExDb.toFixed(1).replace(".", ",") + " dB";
                eEl.style.color = isEnabled() ? "#7df0b0" : "#ffc76b";
            } else {
                eEl.textContent = "kein breites QRM";
                eEl.style.color = "#cfe0d7";
            }
        }
    }

    function syncUi() {
        var on = isEnabled();
        var btn = document.getElementById(BTN_ID);
        if (btn) {
            var lbl = btn.querySelector(".dnx-wfg-lbl");
            if (lbl) lbl.textContent = buttonLabelText();
            else btn.textContent = buttonLabelText();
            btn.title = on
                ? "Wasserfall-Glättung AN (Klick = Aus · Zahnrad = Einstellungen)"
                : "Wasserfall-Glättung AUS (Klick = An · Zahnrad = Einstellungen)";
            btn.style.setProperty("background", on ? "#1f8f52" : "#666666", "important");
            btn.style.setProperty("color", on ? "#f2fff8" : "#ffffff", "important");
        }
        var solo = document.getElementById(SOLO_ID);
        if (solo) {
            var slbl = solo.querySelector(".dnx-wfg-lbl");
            if (slbl) slbl.textContent = buttonLabelText();
            if (on) solo.classList.add("an");
            else solo.classList.remove("an");
        }
        var tBtn = document.getElementById("dnx-wfg-panel-toggle");
        if (tBtn) {
            tBtn.textContent = on ? "Eingeschaltet (QRM-Teppich geglättet)" : "Ausgeschaltet (Original-Wasserfall)";
            if (on) tBtn.classList.add("an");
            else tBtn.classList.remove("an");
        }
        var rngS = document.getElementById("dnx-wfg-strength");
        var valS = document.getElementById("dnx-wfg-strength-val");
        if (rngS) rngS.value = String(cfg.strength);
        if (valS) valS.textContent = cfg.strength + " %";

        var rngW = document.getElementById("dnx-wfg-width");
        var valW = document.getElementById("dnx-wfg-width-val");
        if (rngW) rngW.value = String(cfg.widthKhz);
        if (valW) valW.textContent = cfg.widthKhz + " kHz";

        var chkWb = document.getElementById("dnx-wfg-wideband");
        if (chkWb) chkWb.checked = !!cfg.wideband;

        var chkRs = document.getElementById("dnx-wfg-rowstab");
        if (chkRs) chkRs.checked = !!cfg.rowStabilize;

        var chkDg = document.getElementById("dnx-wfg-diagonal");
        if (chkDg) chkDg.checked = !!cfg.diagonal;

        var chkPol = document.getElementById("dnx-wfg-polish");
        if (chkPol) chkPol.checked = !!cfg.floorPolish;

        var chkP = document.getElementById("dnx-wfg-perprof");
        if (chkP) chkP.checked = !!cfg.perProfile;

        var stCb = document.getElementById("dnx-tool-wfglaettung");
        if (stCb) stCb.checked = !!on;

        updateStatsDom();
    }

    function buildPanel() {
        var existing = document.getElementById(PANEL_ID);
        if (existing) return existing;

        var p = document.createElement("div");
        p.id = PANEL_ID;
        p.innerHTML = [
            '<div class="dnx-wfg-hd" id="dnx-wfg-drag">',
            '  <span class="dnx-wfg-hd-title">Wasserfall-Glättung <span class="dnx-wfg-ver">v' + VERSION + '</span></span>',
            '  <button type="button" class="dnx-wfg-close" id="dnx-wfg-close" title="Schließen">×</button>',
            '</div>',
            '<div class="dnx-wfg-bd">',
            '  <button type="button" class="dnx-wfg-toggle-btn" id="dnx-wfg-panel-toggle"></button>',
            '  <div class="dnx-wfg-stats">',
            '    <div><span class="dnx-wfg-stat-k">Ruhigpegel</span><span class="dnx-wfg-stat-v" id="dnx-wfg-stat-quiet">–</span></div>',
            '    <div><span class="dnx-wfg-stat-k">Erkannter Störbuckel</span><span class="dnx-wfg-stat-v" id="dnx-wfg-stat-ex">–</span></div>',
            '  </div>',
            '  <div class="dnx-wfg-row">',
            '    <div class="dnx-wfg-row-top"><span>Glättungs-Stärke</span><span class="dnx-wfg-row-val" id="dnx-wfg-strength-val">100 %</span></div>',
            '    <input type="range" class="dnx-wfg-panel-rng" id="dnx-wfg-strength" min="20" max="100" step="5" value="100">',
            '  </div>',
            '  <div class="dnx-wfg-row">',
            '    <div class="dnx-wfg-row-top"><span>Erkennungsbreite (Median)</span><span class="dnx-wfg-row-val" id="dnx-wfg-width-val">65 kHz</span></div>',
            '    <input type="range" class="dnx-wfg-panel-rng" id="dnx-wfg-width" min="20" max="150" step="5" value="65">',
            '  </div>',
            '  <div class="dnx-wfg-chk-grp">',
            '    <label class="dnx-wfg-chk"><input type="checkbox" id="dnx-wfg-wideband"><span>Vollband-Basislinie (&gt;550 kHz Wolken)</span></label>',
            '    <label class="dnx-wfg-chk"><input type="checkbox" id="dnx-wfg-rowstab"><span>Zeilenblitz-Beruhigung (quer)</span></label>',
            '    <label class="dnx-wfg-chk"><input type="checkbox" id="dnx-wfg-diagonal"><span>Schrägstrich-Glättung (Wanderstörer)</span></label>',
            '    <label class="dnx-wfg-chk"><input type="checkbox" id="dnx-wfg-polish"><span>Rauschboden-Beruhigung (gegen Grieseln)</span></label>',
            '    <label class="dnx-wfg-chk"><input type="checkbox" id="dnx-wfg-perprof"><span>Ein/Aus je Profil getrennt merken</span></label>',
            '  </div>',
            '  <div class="dnx-wfg-foot">',
            '    <button type="button" class="dnx-wfg-rst" id="dnx-wfg-reset">Standardwerte</button>',
            '    <span style="font-size:10px;color:#8aa195">Nur Wasserfall</span>',
            '  </div>',
            '  <div class="dnx-wfg-hint">Wirkt ausschließlich auf den Wasserfall. Glättet breite QRM-Teppiche, Zeilenblitze und schräge Wanderstörer; schmale Nutzsignale (CW, SSB, CB) bleiben frei. Kleinere Medianbreite (20–35 kHz) erfasst auch breitere Dauerträger. UKW-FM/DAB+ werden automatisch geschützt.</div>',
            '</div>'
        ].join("");
        document.body.appendChild(p);

        document.getElementById("dnx-wfg-close").addEventListener("click", function () {
            togglePanel(false);
        });
        document.getElementById("dnx-wfg-panel-toggle").addEventListener("click", function () {
            setEnabled(!isEnabled());
        });

        var repaintTimer = null;
        function scheduleRepaint() {
            if (repaintTimer) clearTimeout(repaintTimer);
            repaintTimer = setTimeout(function () { repaintAll(); }, 55);
        }

        document.getElementById("dnx-wfg-strength").addEventListener("input", function (ev) {
            cfg.strength = clamp(parseInt(ev.target.value, 10) || 100, 20, 100);
            saveCfg();
            syncUi();
            if (isEnabled()) scheduleRepaint();
        });
        document.getElementById("dnx-wfg-width").addEventListener("input", function (ev) {
            cfg.widthKhz = clamp(parseInt(ev.target.value, 10) || 65, 20, 150);
            saveCfg();
            syncUi();
            if (isEnabled()) scheduleRepaint();
        });
        document.getElementById("dnx-wfg-wideband").addEventListener("change", function (ev) {
            cfg.wideband = !!ev.target.checked;
            saveCfg();
            syncUi();
            if (isEnabled()) scheduleRepaint();
        });
        document.getElementById("dnx-wfg-rowstab").addEventListener("change", function (ev) {
            cfg.rowStabilize = !!ev.target.checked;
            liveFloor.ema = null;
            diagFloor.ema = null;
            saveCfg();
            syncUi();
            if (isEnabled()) scheduleRepaint();
        });
        document.getElementById("dnx-wfg-diagonal").addEventListener("change", function (ev) {
            cfg.diagonal = !!ev.target.checked;
            liveDiag.n = 0;
            liveDiag.rowIdx = 0;
            diagDiag.n = 0;
            diagDiag.rowIdx = 0;
            saveCfg();
            syncUi();
            if (isEnabled()) scheduleRepaint();
        });
        document.getElementById("dnx-wfg-polish").addEventListener("change", function (ev) {
            cfg.floorPolish = !!ev.target.checked;
            livePolish.n = 0;
            diagPolish.n = 0;
            saveCfg();
            syncUi();
            if (isEnabled()) scheduleRepaint();
        });
        document.getElementById("dnx-wfg-perprof").addEventListener("change", function (ev) {
            var want = !!ev.target.checked;
            var curState = isEnabled();
            cfg.perProfile = want;
            if (want) {
                var pid = activeProfileId();
                if (pid) cfg.profileMap[pid] = curState;
            }
            saveCfg();
            syncUi();
            repaintAll();
        });
        document.getElementById("dnx-wfg-reset").addEventListener("click", function () {
            cfg.enabled = false;
            cfg.strength = DEFAULTS.strength;
            cfg.widthKhz = DEFAULTS.widthKhz;
            cfg.wideband = DEFAULTS.wideband;
            cfg.rowStabilize = DEFAULTS.rowStabilize;
            cfg.diagonal = DEFAULTS.diagonal;
            cfg.floorPolish = DEFAULTS.floorPolish;
            cfg.perProfile = false;
            cfg.profileMap = {};
            liveFloor.ema = null;
            diagFloor.ema = null;
            liveDiag.n = 0;
            liveDiag.rowIdx = 0;
            diagDiag.n = 0;
            diagDiag.rowIdx = 0;
            livePolish.n = 0;
            diagPolish.n = 0;
            saveCfg();
            syncUi();
            repaintAll();
        });

        // Ziehbares Fenster
        var hd = document.getElementById("dnx-wfg-drag");
        var drag = null;
        hd.addEventListener("mousedown", function (ev) {
            if (ev.target && ev.target.id === "dnx-wfg-close") return;
            var r = p.getBoundingClientRect();
            drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
            ev.preventDefault();
        });
        window.addEventListener("mousemove", function (ev) {
            if (!drag) return;
            var nx = clamp(ev.clientX - drag.dx, 6, window.innerWidth - p.offsetWidth - 6);
            var ny = clamp(ev.clientY - drag.dy, 6, window.innerHeight - p.offsetHeight - 6);
            p.style.left = nx + "px";
            p.style.top = ny + "px";
            p.style.right = "auto";
        });
        window.addEventListener("mouseup", function () { drag = null; });

        uiRefs.panel = p;
        syncUi();
        return p;
    }

    function togglePanel(force) {
        var p = buildPanel();
        var next = (typeof force === "boolean") ? force : !uiRefs.open;
        uiRefs.open = next;
        if (next) {
            p.classList.add("open");
            if (p.style.left) {
                var r = p.getBoundingClientRect();
                if (r.right > window.innerWidth - 6 || r.left < 6) {
                    p.style.left = "";
                    p.style.right = "18px";
                }
            }
        } else {
            p.classList.remove("open");
        }
        syncUi();
    }

    function wireButtonBehavior(btn) {
        btn.addEventListener("click", function (ev) {
            if (ev.target && ev.target.classList && ev.target.classList.contains("dnx-wfg-gear")) {
                ev.preventDefault();
                ev.stopPropagation();
                togglePanel();
                return;
            }
            ev.preventDefault();
            ev.stopPropagation();
            var next = !isEnabled();
            setEnabled(next);
            togglePanel(next);
        });
        btn.addEventListener("contextmenu", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            togglePanel();
        });
    }

    function ensureButton() {
        var row = document.getElementById(ROW_ID);
        if (row) {
            var solo = document.getElementById(SOLO_ID);
            if (solo && solo.parentNode) solo.parentNode.removeChild(solo);

            var btn = document.getElementById(BTN_ID);
            if (!btn) {
                btn = document.createElement("button");
                btn.type = "button";
                btn.id = BTN_ID;
                btn.innerHTML = '<span class="dnx-wfg-lbl"></span><span class="dnx-wfg-gear" title="Einstellungen öffnen"></span>';
                wireButtonBehavior(btn);
                row.appendChild(btn);
                syncUi();
            }
            return true;
        }
        return false;
    }

    var bootTime = Date.now();
    function ensureStandaloneFallback() {
        if (document.getElementById(ROW_ID)) return;
        if (Date.now() - bootTime < 3500) return;
        if (document.getElementById(SOLO_ID)) return;
        var solo = document.createElement("button");
        solo.type = "button";
        solo.id = SOLO_ID;
        solo.innerHTML = '<span class="dnx-wfg-lbl"></span><span class="dnx-wfg-gear" title="Einstellungen öffnen"></span>';
        wireButtonBehavior(solo);
        document.body.appendChild(solo);
        syncUi();
    }

    // Profilwechsel-Ueberwachung (falls "je Profil merken" aktiv)
    var lastProf = "";
    function watchProfile() {
        var p = activeProfileId();
        if (p && p !== lastProf) {
            lastProf = p;
            liveFloor.ema = null;
            diagFloor.ema = null;
            liveDiag.rowIdx = 0;
            diagDiag.rowIdx = 0;
            livePolish.n = 0;
            diagPolish.n = 0;
            if (cfg.perProfile) {
                syncUi();
                setTimeout(repaintAll, 450);
            }
        }
    }

    // --------------------------------------------------------- Start & Takt
    ensureCss();
    installHooks();
    if (!ensureButton()) {
        // frueh nochmal probieren
    }

    var lastRenderSig = "";
    function currentRenderSig() {
        try {
            var wf = window.Waterfall;
            if (!wf || !wf.colors || !wf.levels) return "";
            var mid = wf.colors[wf.colors.length >> 1];
            return String(mid) + "|" + wf.levels.min + "|" + wf.levels.max + "|" + (window.__dnxWfNeuGrund || "") + "|" + (window.__dnxWfNeuBei || 0);
        } catch (e) { return ""; }
    }

    setInterval(function () {
        installHooks();
        if (!ensureButton()) {
            ensureStandaloneFallback();
        }
        watchProfile();
        if (isEnabled()) {
            var sig = currentRenderSig();
            if (sig && sig !== lastRenderSig) {
                lastRenderSig = sig;
                repaintAll();
            }
        } else {
            lastRenderSig = currentRenderSig();
        }
    }, 350);

    // Oeffentliche API fuer Inspektion & Diagnose
    function publicTogglePanel(force) {
        if (force === true) {
            var ev = null;
            try { ev = window.event; } catch (e) {}
            if (!ev || !ev.isTrusted) return;
        }
        return togglePanel(force);
    }

    window.dnxWfGlaettung = {
        version: VERSION,
        isEnabled: isEnabled,
        setEnabled: setEnabled,
        togglePanel: publicTogglePanel,
        isPanelOpen: function () { return !!uiRefs.open; },
        repaint: repaintAll,
        getStats: function () { return Object.assign({}, lastStats); },
        getConfig: function () { return Object.assign({}, cfg); }
    };
})();
