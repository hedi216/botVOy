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
