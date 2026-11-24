/* Beispiel zum manuellen Einbinden in plugins/receiver/init.js */
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
