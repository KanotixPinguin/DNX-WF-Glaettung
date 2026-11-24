#!/usr/bin/env bash
set -euo pipefail

# Universal-Installer fuer DNX Wasserfall-Glaettung v1.3.1
# Unterstuetzt Docker-Container (CONTAINER=owrx-8011) und native OpenWebRX-Installationen (TYP=normal PLUGINS=/pfad).
# Aufruf:
#   sudo bash install.sh [install|update|status|uninstall]

ACTION="${1:-install}"
PLUGIN_NAME="dnx_wf_glaettung"
TYP="${TYP:-auto}"
CONTAINER="${CONTAINER:-}"
PLUGINS="${PLUGINS:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

detect_target() {
  if [ "$TYP" = "normal" ]; then
    [ -n "$PLUGINS" ] || { echo "Fehler: PLUGINS=/pfad/zu/plugins/receiver angeben." >&2; exit 1; }
    return
  fi
  if [ -z "$PLUGINS" ]; then
    for cand in /opt/owrx-docker/plugins/receiver /var/lib/openwebrx/plugins/receiver /usr/lib/python3/dist-packages/htdocs/plugins/receiver; do
      if [ -d "$cand" ]; then
        PLUGINS="$cand"
        break
      fi
    done
  fi
  if [ -z "$CONTAINER" ] && command -v docker >/dev/null 2>&1; then
    CONTAINER="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'owrx|openwebrx' | head -n1 || true)"
  fi
  if [ -z "$PLUGINS" ] && [ -n "$CONTAINER" ]; then
    PLUGINS="/opt/owrx-docker/plugins/receiver"
  fi
  [ -n "$PLUGINS" ] || { echo "Fehler: Plugin-Verzeichnis nicht gefunden. Bitte PLUGINS=... angeben." >&2; exit 1; }
}

patch_init_js() {
  local init_file="$PLUGINS/init.js"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  if [ ! -f "$init_file" ]; then
    echo "/* OpenWebRX Receiver Plugins */" > "$init_file"
  fi
  cp -a "$init_file" "${init_file}.bak-wfglaettung-${stamp}"
  python3 - "$init_file" << 'PY'
import sys, re
p = sys.argv[1]
txt = open(p, encoding="utf-8", errors="ignore").read()
block = """/* DNX_WF_GLAETTUNG_START */
(function(){
  try{
    var alt = document.getElementById("dnx-wf-glaettung-script");
    if(alt && alt.parentNode){ alt.parentNode.removeChild(alt); }
    var s = document.createElement("script");
    s.id = "dnx-wf-glaettung-script";
    s.async = false;
    s.src = "static/plugins/receiver/dnx_wf_glaettung/dnx_wf_glaettung.js?v=" + Date.now();
    (document.head || document.documentElement).appendChild(s);
  }catch(e){}
})();
/* DNX_WF_GLAETTUNG_END */"""
pat = re.compile(r"/\*\s*DNX_WF_GLAETTUNG_START\s*\*/.*?/\*\s*DNX_WF_GLAETTUNG_END\s*\*/", re.S)
if pat.search(txt):
    txt = pat.sub(block, txt, count=1)
else:
    if not txt.endswith("\n"): txt += "\n"
    txt += block + "\n"
open(p, "w", encoding="utf-8").write(txt)
PY
  chmod 0644 "$init_file"
}

unpatch_init_js() {
  local init_file="$PLUGINS/init.js"
  [ -f "$init_file" ] || return 0
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  cp -a "$init_file" "${init_file}.bak-wfglaettung-rm-${stamp}"
  python3 - "$init_file" << 'PY'
import sys, re
p = sys.argv[1]
txt = open(p, encoding="utf-8", errors="ignore").read()
txt = re.sub(r"\n?/\*\s*DNX_WF_GLAETTUNG_START\s*\*/.*?/\*\s*DNX_WF_GLAETTUNG_END\s*\*/\n?", "\n", txt, flags=re.S)
open(p, "w", encoding="utf-8").write(txt)
PY
}

detect_target
DEST="$PLUGINS/$PLUGIN_NAME"

case "$ACTION" in
  install|update)
    mkdir -p "$DEST"
    install -m 0644 "$HERE/files/dnx_wf_glaettung.js" "$DEST/dnx_wf_glaettung.js"
    install -m 0644 "$HERE/files/dnx_wf_glaettung.css" "$DEST/dnx_wf_glaettung.css"
    patch_init_js
    echo "[OK] $PLUGIN_NAME installiert unter: $DEST"
    echo "[OK] init.js aktualisiert: $PLUGINS/init.js"
    ;;
  status)
    echo "PLUGINS=$PLUGINS"
    ls -la "$DEST" 2>/dev/null || echo "Nicht installiert"
    grep -n "DNX_WF_GLAETTUNG" "$PLUGINS/init.js" 2>/dev/null || echo "Nicht in init.js eingetragen"
    ;;
  uninstall)
    unpatch_init_js
    rm -rf "$DEST"
    echo "[OK] $PLUGIN_NAME entfernt."
    ;;
  *)
    echo "Verwendung: $0 {install|update|status|uninstall}" >&2
    exit 1
    ;;
esac
