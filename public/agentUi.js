// Rendu et navigation pour les ecrans RendezBot Agent (detection, /agent/setup,
// page "Agent local", bandeau persistant, indicateurs, modale de blocage).
// Chargé apres app.js et agentContext.js: consomme window.RendezBotApp (DOM,
// requetes, showPage...) et window.AgentContext (store d'etat des agents).
(() => {
  const APP = window.RendezBotApp;
  const CTX = window.AgentContext;
  const SKIP_KEY = "rendezbot.agentDetectionSkipped";

  let clientConfig = null;
  let subscribed = false;
  // Reinitialise a chaque changement de page (pas persiste): "fermer" le
  // bandeau ne vaut que pour la vue courante, il doit reapparaitre a la
  // prochaine navigation ou au rechargement tant que l'agent est absent.
  let bannerDismissedForView = false;

  const agentEls = {
    setupBadge: document.getElementById("agentSetupBadge"),
    setupMessage: document.getElementById("agentSetupMessage"),
    setupPairingBox: document.getElementById("agentSetupPairingBox"),
    setupPairingCode: document.getElementById("agentSetupPairingCode"),
    setupPairingExpiry: document.getElementById("agentSetupPairingExpiry"),
    setupCopyCode: document.getElementById("agentSetupCopyCode"),
    setupDownload: document.getElementById("agentSetupDownload"),
    setupDownloadNotice: document.getElementById("agentSetupDownloadNotice"),
    setupRedetect: document.getElementById("agentSetupRedetect"),
    setupGenerateCode: document.getElementById("agentSetupGenerateCode"),
    setupGoDashboard: document.getElementById("agentSetupGoDashboard"),
    setupSkip: document.getElementById("agentSetupSkip"),

    agentTableBody: document.getElementById("agentTableBody"),
    agentPageRedetect: document.getElementById("agentPageRedetect"),
    agentPageGenerateCode: document.getElementById("agentPageGenerateCode"),
    agentPageDownload: document.getElementById("agentPageDownload"),
    agentPagePairingBox: document.getElementById("agentPagePairingBox"),
    agentPagePairingCode: document.getElementById("agentPagePairingCode"),
    agentPagePairingExpiry: document.getElementById("agentPagePairingExpiry"),
    agentPageCopyCode: document.getElementById("agentPageCopyCode"),
    agentPageAgencyLabel: document.getElementById("agentPageAgencyLabel"),
    agentPageAgencySelect: document.getElementById("agentPageAgencySelect"),

    banner: document.getElementById("agentBanner"),
    bannerMessage: document.getElementById("agentBannerMessage"),
    bannerConfigure: document.getElementById("agentBannerConfigure"),
    bannerRedetect: document.getElementById("agentBannerRedetect"),
    bannerDismiss: document.getElementById("agentBannerDismiss"),

    indicatorDashboard: document.getElementById("agentIndicatorDashboard"),
    indicatorDashboardBadge: document.getElementById("agentIndicatorDashboardBadge"),
    indicatorDashboardText: document.getElementById("agentIndicatorDashboardText"),
    indicatorBot: document.getElementById("agentIndicatorBot"),
    indicatorBotBadge: document.getElementById("agentIndicatorBotBadge"),
    indicatorBotText: document.getElementById("agentIndicatorBotText"),

    modal: document.getElementById("agentModal"),
    modalMessage: document.getElementById("agentModalMessage"),
    modalConfigure: document.getElementById("agentModalConfigure"),
    modalRedetect: document.getElementById("agentModalRedetect"),
    modalCancel: document.getElementById("agentModalCancel"),

    commandsPanel: document.getElementById("agentCommandsPanel"),
    commandsTableBody: document.getElementById("agentCommandsTableBody"),

    selectionModal: document.getElementById("agentSelectionModal"),
    selectionList: document.getElementById("agentSelectionList"),
    selectionCancel: document.getElementById("agentSelectionCancel"),

    navAgent: document.querySelector(".agent-nav")
  };

  const BADGE_LABEL = {
    CHECKING: "Verification",
    NEVER_PAIRED: "Non associe",
    OFFLINE: "Hors ligne",
    VERSION_INCOMPATIBLE: "Version incompatible",
    CONNECTED: "Connecte",
    ERROR: "Erreur",
    REVOKED: "Revoque"
  };

  const BADGE_CLASS = {
    CHECKING: "grey",
    NEVER_PAIRED: "amber",
    OFFLINE: "red",
    VERSION_INCOMPATIBLE: "amber",
    CONNECTED: "green",
    ERROR: "red",
    REVOKED: "amber"
  };

  const SETUP_MESSAGES = {
    CHECKING: "Detection de RendezBot Agent en cours...",
    NEVER_PAIRED: "Aucun ordinateur n'est encore associe a cette agence.",
    OFFLINE: "RendezBot Agent semble deja associe, mais il n'est actuellement pas connecte.",
    VERSION_INCOMPATIBLE: "La version installee de RendezBot Agent doit etre mise a jour.",
    CONNECTED: "RendezBot Agent est connecte et pret.",
    ERROR: "Impossible de verifier l'etat de RendezBot Agent.",
    REVOKED: "Aucun ordinateur n'est encore associe a cette agence."
  };

  const MODAL_MESSAGES = {
    CHECKING: "Detection de RendezBot Agent en cours...",
    NEVER_PAIRED: "Aucun agent local n'est associe a cette agence. Installez et associez RendezBot Agent sur l'ordinateur qui doit executer le navigateur.",
    OFFLINE: "RendezBot Agent semble deja installe, mais il n'est actuellement pas connecte. Verifiez qu'il est lance et que l'ordinateur dispose d'une connexion Internet.",
    VERSION_INCOMPATIBLE: "RendezBot Agent doit etre mis a jour avant de pouvoir lancer un bot.",
    ERROR: "Impossible de verifier l'etat de RendezBot Agent.",
    REVOKED: "Aucun agent local n'est associe a cette agence. Installez et associez RendezBot Agent sur l'ordinateur qui doit executer le navigateur."
  };

  const BANNER_MESSAGE = "RendezBot Agent n'est pas connecte. Vous pouvez consulter l'application, mais les bots ne peuvent pas etre lances sur cet ordinateur.";

  const isManager = () => [0, 1].includes(APP.state.user?.role);
  const isDetectionSkipped = () => window.sessionStorage.getItem(SKIP_KEY) === "true";
  const setDetectionSkipped = () => window.sessionStorage.setItem(SKIP_KEY, "true");

  const fetchClientConfig = async () => {
    clientConfig = await APP.requestJson("/api/client-config");
    return clientConfig;
  };

  // ---- Routage: /agent et /agent/setup sont les deux seules pages a avoir une
  // vraie URL navigable. Le reste de l'application (dashboard, bot, logs...)
  // continue de fonctionner exactement comme avant, sans URL dediee. ----

  const PATH_TO_PAGE = { "/agent": "agent", "/agent/setup": "agent-setup" };
  const PAGE_TO_PATH = { agent: "/agent", "agent-setup": "/agent/setup" };

  const syncUrlForPage = (page, replace) => {
    const targetPath = PAGE_TO_PATH[page] || "/";
    if (window.location.pathname === targetPath) {
      return;
    }
    window.history[replace ? "replaceState" : "pushState"](null, "", targetPath);
  };

  window.addEventListener("popstate", () => {
    if (!clientConfig || !clientConfig.agentUiEnabled) {
      return;
    }
    const page = PATH_TO_PAGE[window.location.pathname] || "dashboard";
    void APP.showPage(page);
  });

  const routeAfterAuth = async () => {
    try {
      await fetchClientConfig();
    } catch {
      clientConfig = { agentUiEnabled: false, agentDownloadUrl: "", botExecutionMode: "legacy_vm" };
    }

    if (agentEls.navAgent) {
      agentEls.navAgent.hidden = !clientConfig.agentUiEnabled;
    }

    if (!clientConfig.agentUiEnabled) {
      await APP.showPage("dashboard");
      return;
    }

    if (!subscribed) {
      subscribed = true;
      CTX.subscribe(onAgentStateChange);
    }
    CTX.init(APP.socket);

    const initialPath = window.location.pathname;
    if (initialPath === "/agent") {
      await APP.showPage("agent");
      return;
    }
    if (initialPath === "/agent/setup") {
      await APP.showPage("agent-setup");
      return;
    }

    // Un administrateur global n'a pas d'agence propre: rien a detecter
    // automatiquement pour lui. Il choisit une agence explicitement sur la
    // page "Agent local" (regle backend existante, cf. resolveViewAgencyId).
    if (APP.state.user.role === 0) {
      await APP.showPage("dashboard");
      return;
    }

    if (isDetectionSkipped()) {
      await APP.showPage("dashboard");
      return;
    }

    await APP.showPage("agent-setup");
    syncUrlForPage("agent-setup", true);
    await CTX.whenFirstLoadSettles();
    if (CTX.getState().globalStatus === CTX.STATUS.CONNECTED) {
      await APP.showPage("dashboard");
    }
  };

  const onShowPage = async (page) => {
    bannerDismissedForView = false;
    renderBanner();

    if (page === "agent" || page === "agent-setup") {
      syncUrlForPage(page, false);
    } else if (["/agent", "/agent/setup"].includes(window.location.pathname)) {
      syncUrlForPage("dashboard", false);
    }

    if (page === "agent-setup") {
      renderSetupPage();
    }
    if (page === "agent") {
      await renderAgentLocalPage();
    }
    if (page === "bot") {
      await refreshAgentCommandsFromServer();
      renderAgentCommandsPanel();
    }
  };

  // ---- Page /agent/setup ----

  const renderSetupPage = () => {
    const { globalStatus } = CTX.getState();
    agentEls.setupBadge.textContent = BADGE_LABEL[globalStatus] || globalStatus;
    agentEls.setupBadge.className = `pill ${BADGE_CLASS[globalStatus] || "grey"}`;
    agentEls.setupMessage.textContent = SETUP_MESSAGES[globalStatus] || "";

    agentEls.setupGoDashboard.hidden = globalStatus !== CTX.STATUS.CONNECTED;
    agentEls.setupGenerateCode.hidden = !isManager();

    const downloadAvailable = Boolean(clientConfig?.agentDownloadUrl);
    agentEls.setupDownload.disabled = !downloadAvailable;
    agentEls.setupDownloadNotice.hidden = downloadAvailable;
  };

  // ---- Code d'appairage (partage entre /agent/setup et /agent) ----

  const pairingTargets = {
    setup: {
      box: agentEls.setupPairingBox,
      code: agentEls.setupPairingCode,
      expiry: agentEls.setupPairingExpiry,
      timer: null
    },
    agentPage: {
      box: agentEls.agentPagePairingBox,
      code: agentEls.agentPagePairingCode,
      expiry: agentEls.agentPagePairingExpiry,
      timer: null
    }
  };

  const showPairing = (targetKey, pairing) => {
    const target = pairingTargets[targetKey];
    if (target.timer) {
      window.clearTimeout(target.timer);
    }

    target.box.hidden = false;
    target.code.textContent = pairing.code;
    const expiresAt = new Date(pairing.expiresAt);
    target.expiry.textContent = `Expire a ${expiresAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.`;

    const delayMs = expiresAt.getTime() - Date.now();
    target.timer = window.setTimeout(() => {
      target.box.hidden = true;
      target.code.textContent = "----";
      target.expiry.textContent = "";
    }, Math.max(0, delayMs));
  };

  const generatePairingCode = async (targetKey, agencyIdForBody) => {
    try {
      const body = agencyIdForBody ? { agencyId: agencyIdForBody } : {};
      const { pairing } = await APP.requestJson("/api/agents/pairing-codes", {
        method: "POST",
        body: JSON.stringify(body)
      });
      showPairing(targetKey, pairing);
    } catch (error) {
      window.alert(error.message);
    }
  };

  agentEls.setupCopyCode.addEventListener("click", () => {
    void navigator.clipboard.writeText(agentEls.setupPairingCode.textContent);
  });
  agentEls.agentPageCopyCode.addEventListener("click", () => {
    void navigator.clipboard.writeText(agentEls.agentPagePairingCode.textContent);
  });

  agentEls.setupGenerateCode.addEventListener("click", () => generatePairingCode("setup"));
  agentEls.agentPageGenerateCode.addEventListener("click", () => {
    generatePairingCode("agentPage", currentAdminAgencyId());
  });

  const handleDownloadClick = () => {
    if (clientConfig?.agentDownloadUrl) {
      window.location.href = clientConfig.agentDownloadUrl;
    }
  };
  agentEls.setupDownload.addEventListener("click", handleDownloadClick);
  agentEls.agentPageDownload.addEventListener("click", handleDownloadClick);

  agentEls.setupRedetect.addEventListener("click", () => CTX.refreshAgents());
  agentEls.setupGoDashboard.addEventListener("click", () => APP.showPage("dashboard"));
  agentEls.setupSkip.addEventListener("click", (event) => {
    event.preventDefault();
    setDetectionSkipped();
    void APP.showPage("dashboard");
  });

  // ---- Page /agent (Agent local) ----

  const currentAdminAgencyId = () =>
    APP.state.user?.role === 0 && agentEls.agentPageAgencySelect.value
      ? Number(agentEls.agentPageAgencySelect.value)
      : undefined;

  const populateAgencySelectForAdmin = async () => {
    if (APP.state.user?.role !== 0) {
      agentEls.agentPageAgencyLabel.hidden = true;
      return;
    }

    agentEls.agentPageAgencyLabel.hidden = false;
    if (agentEls.agentPageAgencySelect.options.length > 0) {
      return;
    }

    const { agencies } = await APP.requestJson("/api/agencies");
    agentEls.agentPageAgencySelect.replaceChildren(
      ...agencies.map((agency) => {
        const option = document.createElement("option");
        option.value = String(agency.id);
        option.textContent = agency.name;
        return option;
      })
    );

    if (agencies[0]) {
      CTX.setAgencyOverride(Number(agencies[0].id));
    }
  };

  agentEls.agentPageAgencySelect.addEventListener("change", () => {
    CTX.setAgencyOverride(currentAdminAgencyId());
  });

  agentEls.agentPageRedetect.addEventListener("click", () => CTX.refreshAgents());

  const handleRename = async (agent) => {
    const nextName = window.prompt("Nouveau nom de l'ordinateur", agent.name);
    if (nextName === null || !nextName.trim()) {
      return;
    }

    try {
      const body = { name: nextName.trim() };
      const agencyId = currentAdminAgencyId();
      if (agencyId) {
        body.agencyId = agencyId;
      }
      await APP.requestJson(`/api/agents/${agent.agentId}`, { method: "PATCH", body: JSON.stringify(body) });
      await CTX.refreshAgents();
    } catch (error) {
      window.alert(error.message);
    }
  };

  const handleRevoke = async (agent) => {
    const confirmed = window.confirm(
      `Revoquer "${agent.name}" ? Cet ordinateur devra etre appaire de nouveau pour executer des bots.`
    );
    if (!confirmed) {
      return;
    }

    try {
      const body = {};
      const agencyId = currentAdminAgencyId();
      if (agencyId) {
        body.agencyId = agencyId;
      }
      await APP.requestJson(`/api/agents/${agent.agentId}/revoke`, { method: "POST", body: JSON.stringify(body) });
      // La revocation doit se refleter immediatement, sans attendre le
      // prochain evenement agent-status (l'agent revoque peut rester
      // techniquement connecte quelques instants avant de se faire rejeter).
      await CTX.refreshAgents();
    } catch (error) {
      window.alert(error.message);
    }
  };

  const renderAgentLocalPage = async () => {
    await populateAgencySelectForAdmin();

    const { agents, error } = CTX.getState();
    agentEls.agentPageGenerateCode.hidden = !isManager();
    const downloadAvailable = Boolean(clientConfig?.agentDownloadUrl);
    agentEls.agentPageDownload.disabled = !downloadAvailable;

    agentEls.agentTableBody.replaceChildren();

    if (error && agents.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 8;
      cell.textContent = `Impossible de charger les agents: ${error}`;
      row.append(cell);
      agentEls.agentTableBody.append(row);
      return;
    }

    if (agents.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 8;
      cell.textContent = "Aucun ordinateur associe a cette agence.";
      row.append(cell);
      agentEls.agentTableBody.append(row);
      return;
    }

    for (const agent of agents) {
      const row = document.createElement("tr");
      APP.addCell(row, agent.name);
      APP.addCell(row, agent.computerName);
      APP.addCell(row, agent.version || "-");

      const statusCell = document.createElement("td");
      statusCell.append(APP.makeBadge(BADGE_LABEL[agent.status] || agent.status, BADGE_CLASS[agent.status] || "grey"));
      row.append(statusCell);

      APP.addCell(row, APP.formatDate(agent.lastSeenAt));
      APP.addCell(row, APP.formatDate(agent.pairedAt));
      APP.addCell(row, String(agent.activeBotCount));

      const actions = document.createElement("td");
      actions.className = "action-cell";

      if (isManager() && agent.status !== "REVOKED") {
        const renameBtn = document.createElement("button");
        renameBtn.className = "outline";
        renameBtn.type = "button";
        renameBtn.textContent = "Renommer";
        renameBtn.addEventListener("click", () => handleRename(agent));
        actions.append(renameBtn);

        const revokeBtn = document.createElement("button");
        revokeBtn.className = "outline danger-text";
        revokeBtn.type = "button";
        revokeBtn.textContent = "Revoquer";
        revokeBtn.addEventListener("click", () => handleRevoke(agent));
        actions.append(revokeBtn);
      }

      row.append(actions);
      agentEls.agentTableBody.append(row);
    }
  };

  // ---- Indicateur compact (dashboard + ecran Bot) ----

  const indicatorText = (state) => {
    if (state.globalStatus === CTX.STATUS.CONNECTED) {
      const connected = state.agents.find((agent) => agent.status === "CONNECTED");
      return connected ? `Agent connecte — ${connected.name}` : "Agent connecte";
    }
    if (state.globalStatus === CTX.STATUS.OFFLINE) {
      return "Agent hors ligne";
    }
    if (state.globalStatus === CTX.STATUS.VERSION_INCOMPATIBLE) {
      return "Mise a jour de l'agent requise";
    }
    if (state.globalStatus === CTX.STATUS.ERROR) {
      return "Impossible de verifier l'agent";
    }
    return "Agent non configure";
  };

  const renderIndicators = (state) => {
    const visible = Boolean(clientConfig?.agentUiEnabled);
    agentEls.indicatorDashboard.hidden = !visible;
    agentEls.indicatorBot.hidden = !visible;
    if (!visible) {
      return;
    }

    const label = indicatorText(state);
    const badgeLabel = BADGE_LABEL[state.globalStatus] || state.globalStatus;
    const badgeClass = `pill ${BADGE_CLASS[state.globalStatus] || "grey"}`;

    agentEls.indicatorDashboardBadge.textContent = badgeLabel;
    agentEls.indicatorDashboardBadge.className = badgeClass;
    agentEls.indicatorDashboardText.textContent = label;

    agentEls.indicatorBotBadge.textContent = badgeLabel;
    agentEls.indicatorBotBadge.className = badgeClass;
    agentEls.indicatorBotText.textContent = label;
  };

  // ---- Bandeau persistant apres "Ignorer la detection" ----

  const shouldShowBanner = (state) =>
    Boolean(
      clientConfig?.agentUiEnabled
      && isDetectionSkipped()
      && state.globalStatus !== CTX.STATUS.CONNECTED
      && !bannerDismissedForView
    );

  const renderBanner = () => {
    const state = CTX.getState();
    agentEls.banner.hidden = !shouldShowBanner(state);
    agentEls.bannerMessage.textContent = BANNER_MESSAGE;
  };

  agentEls.bannerConfigure.addEventListener("click", () => APP.showPage("agent-setup"));
  agentEls.bannerRedetect.addEventListener("click", () => CTX.refreshAgents());
  agentEls.bannerDismiss.addEventListener("click", () => {
    bannerDismissedForView = true;
    renderBanner();
  });

  // ---- Bots pilotes par l'agent (section 12/13/14) ----

  // commandId -> derniere commande publique connue pour un botId donne.
  const agentCommands = new Map();

  // Statuts runtime "actifs": le bot local existe encore et fonctionne.
  // Un botStatus dans cet ensemble prime TOUJOURS sur le statut de la
  // commande pour le message affiche (AFFICHAGE, cahier des charges): une
  // commande START_BOT/VALIDATE_BOT COMPLETED ne dit rien a elle seule sur
  // l'etat du bot, et ne doit jamais afficher "Commande terminee par
  // l'agent" tant que le bot est encore actif.
  // Lot 4: MONITORING signifie desormais une boucle de surveillance
  // REELLEMENT active (plus seulement "page validee, prete" comme au Lot 3).
  const ACTIVE_BOT_STATUS_MESSAGE = {
    STARTING: "Demarrage en attente du moteur local",
    WAITING_FOR_USER: "En attente de la connexion et de l'ouverture de la page de rendez-vous",
    MONITORING: "Surveillance active",
    RATE_LIMITED: "Pause apres limitation du site",
    SLOT_DETECTED: "Creneau detecte - intervention requise",
    STOPPING: "Arret en cours (agent)",
    // Lot 4: ERROR runtime (ex. REFRESH_FAILED) n'implique pas que Chrome
    // soit ferme: le bot reste arretable tant qu'il l'est encore (section 14).
    ERROR: "Erreur du bot. Verifiez le navigateur, puis arretez si necessaire."
  };

  // Erreurs propres a VALIDATE_BOT (Lot 3) et cas herites (Lot 2): toujours
  // verifiees en PREMIER, avant le raccourci "botStatus actif" ci-dessus.
  // Sans cela, un COMMAND_FAILED(PAGE_NOT_READY) — dont le botStatus est
  // deliberement remis a WAITING_FOR_USER par l'agent — se ferait masquer par
  // le message generique "En attente de..." et l'echec deviendrait invisible.
  const FAILURE_MESSAGE_BY_ERROR_CODE = {
    AGENT_ACK_TIMEOUT: "Delai de reponse depasse",
    AGENT_DISCONNECTED: "Agent deconnecte",
    AGENT_DISCONNECTED_AFTER_ACK: "Agent deconnecte",
    AGENT_REVOKED: "Agent deconnecte",
    PAGE_NOT_READY: "La page de rendez-vous n'est pas prete. Verifiez la page ouverte dans Chrome, puis validez a nouveau.",
    BOT_NOT_RUNNING: "Ce bot n'est plus actif.",
    BROWSER_CLOSED: "Le navigateur du bot a ete ferme.",
    BROWSER_CONNECTION_LOST: "La connexion au navigateur du bot a ete perdue.",
    INVALID_BOT_STATE: "Ce bot n'est pas dans un etat permettant cette action.",
    AGENT_NOT_CONNECTED: "L'agent n'est plus connecte.",
    VALIDATION_ALREADY_RUNNING: "Une verification de page est deja en cours."
  };

  // Une commande VALIDATE_BOT non encore terminee (PENDING/SENT/ACKNOWLEDGED)
  // affiche un message dedie et desactive le double-clic sur Valider, sans
  // jamais masquer Arreter (section 7 du cahier des charges Lot 3).
  const isValidateInFlight = (command) =>
    command.type === "VALIDATE_BOT" && ["PENDING", "SENT", "ACKNOWLEDGED"].includes(command.status);

  // Traduit le couple (statut de commande, statut de bot remonte par
  // l'agent) dans les messages utilisateur exiges par la section 12/7. La
  // page ne doit jamais laisser entendre que Chrome est lance tant que
  // l'agent ne l'a pas confirme via BOT_STATUS.
  const commandStatusMessage = (command) => {
    if (command.status === "FAILED" && FAILURE_MESSAGE_BY_ERROR_CODE[command.errorCode]) {
      return FAILURE_MESSAGE_BY_ERROR_CODE[command.errorCode];
    }
    if (isValidateInFlight(command)) {
      return "Verification de la page...";
    }
    if (ACTIVE_BOT_STATUS_MESSAGE[command.botStatus]) {
      return ACTIVE_BOT_STATUS_MESSAGE[command.botStatus];
    }
    if (command.status === "PENDING" || command.status === "SENT") {
      return "Envoi de la commande...";
    }
    if (command.status === "ACKNOWLEDGED") {
      if (command.botStatus === "STOPPED") {
        return "Arret en cours (agent)";
      }
      return "Commande recue par l'agent";
    }
    if (command.status === "FAILED") {
      return "Commande echouee";
    }
    if (command.status === "EXPIRED") {
      return "Delai de reponse depasse";
    }
    if (command.status === "CANCELLED") {
      return "Commande annulee";
    }
    if (command.status === "COMPLETED") {
      return "Commande terminee par l'agent";
    }
    return command.status;
  };

  // Le statut de la commande START_BOT/STOP_BOT (PENDING/SENT/ACKNOWLEDGED/
  // COMPLETED/FAILED/...) et le statut metier du bot local remonte par
  // l'agent (botStatus: STARTING/WAITING_FOR_USER/MONITORING/.../STOPPED)
  // sont DEUX choses distinctes: START_BOT passe a COMPLETED des que Chrome
  // est ouvert, alors que le bot reste actif (WAITING_FOR_USER) bien apres.
  // Les actions (Valider/Arreter) ne doivent donc jamais se baser sur le
  // statut de commande, uniquement sur ce statut runtime.
  //
  // STARTING est volontairement exclu: au Lot 2, AgentBotManager n'enregistre
  // le bot dans son registre qu'une fois Chrome effectivement ouvert (juste
  // avant WAITING_FOR_USER) — un STOP_BOT recu pendant la toute breve fenetre
  // STARTING ne trouverait donc pas encore le bot. Aucune action n'est donc
  // proposee pendant cette fenetre precise (cf. exigence Lot 2 point 3).
  const STOPPABLE_RUNTIME_STATUSES = new Set(["WAITING_FOR_USER", "MONITORING", "RATE_LIMITED", "SLOT_DETECTED", "ERROR"]);

  const RUNTIME_BADGE = {
    STARTING: { label: "Demarrage", cls: "amber" },
    WAITING_FOR_USER: { label: "Attente utilisateur", cls: "blue" },
    MONITORING: { label: "Surveillance", cls: "green" },
    RATE_LIMITED: { label: "Ralenti", cls: "amber" },
    SLOT_DETECTED: { label: "Creneau detecte", cls: "green" },
    STOPPING: { label: "Arret en cours", cls: "amber" },
    STOPPED: { label: "Arrete", cls: "grey" },
    ERROR: { label: "Erreur", cls: "red" }
  };

  const renderAgentCommandsPanel = () => {
    if (!agentEls.commandsPanel) {
      return;
    }

    const commands = [...agentCommands.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    agentEls.commandsPanel.hidden = commands.length === 0;
    agentEls.commandsTableBody.replaceChildren();

    for (const command of commands) {
      const row = document.createElement("tr");
      APP.addCell(row, command.botName || command.botId, "strong-cell");

      const commandStatusCell = document.createElement("td");
      const cls = command.status === "COMPLETED" ? "green"
        : command.status === "FAILED" || command.status === "EXPIRED" ? "red"
          : "blue";
      commandStatusCell.append(APP.makeBadge(command.status, cls));
      row.append(commandStatusCell);

      const runtimeCell = document.createElement("td");
      const runtimeInfo = RUNTIME_BADGE[command.botStatus] || { label: "—", cls: "grey" };
      runtimeCell.append(APP.makeBadge(runtimeInfo.label, runtimeInfo.cls));
      row.append(runtimeCell);

      APP.addCell(row, commandStatusMessage(command));

      const actions = document.createElement("td");
      actions.className = "action-cell";
      if (command.botStatus === "WAITING_FOR_USER" && !isValidateInFlight(command)) {
        const validate = document.createElement("button");
        validate.className = "primary";
        validate.type = "button";
        validate.textContent = "Valider";
        validate.addEventListener("click", () => {
          // Desactive immediatement pour eviter un double-clic pendant que
          // le prochain rendu (declenche par la reponse serveur) n'a pas
          // encore eu lieu.
          validate.disabled = true;
          APP.socket.emit("continue-bot", { botId: command.botId, clientRequestId: `${command.botId}-validate-${Date.now()}` });
        });
        actions.append(validate);
      }

      if (STOPPABLE_RUNTIME_STATUSES.has(command.botStatus)) {
        const stop = document.createElement("button");
        stop.className = "outline danger-text";
        stop.type = "button";
        stop.textContent = "Arreter";
        stop.addEventListener("click", () => {
          APP.socket.emit("stop-bot", { botId: command.botId, clientRequestId: `${command.botId}-stop-${Date.now()}` });
        });
        actions.append(stop);
      }
      row.append(actions);

      agentEls.commandsTableBody.append(row);
    }
  };

  // Fusionne un objet commande deja connu avec un nouvel objet recu (socket
  // temps reel OU reponse REST), plutot que de remplacer aveuglement.
  //
  // Deux familles de champs, comparees INDEPENDAMMENT l'une de l'autre:
  // - champs "commande" (status/errorCode/message/updatedAt...): adoptes
  //   seulement si l'entrant est reellement plus recent (command.updatedAt).
  //   Protege un refresh REST contre l'ecrasement d'une mise a jour socket
  //   plus fraiche arrivee entre-temps.
  // - champs "runtime" (botStatus/botStatusUpdatedAt): compares sur LEUR
  //   PROPRE horodatage (botStatusUpdatedAt), jamais sur celui de la
  //   commande. C'est la garantie centrale demandee: un COMMAND_COMPLETED
  //   sans botStatus recent (ou racine du bug corrige: arrivant avant qu'un
  //   BOT_STATUS plus recent n'ait ete traite serveur) ne doit JAMAIS
  //   effacer un WAITING_FOR_USER deja connu et pas plus vieux.
  const mergeCommand = (existing, incoming) => {
    if (!existing) {
      return incoming;
    }

    const useIncomingCommandFields = existing.updatedAt <= incoming.updatedAt;
    const base = useIncomingCommandFields ? incoming : existing;

    const incomingRuntimeIsFresher = incoming.botStatus != null
      && (!existing.botStatusUpdatedAt || !incoming.botStatusUpdatedAt || existing.botStatusUpdatedAt <= incoming.botStatusUpdatedAt);

    return {
      ...base,
      botStatus: incomingRuntimeIsFresher ? incoming.botStatus : existing.botStatus,
      botStatusUpdatedAt: incomingRuntimeIsFresher ? incoming.botStatusUpdatedAt : existing.botStatusUpdatedAt,
      botActive: incomingRuntimeIsFresher ? incoming.botActive : existing.botActive
    };
  };

  const applyCommandUpdate = (command) => {
    agentCommands.set(command.botId, mergeCommand(agentCommands.get(command.botId), command));
    if (APP.state.page === "bot") {
      renderAgentCommandsPanel();
    }
  };

  APP.socket.on("agent-command-status", (payload) => applyCommandUpdate(payload));

  // Recupere l'etat des commandes/bots recents apres un rechargement de page
  // ou une reconnexion Socket.IO, plutot que de repartir d'un etat vide ou
  // perime (section 17). Le serveur (registre en memoire agentBots, cf.
  // agentCommandService.ts) reste la source de verite: cette requete ne fait
  // que reconstruire l'etat deja tenu a jour cote serveur, ce n'est jamais un
  // etat invente cote navigateur. Meme fusion que applyCommandUpdate: un
  // refresh REST ne doit jamais faire regresser un botStatus deja connu.
  const refreshAgentCommandsFromServer = async () => {
    if (!clientConfig?.agentUiEnabled) {
      return;
    }
    try {
      const { commands } = await APP.requestJson("/api/agent-commands?limit=20");
      for (const command of commands) {
        agentCommands.set(command.botId, mergeCommand(agentCommands.get(command.botId), command));
      }
    } catch {
      // Best-effort: l'absence de rechargement ne doit pas bloquer la page.
    }
  };

  // Une reconnexion Socket.IO (redemarrage serveur, coupure reseau) peut
  // survenir pendant que l'utilisateur est deja sur la page Bot: sans cela,
  // le tableau resterait fige sur son dernier etat connu avant la coupure.
  APP.socket.on("connect", () => {
    if (APP.state.page === "bot") {
      void refreshAgentCommandsFromServer().then(renderAgentCommandsPanel);
    }
  });

  // ---- Selection d'agent (section 6): plusieurs agents connectes ----

  const closeSelectionModal = () => {
    agentEls.selectionModal.hidden = true;
  };

  const showAgentSelectionModal = (agents) => {
    agentEls.selectionList.replaceChildren();
    for (const agent of agents) {
      if (agent.status !== "CONNECTED") {
        continue;
      }
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "agent-selection-name";
      name.textContent = agent.name;
      const pick = document.createElement("button");
      pick.className = "primary";
      pick.type = "button";
      pick.textContent = "Choisir";
      pick.addEventListener("click", () => {
        closeSelectionModal();
        const submission = APP.state.lastBotSubmission;
        if (!submission) {
          return;
        }
        // Reutilise le MEME clientRequestId que la tentative initiale: c'est
        // une nouvelle etape de la meme demande utilisateur, pas un nouveau
        // clic. Le serveur reste la source d'autorite sur l'idempotence.
        APP.socket.emit("start-bot", { ...submission, agentId: agent.agentId });
      });
      item.append(name, pick);
      agentEls.selectionList.append(item);
    }
    agentEls.selectionModal.hidden = false;
  };

  agentEls.selectionCancel.addEventListener("click", closeSelectionModal);

  APP.socket.on("bot-status", (payload) => {
    if (payload?.code === "AGENT_SELECTION_REQUIRED" && Array.isArray(payload.agents)) {
      showAgentSelectionModal(payload.agents);
    }
  });

  // ---- Modale de blocage du demarrage ----

  const canStartBot = () => {
    if (!clientConfig || clientConfig.botExecutionMode !== "agent") {
      return true;
    }
    return CTX.getState().globalStatus === CTX.STATUS.CONNECTED;
  };

  const closeModal = () => {
    agentEls.modal.hidden = true;
  };

  const showAgentRequiredModal = () => {
    const { globalStatus } = CTX.getState();
    agentEls.modalMessage.textContent = MODAL_MESSAGES[globalStatus] || MODAL_MESSAGES.NEVER_PAIRED;
    agentEls.modal.hidden = false;
  };

  agentEls.modalCancel.addEventListener("click", closeModal);
  agentEls.modalConfigure.addEventListener("click", () => {
    closeModal();
    void APP.showPage("agent-setup");
  });
  agentEls.modalRedetect.addEventListener("click", () => CTX.refreshAgents());

  // ---- Reaction centralisee a tout changement d'etat des agents ----

  // Un code d'appairage est a usage unique: des qu'un nouvel agent apparait
  // dans la liste, le code affiche (s'il y en a un) vient forcement d'etre
  // consomme. On le retire immediatement plutot que d'attendre son expiration
  // naturelle, pour ne jamais montrer un code deja invalide comme actif.
  let lastKnownAgentCount = 0;
  const hidePairingBoxesIfAgentAppeared = (state) => {
    if (state.agents.length > lastKnownAgentCount) {
      for (const target of Object.values(pairingTargets)) {
        if (target.timer) {
          window.clearTimeout(target.timer);
          target.timer = null;
        }
        target.box.hidden = true;
      }
    }
    lastKnownAgentCount = state.agents.length;
  };

  function onAgentStateChange(state) {
    hidePairingBoxesIfAgentAppeared(state);
    renderIndicators(state);
    renderBanner();
    APP.updateStartBotAvailability();
    if (APP.state.page === "agent-setup") {
      renderSetupPage();
    }
    if (APP.state.page === "agent") {
      void renderAgentLocalPage();
    }
  }

  window.AgentUi = {
    routeAfterAuth,
    onShowPage,
    canStartBot,
    showAgentRequiredModal
  };
})();
