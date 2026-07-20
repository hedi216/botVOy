// Store central pour l'etat de RendezBot Agent. Pas de framework front dans ce
// projet (script classique, pas de module ES) : ce fichier expose
// window.AgentContext, charge apres app.js (dont il reutilise
// window.RendezBotApp.requestJson) et avant agentUi.js.
(() => {
  const STATUS = {
    CHECKING: "CHECKING",
    NEVER_PAIRED: "NEVER_PAIRED",
    CONNECTED: "CONNECTED",
    OFFLINE: "OFFLINE",
    VERSION_INCOMPATIBLE: "VERSION_INCOMPATIBLE",
    REVOKED: "REVOKED",
    ERROR: "ERROR"
  };

  let agents = [];
  let loading = true;
  let error = null;
  let lastRefreshAt = null;
  // Distinct de lastRefreshAt: ce dernier marque chaque tentative (succes ou
  // echec), alors que hasLoadedOnce ne devient vrai qu'apres un premier succes.
  // Sans cette distinction, une simple coupure reseau passagere APRES un
  // premier chargement reussi ferait retomber tout le monde en ERROR/CHECKING
  // alors que le canal socket agent-status continue de donner l'etat reel.
  let hasLoadedOnce = false;
  let initialized = false;
  let resolveFirstLoad = null;
  let firstLoadPromise = null;
  const subscribers = new Set();

  const computeGlobalStatus = () => {
    if (error && !hasLoadedOnce) {
      return STATUS.ERROR;
    }

    if (loading && !hasLoadedOnce) {
      return STATUS.CHECKING;
    }

    const nonRevoked = agents.filter((agent) => agent.status !== "REVOKED");

    if (agents.length === 0 || nonRevoked.length === 0) {
      return STATUS.NEVER_PAIRED;
    }

    if (nonRevoked.some((agent) => agent.status === "CONNECTED")) {
      return STATUS.CONNECTED;
    }

    if (nonRevoked.some((agent) => agent.status === "VERSION_INCOMPATIBLE")) {
      return STATUS.VERSION_INCOMPATIBLE;
    }

    return STATUS.OFFLINE;
  };

  const getState = () => ({
    agents: agents.slice(),
    loading,
    error,
    lastRefreshAt,
    globalStatus: computeGlobalStatus()
  });

  const notify = () => {
    const snapshot = getState();
    for (const subscriber of subscribers) {
      try {
        subscriber(snapshot);
      } catch (subscriberError) {
        console.error("AgentContext: erreur dans un abonne", subscriberError);
      }
    }
  };

  // Un administrateur global (role 0) n'a pas d'agency_id propre: le backend
  // exige un agencyId explicite en query (cf. resolveViewAgencyId cote
  // serveur). Les utilisateurs d'agence n'en ont pas besoin, le backend
  // deduit leur agence de leur session.
  let agencyOverride = null;
  const setAgencyOverride = (agencyId) => {
    agencyOverride = agencyId || null;
    hasLoadedOnce = false;
    void refreshAgents();
  };

  const refreshAgents = async () => {
    loading = true;
    notify();

    try {
      const url = agencyOverride ? `/api/agents?agencyId=${encodeURIComponent(agencyOverride)}` : "/api/agents";
      const response = await window.RendezBotApp.requestJson(url);
      agents = Array.isArray(response.agents) ? response.agents : [];
      error = null;
      hasLoadedOnce = true;
    } catch (requestError) {
      error = requestError.message || "Erreur inconnue.";
    } finally {
      loading = false;
      lastRefreshAt = new Date().toISOString();
      notify();
      if (resolveFirstLoad) {
        resolveFirstLoad();
        resolveFirstLoad = null;
      }
    }
  };

  const applyAgentStatus = (snapshot) => {
    if (!snapshot || typeof snapshot.agentId !== "number") {
      return;
    }

    const index = agents.findIndex((agent) => agent.agentId === snapshot.agentId);
    if (index >= 0) {
      agents = agents.map((agent, i) => (i === index ? snapshot : agent));
    } else {
      agents = agents.concat([snapshot]);
    }

    lastRefreshAt = new Date().toISOString();
    notify();
  };

  const init = (socket) => {
    if (initialized) {
      return firstLoadPromise;
    }

    initialized = true;
    firstLoadPromise = new Promise((resolve) => {
      resolveFirstLoad = resolve;
    });

    socket.on("agent-status", applyAgentStatus);
    void refreshAgents();

    return firstLoadPromise;
  };

  window.AgentContext = {
    STATUS,
    init,
    setAgencyOverride,
    refreshAgents,
    getState,
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    whenFirstLoadSettles: () => firstLoadPromise || Promise.resolve()
  };
})();
