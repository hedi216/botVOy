// Rendu et navigation pour les ecrans RendezBot Agent (detection, /agent/setup,
// page "Agent local", bandeau persistant, indicateurs, modale de blocage).
// Chargé apres app.js et agentContext.js: consomme window.RendezBotApp (DOM,
// requetes, showPage...) et window.AgentContext (store d'etat des agents).
(() => {
  const APP = window.RendezBotApp;
  const CTX = window.AgentContext;
  const SKIP_KEY = "rendezbot.agentDetectionSkipped";

  let clientConfig = null;
  // Phase 5 (Lot 4): metadonnees de la release agent (version/taille/hash/
  // URL de telechargement), recuperees depuis le service de release interne
  // - jamais une URL codee en dur dans ce fichier.
  let agentRelease = null;
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
    setupReleaseInfo: document.getElementById("agentSetupReleaseInfo"),
    setupReleaseVersion: document.getElementById("agentSetupReleaseVersion"),
    setupReleaseChannel: document.getElementById("agentSetupReleaseChannel"),
    setupReleaseSize: document.getElementById("agentSetupReleaseSize"),
    setupReleaseSha256: document.getElementById("agentSetupReleaseSha256"),
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

    // CORRECTIF CIBLE (release 0.2.4): bandeau DEDIE, jamais dismissible,
    // pour VERSION_INCOMPATIBLE.
    updateBanner: document.getElementById("agentUpdateBanner"),
    updateBannerInstalled: document.getElementById("agentUpdateBannerInstalled"),
    updateBannerRequired: document.getElementById("agentUpdateBannerRequired"),
    updateBannerReleaseInfo: document.getElementById("agentUpdateBannerReleaseInfo"),
    updateBannerReleaseVersion: document.getElementById("agentUpdateBannerReleaseVersion"),
    updateBannerReleaseSize: document.getElementById("agentUpdateBannerReleaseSize"),
    updateBannerUnavailable: document.getElementById("agentUpdateBannerUnavailable"),
    updateBannerDownload: document.getElementById("agentUpdateBannerDownload"),
    updateBannerConfigure: document.getElementById("agentUpdateBannerConfigure"),

    agentPageUpdateNotice: document.getElementById("agentPageUpdateNotice"),
    agentModalDownload: document.getElementById("agentModalDownload"),

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
    commandsMessage: document.getElementById("agentCommandsMessage"),
    clearCommandsButton: document.getElementById("clearAgentCommands"),

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

  const formatApproxSize = (sizeBytes) => {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return "-";
    }
    return `${Math.round(sizeBytes / (1024 * 1024))} Mo`;
  };

  // Ne bloque jamais l'ecran d'accueil si le service de release est
  // indisponible/en erreur - se degrade toujours vers "aucune release
  // disponible", jamais une fausse URL ni une exception non geree.
  const fetchAgentRelease = async () => {
    try {
      agentRelease = await APP.requestJson("/api/agent/releases/latest");
    } catch {
      agentRelease = { available: false };
    }
    return agentRelease;
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

    await fetchAgentRelease();

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

    const downloadAvailable = Boolean(agentRelease?.available && agentRelease.downloadUrl);
    agentEls.setupDownload.disabled = !downloadAvailable;
    agentEls.setupDownloadNotice.hidden = downloadAvailable;
    // Le detail (version/taille/hash) ne s'affiche que si une release
    // interne a reellement ete verifiee par le serveur - un override
    // administratif pur (AGENT_DOWNLOAD_URL sans release interne) active le
    // bouton mais n'affiche jamais de metadonnees de fichier non verifiees.
    const hasVerifiedDetails = downloadAvailable && Boolean(agentRelease.sha256);
    agentEls.setupReleaseInfo.hidden = !hasVerifiedDetails;
    if (hasVerifiedDetails) {
      agentEls.setupReleaseVersion.textContent = agentRelease.version;
      agentEls.setupReleaseChannel.textContent = agentRelease.channel;
      agentEls.setupReleaseSize.textContent = formatApproxSize(agentRelease.sizeBytes);
      agentEls.setupReleaseSha256.textContent = agentRelease.sha256;
    }
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

  APP.bindCopyButton(agentEls.setupCopyCode, agentEls.setupPairingCode);
  APP.bindCopyButton(agentEls.agentPageCopyCode, agentEls.agentPagePairingCode);

  agentEls.setupGenerateCode.addEventListener("click", () => generatePairingCode("setup"));
  agentEls.agentPageGenerateCode.addEventListener("click", () => {
    generatePairingCode("agentPage", currentAdminAgencyId());
  });

  const handleDownloadClick = () => {
    // Reutilise TOUJOURS agentRelease.downloadUrl tel que renvoye par le
    // serveur - jamais une URL reconstruite cote frontend a partir d'un
    // numero de version.
    if (agentRelease?.available && agentRelease.downloadUrl) {
      window.location.href = agentRelease.downloadUrl;
    }
  };
  agentEls.setupDownload.addEventListener("click", handleDownloadClick);
  agentEls.agentPageDownload.addEventListener("click", handleDownloadClick);
  agentEls.updateBannerDownload.addEventListener("click", handleDownloadClick);
  agentEls.agentModalDownload.addEventListener("click", handleDownloadClick);

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

  // CHANTIER CIBLE (suppression visuelle des Agents revoques): "Supprimer"
  // cote interface - le serveur archive (soft-delete), jamais un DELETE
  // physique, mais ce detail d'implementation n'a pas besoin d'etre expose
  // ici (l'utilisateur voit simplement la ligne disparaitre).
  const handleDelete = async (agent) => {
    const confirmed = window.confirm(
      `Supprimer "${agent.name}" de la liste ?\n\n`
      + "Cet ordinateur est deja revoque et ne pourra plus etre utilise avec cet appairage. "
      + "L'historique RendezBot sera conserve."
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
      await APP.requestJson(`/api/agents/${agent.agentId}`, { method: "DELETE", body: JSON.stringify(body) });
      await CTX.refreshAgents();
    } catch (error) {
      window.alert(error.message);
    }
  };

  const renderAgentLocalPage = async () => {
    await populateAgencySelectForAdmin();

    const state = CTX.getState();
    const { agents, error } = state;
    agentEls.agentPageGenerateCode.hidden = !isManager();
    const downloadAvailable = Boolean(agentRelease?.available && agentRelease.downloadUrl);
    agentEls.agentPageDownload.disabled = !downloadAvailable;

    // CORRECTIF CIBLE (release 0.2.4): notice contextuelle des qu'au moins un
    // ordinateur de cette agence est en Version incompatible - meme si
    // l'agence reste par ailleurs utilisable (un autre agent CONNECTED
    // existe, globalStatus=CONNECTED, aucun bandeau global bloquant). Le
    // badge par ligne (ci-dessous) reste la source de verite par machine;
    // cette notice est un simple rappel visible en haut de page, jamais un
    // bouton par ligne (le bouton generique agentPageDownload suffit).
    const incompatibleVersions = [...new Set(
      agents.filter((agent) => agent.status === "VERSION_INCOMPATIBLE").map((agent) => agent.version).filter(Boolean)
    )];
    if (agentEls.agentPageUpdateNotice) {
      agentEls.agentPageUpdateNotice.hidden = incompatibleVersions.length === 0;
      if (incompatibleVersions.length > 0) {
        const requiredVersion = clientConfig?.requiredAgentVersion || "-";
        agentEls.agentPageUpdateNotice.textContent =
          `Un ou plusieurs ordinateurs utilisent une version de RendezBot Agent incompatible `
          + `(${incompatibleVersions.join(", ")}). Version requise : ${requiredVersion}. `
          + `Ces ordinateurs ne peuvent pas etre selectionnes pour lancer un bot tant qu'ils ne sont pas mis a jour.`;
      }
    }

    agentEls.agentTableBody.replaceChildren();

    if (error && agents.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 9;
      cell.textContent = `Impossible de charger les agents: ${error}`;
      row.append(cell);
      agentEls.agentTableBody.append(row);
      return;
    }

    if (agents.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 9;
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
      // Lot 5 (section 9): nuance "synchronisation en cours" sans introduire
      // un nouveau statut CONNECTED/OFFLINE - un agent CONNECTED mais pas
      // encore readyForCommands vient de se (re)connecter et termine sa
      // reconciliation (generalement quelques centaines de ms).
      const showSyncing = agent.status === "CONNECTED" && agent.readyForCommands === false;
      statusCell.append(showSyncing
        ? APP.makeBadge("Synchronisation...", "amber")
        : APP.makeBadge(BADGE_LABEL[agent.status] || agent.status, BADGE_CLASS[agent.status] || "grey"));
      row.append(statusCell);

      APP.addCell(row, APP.formatDate(agent.lastSeenAt));
      APP.addCell(row, APP.formatDate(agent.pairedAt));
      APP.addCell(row, String(agent.activeBotCount));

      const extensionsCell = document.createElement("td");
      const extensions = Array.isArray(agent.extensions) ? agent.extensions : [];
      if (extensions.length === 0) {
        extensionsCell.textContent = "-";
      } else {
        const validCount = extensions.filter((extension) => extension.valid).length;
        const badgeClass = validCount === extensions.length ? "green" : "amber";
        extensionsCell.append(APP.makeBadge(`${validCount}/${extensions.length} OK`, badgeClass));
        extensionsCell.title = extensions.map((extension) => `${extension.id}: ${extension.valid ? "valide" : extension.configured ? "invalide" : "non configuree"}`).join(", ");
      }
      row.append(extensionsCell);

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

      if (isManager() && agent.status === "REVOKED") {
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "outline danger-text";
        deleteBtn.type = "button";
        deleteBtn.textContent = "Supprimer";
        deleteBtn.addEventListener("click", () => handleDelete(agent));
        actions.append(deleteBtn);
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
  //
  // CORRECTIF CIBLE (release 0.2.4): VERSION_INCOMPATIBLE a desormais son
  // PROPRE bandeau obligatoire (renderUpdateBanner ci-dessous, jamais
  // dismissible, independant de "Ignorer la detection") - explicitement
  // exclu ici pour ne jamais afficher les deux bandeaux a la fois.

  const shouldShowBanner = (state) =>
    Boolean(
      clientConfig?.agentUiEnabled
      && isDetectionSkipped()
      && state.globalStatus !== CTX.STATUS.CONNECTED
      && state.globalStatus !== CTX.STATUS.VERSION_INCOMPATIBLE
      && !bannerDismissedForView
    );

  const renderBanner = () => {
    const state = CTX.getState();
    agentEls.banner.hidden = !shouldShowBanner(state);
    agentEls.bannerMessage.textContent = BANNER_MESSAGE;
    renderUpdateBanner(state);
  };

  agentEls.bannerConfigure.addEventListener("click", () => APP.showPage("agent-setup"));
  agentEls.bannerRedetect.addEventListener("click", () => CTX.refreshAgents());
  agentEls.bannerDismiss.addEventListener("click", () => {
    bannerDismissedForView = true;
    renderBanner();
  });

  // ---- Bandeau OBLIGATOIRE de mise a jour (VERSION_INCOMPATIBLE) ----
  //
  // Regle centrale (section 5 du correctif): ce bandeau doit apparaitre
  // exactement quand l'agence n'a AUCUN Agent compatible CONNECTE/pret -
  // c'est EXACTEMENT ce que represente globalStatus === VERSION_INCOMPATIBLE
  // (computeGlobalStatus, agentContext.js, deja verifie: CONNECTED est
  // toujours prioritaire des qu'un seul agent compatible existe). Reutilise
  // cette agregation existante telle quelle - AUCUNE nouvelle logique de
  // priorite entre agents ici.
  const shouldShowUpdateBanner = (state) =>
    Boolean(clientConfig?.agentUiEnabled && state.globalStatus === CTX.STATUS.VERSION_INCOMPATIBLE);

  // Version(s) "installee(s)" affichee(s): tous les agents REELLEMENT
  // incompatibles de cette agence (jamais une valeur inventee) - une agence
  // peut avoir plusieurs machines a des versions differentes, toutes
  // affichees plutot que d'en masquer une arbitrairement.
  const installedIncompatibleVersions = (state) => {
    const versions = state.agents
      .filter((agent) => agent.status === "VERSION_INCOMPATIBLE")
      .map((agent) => agent.version)
      .filter(Boolean);
    return [...new Set(versions)];
  };

  // CORRECTIF CIBLE (section 6): ne reutilise JAMAIS des metadonnees de
  // release potentiellement anciennes pour ce bandeau - un refetch reel est
  // declenche a chaque TRANSITION vers VERSION_INCOMPATIBLE (jamais a chaque
  // rendu: onAgentStateChange peut se declencher tres frequemment via le
  // socket, un refetch par transition suffit et evite de marteler l'API).
  let lastGlobalStatusForUpdateBanner = null;
  let updateBannerReleaseFetchInFlight = false;

  const refreshReleaseForUpdateBannerIfNeeded = (state) => {
    const enteringIncompatible = state.globalStatus === CTX.STATUS.VERSION_INCOMPATIBLE
      && lastGlobalStatusForUpdateBanner !== CTX.STATUS.VERSION_INCOMPATIBLE;
    lastGlobalStatusForUpdateBanner = state.globalStatus;

    if (!enteringIncompatible || updateBannerReleaseFetchInFlight) {
      return;
    }
    updateBannerReleaseFetchInFlight = true;
    fetchAgentRelease()
      .then(() => renderUpdateBanner(CTX.getState()))
      .finally(() => { updateBannerReleaseFetchInFlight = false; });
  };

  const renderUpdateBanner = (state) => {
    const visible = shouldShowUpdateBanner(state);
    agentEls.updateBanner.hidden = !visible;
    if (!visible) {
      return;
    }

    refreshReleaseForUpdateBannerIfNeeded(state);

    const installedVersions = installedIncompatibleVersions(state);
    agentEls.updateBannerInstalled.textContent = installedVersions.length > 0 ? installedVersions.join(", ") : "-";
    // requiredAgentVersion vient EXCLUSIVEMENT de /api/client-config
    // (agentGatewayConfig.minAgentVersion cote serveur) - jamais hardcode
    // ici, jamais deduit de la release au telechargement.
    agentEls.updateBannerRequired.textContent = clientConfig?.requiredAgentVersion || "-";

    // CORRECTIF CIBLE (section 7): release indisponible -> jamais de faux
    // bouton fonctionnel, message explicite, demarrage toujours bloque
    // (canStartBot() ci-dessous reste independant de la disponibilite de la
    // release: seul le statut de l'agent compte).
    const downloadAvailable = Boolean(agentRelease?.available && agentRelease.downloadUrl);
    agentEls.updateBannerDownload.hidden = !downloadAvailable;
    agentEls.updateBannerUnavailable.hidden = downloadAvailable;
    agentEls.updateBannerReleaseInfo.hidden = !downloadAvailable;
    if (downloadAvailable) {
      agentEls.updateBannerReleaseVersion.textContent = agentRelease.version ?? "-";
      agentEls.updateBannerReleaseSize.textContent = formatApproxSize(agentRelease.sizeBytes);
    }
  };

  agentEls.updateBannerConfigure.addEventListener("click", () => APP.showPage("agent-setup"));

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
    VALIDATION_ALREADY_RUNNING: "Une verification de page est deja en cours.",
    // BUG CIBLE 0.1.5: ces deux codes ne doivent jamais s'afficher pareil -
    // AGENT_CAPACITY_REACHED (limite reelle atteinte) exige une action
    // differente de AGENT_SHUTTING_DOWN (relancer l'agent).
    AGENT_CAPACITY_REACHED: "Limite locale de bots actifs atteinte sur cet agent.",
    AGENT_SHUTTING_DOWN: "L'agent est en cours d'arret. Relancez RendezBot Agent."
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
    if (command.status === "FAILED") {
      if (FAILURE_MESSAGE_BY_ERROR_CODE[command.errorCode]) {
        return FAILURE_MESSAGE_BY_ERROR_CODE[command.errorCode];
      }
      // BUG CIBLE 0.1.5 (point 5): a defaut d'une entree dediee ci-dessus,
      // afficher le message public deja assaini envoye par l'agent
      // (AgentBotManager.publicMessageFor - jamais de payload/login/mot de
      // passe, toujours une phrase fixe par code) plutot que de masquer
      // silencieusement l'echec derriere le texte generique "Commande
      // echouee". Si meme ce message est absent, afficher au moins le code
      // reel pour rester diagnosticable.
      if (typeof command.message === "string" && command.message.trim()) {
        return command.message;
      }
      return command.errorCode ? `Commande echouee (${command.errorCode})` : "Commande echouee";
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

  // Nettoyage de l'historique: uniquement des lignes REELLEMENT terminees.
  // Simple gate d'affichage (le serveur revalide integralement de son cote,
  // cf. deleteCommandForAgency/clearTerminalCommandsForAgency): jamais
  // COMPLETED/FAILED seuls, le bot associe doit aussi etre STOPPED ou
  // totalement inconnu (jamais ERROR: un bot en erreur peut encore avoir
  // Chrome ouvert et necessiter un arret explicite, cf. STOPPABLE_RUNTIME_STATUSES).
  const TERMINAL_COMMAND_STATUSES = new Set(["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"]);
  const isRowDeletable = (command) =>
    TERMINAL_COMMAND_STATUSES.has(command.status) && (command.botStatus == null || command.botStatus === "STOPPED");

  const setCommandsMessage = (text, kind) => {
    if (!agentEls.commandsMessage) {
      return;
    }
    agentEls.commandsMessage.textContent = text;
    agentEls.commandsMessage.className = "form-message";
    if (kind) {
      agentEls.commandsMessage.classList.add(kind);
    }
  };

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

      if (isRowDeletable(command)) {
        const remove = document.createElement("button");
        remove.className = "outline danger-text";
        remove.type = "button";
        remove.textContent = "Supprimer";
        remove.addEventListener("click", () => handleDeleteCommandRow(command, remove));
        actions.append(remove);
      }
      row.append(actions);

      agentEls.commandsTableBody.append(row);
    }
  };

  // Supprime UNE ligne d'historique (jamais le bot/profil/agent lui-meme -
  // uniquement l'enregistrement serveur de cette commande, cf.
  // deleteCommandForAgency). Le serveur revalide integralement (agence,
  // statut terminal, bot inactif): une reponse 409/404 ici reflete donc un
  // vrai refus metier, jamais seulement un souci d'affichage.
  const handleDeleteCommandRow = async (command, button) => {
    if (!window.confirm("Supprimer cette ligne de l'historique ?")) {
      return;
    }
    button.disabled = true;
    try {
      await APP.requestJson(`/api/agent-commands/${command.commandId}`, { method: "DELETE" });
      agentCommands.delete(command.botId);
      renderAgentCommandsPanel();
      setCommandsMessage("Historique supprime.", "success");
    } catch (error) {
      button.disabled = false;
      setCommandsMessage(error.message, "error");
    }
  };

  // Bouton "Nettoyer l'historique": ne supprime cote serveur que les lignes
  // deja terminees (meme regle que le bouton par ligne). Le nombre reellement
  // supprime peut differer de ce que l'affichage local suggere (une commande
  // devenue active entre-temps, un autre onglet ayant deja nettoye...): on ne
  // retire donc du Map local QUE les lignes qui etaient deja marquees
  // supprimables ici, plutot que de supposer que tout a disparu.
  const handleClearAgentCommands = async () => {
    if (!window.confirm("Nettoyer l'historique termine de cette agence ?")) {
      return;
    }
    if (agentEls.clearCommandsButton) {
      agentEls.clearCommandsButton.disabled = true;
    }
    try {
      const { deletedCount } = await APP.requestJson("/api/agent-commands", { method: "DELETE" });
      for (const [botId, command] of [...agentCommands.entries()]) {
        if (isRowDeletable(command)) {
          agentCommands.delete(botId);
        }
      }
      renderAgentCommandsPanel();
      setCommandsMessage(
        deletedCount > 0 ? `Historique supprime (${deletedCount} ligne(s)).` : "Aucune ligne terminee a supprimer.",
        "success"
      );
    } catch (error) {
      setCommandsMessage(error.message, "error");
    } finally {
      if (agentEls.clearCommandsButton) {
        agentEls.clearCommandsButton.disabled = false;
      }
    }
  };

  if (agentEls.clearCommandsButton) {
    agentEls.clearCommandsButton.addEventListener("click", () => { void handleClearAgentCommands(); });
  }

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
    // CORRECTIF CIBLE (release 0.2.4): "offrir si possible" le telechargement
    // directement dans la modale de blocage pour VERSION_INCOMPATIBLE -
    // jamais affiche pour les autres statuts, jamais un bouton fonctionnel
    // si la release n'est pas reellement disponible.
    const downloadAvailable = Boolean(agentRelease?.available && agentRelease.downloadUrl);
    agentEls.agentModalDownload.hidden = !(globalStatus === CTX.STATUS.VERSION_INCOMPATIBLE && downloadAvailable);
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
