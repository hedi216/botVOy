// Phase 5 (Lot 2, section 7): page HTML/CSS/JS embarquee dans le build (une
// seule chaine, aucune ressource externe, aucun CDN, aucune police/script
// tiers). N'affiche jamais token/blob DPAPI/profilePath/debugPort/cookies/
// mots de passe/URL complete/stack trace: uniquement les champs deja publics
// de AgentLocalUiStatusPayload.
export const LOCAL_UI_PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>RendezBot Agent</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  .state { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 0.4rem; font-weight: 600; }
  .state-NOT_PAIRED, .state-REVOKED { background: #fde2e2; color: #8a1f1f; }
  .state-CONNECTING, .state-SYNCING { background: #fff3cd; color: #7a5b00; }
  .state-CONNECTED { background: #d9f2d9; color: #1f6b1f; }
  .state-OFFLINE { background: #eee; color: #555; }
  .state-VERSION_INCOMPATIBLE { background: #ffe1c2; color: #8a4a00; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  td { padding: 0.25rem 0; vertical-align: top; }
  td:first-child { color: #555; width: 40%; }
  input[type="text"] { width: 100%; padding: 0.4rem; box-sizing: border-box; }
  button { padding: 0.5rem 0.8rem; margin: 0.25rem 0.25rem 0.25rem 0; cursor: pointer; }
  #message { color: #8a1f1f; min-height: 1.2rem; }
  #pairForm { display: none; }
  ul { padding-left: 1.2rem; }
</style>
</head>
<body>
<h1>RendezBot Agent</h1>
<p><span id="state" class="state">...</span></p>
<table>
  <tr><td>Ordinateur</td><td id="computerName">-</td></tr>
  <tr><td>Version agent</td><td id="agentVersion">-</td></tr>
  <tr><td>Version protocole</td><td id="protocolVersion">-</td></tr>
  <tr><td>Serveur</td><td id="serverHost">-</td></tr>
  <tr><td>Bots actifs</td><td id="activeBotCount">-</td></tr>
</table>

<div id="pairForm">
  <label for="pairingCode">Code d'appairage</label>
  <input type="text" id="pairingCode" maxlength="64" autocomplete="off">
  <button id="pairButton">Appairer</button>
</div>

<div id="message"></div>

<p>
  <button id="retryButton">Reessayer</button>
  <button id="openLogsButton">Ouvrir les logs</button>
  <button id="openConfigButton">Ouvrir le dossier de configuration</button>
  <button id="quitButton">Quitter l'agent</button>
</p>
<p id="unpairSection" style="display:none">
  <button id="unpairButton">Dissocier cet ordinateur</button>
</p>

<div id="extensions"></div>

<script>
(function () {
  var nonce = null;
  var STATE_LABELS = {
    NOT_PAIRED: "Non appaire",
    CONNECTING: "Connexion...",
    CONNECTED: "Connecte",
    SYNCING: "Synchronisation...",
    OFFLINE: "Hors ligne",
    REVOKED: "Revoque",
    VERSION_INCOMPATIBLE: "Version incompatible"
  };

  function setMessage(text) {
    document.getElementById("message").textContent = text || "";
  }

  function post(path, extra) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ nonce: nonce }, extra || {}))
    }).then(function (res) { return res.json(); });
  }

  function refresh() {
    fetch("/local/status").then(function (res) { return res.json(); }).then(function (data) {
      nonce = data.nonce;
      var stateEl = document.getElementById("state");
      stateEl.textContent = STATE_LABELS[data.state] || data.state;
      stateEl.className = "state state-" + data.state;
      document.getElementById("computerName").textContent = data.computerName;
      document.getElementById("agentVersion").textContent = data.agentVersion;
      document.getElementById("protocolVersion").textContent = data.protocolVersion;
      document.getElementById("serverHost").textContent = data.serverHost;
      document.getElementById("activeBotCount").textContent = data.activeBotCount;
      document.getElementById("pairForm").style.display = data.paired ? "none" : "block";
      document.getElementById("unpairSection").style.display = data.paired ? "block" : "none";
      if (data.message) { setMessage(data.message); }

      var extDiv = document.getElementById("extensions");
      if (data.extensions && data.extensions.length > 0) {
        var html = "<p>Extensions:</p><ul>";
        data.extensions.forEach(function (ext) {
          html += "<li>" + ext.id + ": " + (ext.valid ? "OK" : "non valide") + (ext.version ? " (v" + ext.version + ")" : "") + "</li>";
        });
        extDiv.innerHTML = html + "</ul>";
      } else {
        extDiv.innerHTML = "";
      }
    }).catch(function () { /* prochaine tentative dans 2s */ });
  }

  document.getElementById("pairButton").addEventListener("click", function () {
    var code = document.getElementById("pairingCode").value.trim();
    if (!code) { setMessage("Saisissez un code d'appairage."); return; }
    setMessage("Appairage en cours...");
    post("/local/pair", { code: code }).then(function (result) {
      setMessage(result.ok ? "Appairage reussi." : (result.error || "Echec de l'appairage."));
      document.getElementById("pairingCode").value = "";
      refresh();
    });
  });

  document.getElementById("retryButton").addEventListener("click", function () {
    post("/local/retry").then(function () { setMessage("Nouvelle tentative demandee."); refresh(); });
  });
  document.getElementById("openLogsButton").addEventListener("click", function () {
    post("/local/open-logs");
  });
  document.getElementById("openConfigButton").addEventListener("click", function () {
    post("/local/open-config");
  });
  document.getElementById("quitButton").addEventListener("click", function () {
    if (confirm("Quitter RendezBot Agent ?")) { post("/local/quit"); setMessage("Arret en cours..."); }
  });
  document.getElementById("unpairButton").addEventListener("click", function () {
    if (confirm("Dissocier cet ordinateur ? Les bots en cours seront arretes. Logs, profils et extensions sont conserves.")) {
      post("/local/unpair").then(function () { setMessage("Ordinateur dissocie."); refresh(); });
    }
  });

  refresh();
  setInterval(refresh, 2000);
})();
</script>
</body>
</html>
`;
