const socket = io();

const state = {
  user: null,
  users: [],
  agencies: [],
  logs: [],
  page: "dashboard",
  botStatus: "Pret",
  agencyActiveCount: 0,
  agencyMaxClients: null,
  sessions: [],
  selectedSessionId: null,
  prompts: {}
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  loginScreen: $("#loginScreen"),
  appLayout: $("#appLayout"),
  loginForm: $("#loginForm"),
  loginInput: $("#loginInput"),
  passwordInput: $("#passwordInput"),
  loginError: $("#loginError"),
  sidebarLogout: $("#sidebarLogout"),
  dropdownLogout: $("#dropdownLogout"),
  accountButton: $("#accountButton"),
  accountDropdown: $("#accountDropdown"),
  accountName: $("#accountName"),
  accountLogin: $("#accountLogin"),
  accountLevel: $("#accountLevel"),
  avatarInitial: $("#avatarInitial"),
  pageTitle: $("#pageTitle"),
  pageSubtitle: $("#pageSubtitle"),
  dashboardStatus: $("#dashboardStatus"),
  dashboardChromePort: $("#dashboardChromePort"),
  dashboardActiveCount: $("#dashboardActiveCount"),
  dashboardPromptText: $("#dashboardPromptText"),
  dashboardContinue: $("#dashboardContinue"),
  dashboardLogList: $("#dashboardLogList"),
  startBot: $("#startBot"),
  botSelector: $("#botSelector"),
  botName: $("#botName"),
  botActiveCount: $("#botActiveCount"),
  continueBot: $("#continueBot"),
  promptContinue: $("#promptContinue"),
  stopBot: $("#stopBot"),
  status: $("#status"),
  chromePort: $("#chromePort"),
  logFile: $("#logFile"),
  promptBox: $("#promptBox"),
  promptText: $("#promptText"),
  clearLogs: $("#clearLogs"),
  logList: $("#logList"),
  serverPid: $("#serverPid"),
  serverPort: $("#serverPort"),
  activeCount: $("#activeCount"),
  sessionList: $("#sessionList"),
  stopAllSessions: $("#stopAllSessions"),
  shutdownServer: $("#shutdownServer"),
  passwordNotice: $("#passwordNotice"),
  passwordNoticeTitle: $("#passwordNoticeTitle"),
  temporaryPassword: $("#temporaryPassword"),
  copyPassword: $("#copyPassword"),
  dismissPasswordNotice: $("#dismissPasswordNotice"),
  userForm: $("#userForm"),
  userLogin: $("#userLogin"),
  userName: $("#userName"),
  userAgency: $("#userAgency"),
  userAgencyLabel: $("#userAgencyLabel"),
  userRole: $("#userRole"),
  userSearch: $("#userSearch"),
  userTableBody: $("#userTableBody"),
  agencyForm: $("#agencyForm"),
  agencyName: $("#agencyName"),
  agencyLimit: $("#agencyLimit"),
  agencyEmail: $("#agencyEmail"),
  agencyTableBody: $("#agencyTableBody"),
  settingsForm: $("#settingsForm"),
  settingsAgencyLabel: $("#settingsAgencyLabel"),
  settingsAgency: $("#settingsAgency"),
  maxParallelScansPerDomain: $("#maxParallelScansPerDomain"),
  monthClickMinDelaySec: $("#monthClickMinDelaySec"),
  monthClickMaxDelaySec: $("#monthClickMaxDelaySec"),
  botCycleCooldownMinMin: $("#botCycleCooldownMinMin"),
  botCycleCooldownMaxMin: $("#botCycleCooldownMaxMin"),
  refreshEveryCycles: $("#refreshEveryCycles"),
  rateLimitCooldownMinutes: $("#rateLimitCooldownMinutes"),
  settingsMessage: $("#settingsMessage"),
  profileInitial: $("#profileInitial"),
  profileName: $("#profileName"),
  profileLogin: $("#profileLogin"),
  profileLoginValue: $("#profileLoginValue"),
  profileRole: $("#profileRole"),
  profileStatus: $("#profileStatus"),
  profileLastLogin: $("#profileLastLogin"),
  profileCreated: $("#profileCreated"),
  passwordForm: $("#passwordForm"),
  currentPassword: $("#currentPassword"),
  newPassword: $("#newPassword"),
  confirmPassword: $("#confirmPassword"),
  passwordMessage: $("#passwordMessage")
};

const pageMeta = {
  dashboard: ["Dashboard", "Vue rapide de la surveillance locale."],
  bot: ["Bot", "Demarrage du navigateur client et validation des pauses."],
  logs: ["Logs", "Historique important pour support et maintenance."],
  maintenance: ["Maintenance", "Sessions Chrome et serveur web local."],
  settings: ["Parametres", "Orchestration et rythme de surveillance des bots."],
  users: ["User Management", "Gestion des comptes utilisateurs et activation."],
  agencies: ["Agences", "Limites clients et activation des agences."],
  profile: ["Profil", "Informations du compte et securite."]
};

const requestJson = async (url, options = {}) => {
  let response;

  try {
    response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options
    });
  } catch (error) {
    throw new Error(`Serveur inaccessible: ${error.message}`);
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error || "Erreur serveur");
  }

  return data;
};

const formatDate = (value) => {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
};

const roleLabel = (role) => {
  if (role === 0) {
    return "Interne";
  }
  return role === 1 ? "Niveau 1" : "Niveau 2";
};

const roleClass = (role) => role === 1 ? "purple" : "blue";
const userInitial = (user) => (user?.name || user?.login || "U").trim().charAt(0).toUpperCase();

const setAuthenticated = (user) => {
  state.user = user;
  els.loginScreen.hidden = true;
  els.appLayout.hidden = false;

  const canManageUsers = [0, 1].includes(user.role);
  const isAdmin = user.role === 0;
  $$(".admin-nav").forEach((el) => { el.hidden = !canManageUsers; });
  $$(".admin-only").forEach((el) => { el.hidden = !isAdmin; });
  $$(".settings-nav").forEach((el) => { el.hidden = ![0, 1].includes(user.role); });
  els.userAgencyLabel.hidden = !isAdmin;

  els.accountName.textContent = user.name;
  els.accountLogin.textContent = user.login;
  els.accountLevel.textContent = roleLabel(user.role);
  els.accountLevel.className = `pill ${roleClass(user.role)}`;
  els.avatarInitial.textContent = userInitial(user);
  renderProfile();
};

const showPage = async (page) => {
  if (page === "users" && ![0, 1].includes(state.user?.role)) {
    page = "dashboard";
  }
  if (page === "agencies" && state.user?.role !== 0) {
    page = "dashboard";
  }
  if (page === "settings" && ![0, 1].includes(state.user?.role)) {
    page = "dashboard";
  }

  state.page = page;
  $$(".page").forEach((el) => el.classList.toggle("active", el.id === `page-${page}`));
  $$(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.pageTarget === page));

  const [title, subtitle] = pageMeta[page] || pageMeta.dashboard;
  els.pageTitle.textContent = title;
  els.pageSubtitle.textContent = subtitle;
  els.accountDropdown.hidden = true;

  if (page === "users") {
    await loadUsers();
  }
  if (page === "agencies") {
    await loadAgencies();
  }
  if (page === "settings") {
    await loadMonitoringSettings();
  }
};

const addCell = (row, text, className) => {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) {
    cell.className = className;
  }
  row.append(cell);
  return cell;
};

const makeBadge = (text, className) => {
  const badge = document.createElement("span");
  badge.className = `pill ${className}`;
  badge.textContent = text;
  return badge;
};

const loadAgencies = async () => {
  if (state.user?.role !== 0) {
    state.agencies = [];
    return;
  }

  const { agencies } = await requestJson("/api/agencies");
  state.agencies = agencies;
  renderAgencies();
};

const renderAgencies = () => {
  els.agencyTableBody.replaceChildren();
  els.userAgency.replaceChildren();

  for (const agency of state.agencies) {
    const option = document.createElement("option");
    option.value = String(agency.id);
    option.textContent = agency.name;
    els.userAgency.append(option);

    const row = document.createElement("tr");
    addCell(row, agency.name);
    addCell(row, agency.notification_email || "-");
    addCell(row, String(agency.active_users));
    addCell(row, String(agency.max_active_clients));

    const statusCell = document.createElement("td");
    statusCell.append(makeBadge(agency.is_active ? "Active" : "Inactive", agency.is_active ? "green" : "red"));
    row.append(statusCell);

    const actionCell = document.createElement("td");
    actionCell.className = "action-cell";

    const emailButton = document.createElement("button");
    emailButton.className = "outline";
    emailButton.dataset.agencyEmail = String(agency.id);
    emailButton.dataset.currentEmail = agency.notification_email || "";
    emailButton.textContent = "Modifier email";
    actionCell.append(emailButton);

    const button = document.createElement("button");
    button.className = agency.is_active ? "outline danger-text" : "outline success-text";
    button.dataset.agencyId = String(agency.id);
    button.dataset.active = String(!agency.is_active);
    button.textContent = agency.is_active ? "Desactiver" : "Activer";
    actionCell.append(button);
    row.append(actionCell);
    els.agencyTableBody.append(row);
  }
};

const loadMonitoringSettings = async () => {
  if (![0, 1].includes(state.user?.role)) {
    return;
  }

  if (state.user.role === 0 && state.agencies.length === 0) {
    await loadAgencies();
  }

  els.settingsAgencyLabel.hidden = state.user.role !== 0;
  els.settingsAgency.replaceChildren();
  if (state.user.role === 0) {
    for (const agency of state.agencies) {
      const option = document.createElement("option");
      option.value = String(agency.id);
      option.textContent = agency.name;
      els.settingsAgency.append(option);
    }
  }

  const agencyId = state.user.role === 0 ? els.settingsAgency.value : "";
  const url = agencyId ? `/api/monitoring-settings?agencyId=${encodeURIComponent(agencyId)}` : "/api/monitoring-settings";
  const { settings } = await requestJson(url);
  els.maxParallelScansPerDomain.value = String(settings.maxParallelScansPerDomain);
  els.monthClickMinDelaySec.value = String(Math.round(settings.monthClickMinDelayMs / 1000));
  els.monthClickMaxDelaySec.value = String(Math.round(settings.monthClickMaxDelayMs / 1000));
  els.botCycleCooldownMinMin.value = String(Math.round(settings.botCycleCooldownMinMs / 60000));
  els.botCycleCooldownMaxMin.value = String(Math.round(settings.botCycleCooldownMaxMs / 60000));
  els.refreshEveryCycles.value = String(settings.refreshEveryCycles);
  els.rateLimitCooldownMinutes.value = String(settings.rateLimitCooldownMinutes);
  els.settingsMessage.textContent = "";
  els.settingsMessage.className = "form-message";
};

const loadUsers = async () => {
  if (![0, 1].includes(state.user?.role)) {
    return;
  }

  if (state.user.role === 0) {
    await loadAgencies();
  }

  const { users } = await requestJson("/api/users");
  state.users = users;
  renderUsers();
};

const renderUsers = () => {
  const query = els.userSearch.value.trim().toLowerCase();
  els.userTableBody.replaceChildren();

  const visibleUsers = state.users.filter((user) => {
    const text = [
      user.login,
      user.name,
      roleLabel(user.role),
      user.is_active ? "active" : "inactive"
    ].join(" ").toLowerCase();
    return text.includes(query);
  });

  for (const user of visibleUsers) {
    const row = document.createElement("tr");
    addCell(row, user.login, "strong-cell");
    addCell(row, user.name);

    const roleCell = document.createElement("td");
    roleCell.append(makeBadge(roleLabel(user.role), roleClass(user.role)));
    row.append(roleCell);

    const statusCell = document.createElement("td");
    statusCell.append(makeBadge(user.is_active ? "Active" : "Inactive", user.is_active ? "green" : "red"));
    row.append(statusCell);

    addCell(row, formatDate(user.last_login_at));
    addCell(row, formatDate(user.created_at));

    const actions = document.createElement("td");
    actions.className = "action-cell";

    const toggle = document.createElement("button");
    toggle.className = user.is_active ? "outline danger-text" : "outline success-text";
    toggle.dataset.userAction = "toggle-active";
    toggle.dataset.userId = String(user.id);
    toggle.dataset.active = String(!user.is_active);
    toggle.textContent = user.is_active ? "Desactiver" : "Activer";
    actions.append(toggle);

    const reset = document.createElement("button");
    reset.className = "outline";
    reset.dataset.userAction = "reset-password";
    reset.dataset.userId = String(user.id);
    reset.textContent = "Reset pwd";
    actions.append(reset);

    const level = document.createElement("button");
    level.className = "outline";
    level.dataset.userAction = "change-role";
    level.dataset.userId = String(user.id);
    level.dataset.role = String(user.role === 1 ? 2 : 1);
    level.textContent = user.role === 1 ? "Make Level 2" : "Make Level 1";
    actions.append(level);

    row.append(actions);
    els.userTableBody.append(row);
  }
};

const showTemporaryPassword = (title, password) => {
  els.passwordNoticeTitle.textContent = title;
  els.temporaryPassword.textContent = password;
  els.passwordNotice.hidden = false;
};

const renderProfile = () => {
  const user = state.user;
  if (!user) {
    return;
  }

  const initial = userInitial(user);
  els.profileInitial.textContent = initial;
  els.profileName.textContent = user.name;
  els.profileLogin.textContent = user.login;
  els.profileLoginValue.textContent = user.login;
  els.profileRole.textContent = roleLabel(user.role);
  els.profileStatus.textContent = user.is_active ? "Active" : "Inactive";
  els.profileLastLogin.textContent = formatDate(user.last_login_at);
  els.profileCreated.textContent = formatDate(user.created_at);
};

const updateBotStatus = (status) => {
  state.botStatus = status;
  els.status.textContent = status;
  els.dashboardStatus.textContent = status;
};

const selectedSession = () => state.sessions.find((session) => session.id === state.selectedSessionId) || null;

const setPrompt = (message, enabled, botName = "") => {
  const visibleMessage = message && botName ? `${botName}: ${message}` : message;
  els.promptText.textContent = visibleMessage;
  els.dashboardPromptText.textContent = visibleMessage || "Aucune action en attente.";
  els.promptBox.hidden = !enabled;
  els.continueBot.disabled = !enabled;
  els.promptContinue.disabled = !enabled;
  els.dashboardContinue.disabled = !enabled;
};

const renderSelectedSession = () => {
  const session = selectedSession();
  if (!session) {
    els.chromePort.textContent = "-";
    els.dashboardChromePort.textContent = "-";
    els.logFile.textContent = "-";
    updateBotStatus(state.sessions.length ? "Selectionnez un bot" : "Pret");
    setPrompt("", false);
    els.stopBot.disabled = true;
    return;
  }

  els.chromePort.textContent = String(session.port);
  els.dashboardChromePort.textContent = String(session.port);
  els.logFile.textContent = session.logFile;
  updateBotStatus(session.status);
  els.stopBot.disabled = false;
  const prompt = state.prompts[session.id] || session.promptMessage || "";
  setPrompt(prompt, Boolean(prompt), session.name);
};

const renderBotSelector = () => {
  els.botSelector.replaceChildren();

  if (state.sessions.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Aucun bot actif";
    els.botSelector.append(option);
    els.botSelector.disabled = true;
    state.selectedSessionId = null;
    renderSelectedSession();
    return;
  }

  els.botSelector.disabled = false;
  for (const session of state.sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = `${session.name || session.id} - ${session.status}${session.hasPrompt || state.prompts[session.id] ? " - action requise" : ""}`;
    els.botSelector.append(option);
  }

  if (!state.selectedSessionId || !state.sessions.some((session) => session.id === state.selectedSessionId)) {
    state.selectedSessionId = state.sessions[0].id;
  }

  els.botSelector.value = state.selectedSessionId;
  renderSelectedSession();
};

const mergeSession = (session) => {
  const index = state.sessions.findIndex((item) => item.id === session.id);
  if (index >= 0) {
    state.sessions[index] = { ...state.sessions[index], ...session };
  } else {
    state.sessions.unshift(session);
  }

  state.selectedSessionId = session.id;
  renderBotSelector();
};

const addLog = ({ level = "info", message, timestamp = new Date().toISOString() }) => {
  const event = { level, message, timestamp };
  state.logs.unshift(event);
  state.logs = state.logs.slice(0, 300);
  renderLogs();
};

const createLogItem = (event) => {
  const item = document.createElement("li");
  item.className = `log-${event.level}`;

  const meta = document.createElement("span");
  meta.textContent = `${formatDate(event.timestamp)} - ${event.level.toUpperCase()}`;

  const body = document.createElement("strong");
  body.textContent = event.message;

  item.append(meta, body);
  return item;
};

const renderLogs = () => {
  els.logList.replaceChildren(...state.logs.map(createLogItem));
  els.dashboardLogList.replaceChildren(...state.logs.slice(0, 5).map(createLogItem));
};

const continueBot = () => {
  if (!state.selectedSessionId) {
    return;
  }

  delete state.prompts[state.selectedSessionId];
  setPrompt("", false);
  socket.emit("continue-bot", { sessionId: state.selectedSessionId });
  renderBotSelector();
};

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.loginError.textContent = "";

  try {
    const { user } = await requestJson("/api/login", {
      method: "POST",
      body: JSON.stringify({
        login: els.loginInput.value,
        password: els.passwordInput.value
      })
    });
    setAuthenticated(user);
    socket.disconnect();
    socket.connect();
    await showPage("dashboard");
  } catch (error) {
    els.loginError.textContent = error.message;
  }
});

const logout = async () => {
  await requestJson("/api/logout", { method: "POST" });
  window.location.reload();
};

els.sidebarLogout.addEventListener("click", logout);
els.dropdownLogout.addEventListener("click", logout);

els.accountButton.addEventListener("click", () => {
  els.accountDropdown.hidden = !els.accountDropdown.hidden;
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".account-menu")) {
    els.accountDropdown.hidden = true;
  }

  const navButton = event.target.closest("[data-page-target]");
  if (navButton) {
    void showPage(navButton.dataset.pageTarget);
  }
});

els.agencyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await requestJson("/api/agencies", {
    method: "POST",
    body: JSON.stringify({
      name: els.agencyName.value,
      maxActiveClients: Number(els.agencyLimit.value),
      notificationEmail: els.agencyEmail.value.trim() || null
    })
  });
  els.agencyForm.reset();
  els.agencyLimit.value = "15";
  await loadAgencies();
});

els.agencyTableBody.addEventListener("click", async (event) => {
  const emailButton = event.target.closest("button[data-agency-email]");
  if (emailButton) {
    const nextEmail = window.prompt("Email notifications agence", emailButton.dataset.currentEmail || "");
    if (nextEmail === null) {
      return;
    }

    await requestJson(`/api/agencies/${emailButton.dataset.agencyEmail}`, {
      method: "PATCH",
      body: JSON.stringify({ notificationEmail: nextEmail.trim() || null })
    });
    await loadAgencies();
    return;
  }

  const button = event.target.closest("button[data-agency-id]");
  if (!button) {
    return;
  }

  await requestJson(`/api/agencies/${button.dataset.agencyId}`, {
    method: "PATCH",
    body: JSON.stringify({ isActive: button.dataset.active === "true" })
  });
  await loadAgencies();
});

els.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.settingsMessage.textContent = "";
  els.settingsMessage.className = "form-message";

  try {
    await requestJson("/api/monitoring-settings", {
      method: "PATCH",
      body: JSON.stringify({
        agencyId: state.user.role === 0 ? Number(els.settingsAgency.value) : undefined,
        maxParallelScansPerDomain: Number(els.maxParallelScansPerDomain.value),
        monthClickMinDelayMs: Number(els.monthClickMinDelaySec.value) * 1000,
        monthClickMaxDelayMs: Number(els.monthClickMaxDelaySec.value) * 1000,
        botCycleCooldownMinMs: Number(els.botCycleCooldownMinMin.value) * 60000,
        botCycleCooldownMaxMs: Number(els.botCycleCooldownMaxMin.value) * 60000,
        refreshEveryCycles: Number(els.refreshEveryCycles.value),
        rateLimitCooldownMinutes: Number(els.rateLimitCooldownMinutes.value)
      })
    });
    await loadMonitoringSettings();
    els.settingsMessage.textContent = "Parametres enregistres.";
    els.settingsMessage.classList.add("success");
  } catch (error) {
    els.settingsMessage.textContent = error.message;
    els.settingsMessage.classList.add("error");
  }
});

els.settingsAgency.addEventListener("change", () => {
  void loadMonitoringSettings();
});

els.userForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const body = {
    login: els.userLogin.value.trim(),
    name: els.userName.value.trim(),
    role: Number(els.userRole.value),
    isActive: true
  };

  if (state.user.role === 0) {
    body.agencyId = Number(els.userAgency.value);
  }

  const result = await requestJson("/api/users", {
    method: "POST",
    body: JSON.stringify(body)
  });

  showTemporaryPassword(`Utilisateur ${result.user.login} cree.`, result.temporaryPassword);
  els.userForm.reset();
  await loadUsers();
});

els.userSearch.addEventListener("input", renderUsers);

els.userTableBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-user-action]");
  if (!button) {
    return;
  }

  const userId = button.dataset.userId;
  const action = button.dataset.userAction;

  if (action === "toggle-active") {
    await requestJson(`/api/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: button.dataset.active === "true" })
    });
  }

  if (action === "change-role") {
    await requestJson(`/api/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: Number(button.dataset.role) })
    });
  }

  if (action === "reset-password") {
    const result = await requestJson(`/api/users/${userId}/reset-password`, { method: "POST" });
    showTemporaryPassword(`Mot de passe reinitialise pour ${result.user.login}.`, result.temporaryPassword);
  }

  await loadUsers();
});

els.copyPassword.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.temporaryPassword.textContent);
});

els.dismissPasswordNotice.addEventListener("click", () => {
  els.passwordNotice.hidden = true;
  els.temporaryPassword.textContent = "";
});

els.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.passwordMessage.textContent = "";
  els.passwordMessage.className = "form-message";

  if (els.newPassword.value !== els.confirmPassword.value) {
    els.passwordMessage.textContent = "La confirmation ne correspond pas.";
    els.passwordMessage.classList.add("error");
    return;
  }

  try {
    await requestJson("/api/profile/password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: els.currentPassword.value,
        newPassword: els.newPassword.value
      })
    });
    els.passwordForm.reset();
    els.passwordMessage.textContent = "Mot de passe modifie.";
    els.passwordMessage.classList.add("success");
  } catch (error) {
    els.passwordMessage.textContent = error.message;
    els.passwordMessage.classList.add("error");
  }
});

els.startBot.addEventListener("click", () => {
  els.startBot.disabled = true;
  els.stopBot.disabled = false;
  setPrompt("", false);
  els.chromePort.textContent = "-";
  els.dashboardChromePort.textContent = "-";
  els.logFile.textContent = "-";
  updateBotStatus("demarrage");
  const typedBotName = els.botName.value.trim();
  const botName = typedBotName || `Bot ${state.agencyActiveCount + 1}`;
  socket.emit("start-bot", { botName });
  els.botName.value = "";
  els.botName.placeholder = `Bot ${state.agencyActiveCount + 2}`;
  window.setTimeout(() => {
    if (state.user && (state.agencyMaxClients === null || state.agencyActiveCount < state.agencyMaxClients)) {
      els.startBot.disabled = false;
    }
  }, 1500);
});

els.continueBot.addEventListener("click", continueBot);
els.promptContinue.addEventListener("click", continueBot);
els.dashboardContinue.addEventListener("click", continueBot);

els.botSelector.addEventListener("change", () => {
  state.selectedSessionId = els.botSelector.value || null;
  renderSelectedSession();
  if (state.selectedSessionId) {
    socket.emit("select-session", { sessionId: state.selectedSessionId });
  }
});

els.stopBot.addEventListener("click", () => {
  if (!state.selectedSessionId) {
    return;
  }

  socket.emit("stop-bot", { sessionId: state.selectedSessionId });
  els.stopBot.disabled = true;
  els.startBot.disabled = false;
  setPrompt("", false);
});

els.clearLogs.addEventListener("click", () => {
  state.logs = [];
  renderLogs();
});

els.stopAllSessions.addEventListener("click", () => socket.emit("stop-all-sessions"));
els.shutdownServer.addEventListener("click", () => socket.emit("shutdown-server"));

socket.on("bot-session", (session) => {
  mergeSession(session);
  els.stopBot.disabled = false;
  if (state.agencyMaxClients === null || state.agencyActiveCount < state.agencyMaxClients) {
    els.startBot.disabled = false;
  }
});

socket.on("bot-status", ({ sessionId, status }) => {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (session) {
    session.status = status;
  }

  if (status === "stopped" || status === "error") {
    delete state.prompts[sessionId];
    state.sessions = state.sessions.filter((item) => item.id !== sessionId);
    if (state.selectedSessionId === sessionId) {
      state.selectedSessionId = state.sessions[0]?.id || null;
    }
  }

  renderBotSelector();

  if (state.agencyMaxClients === null || state.agencyActiveCount < state.agencyMaxClients) {
    els.startBot.disabled = false;
  }
});

socket.on("bot-prompt", ({ sessionId, botName, message }) => {
  if (!sessionId) {
    setPrompt(message, Boolean(message), botName);
    return;
  }

  if (message) {
    state.prompts[sessionId] = message;
    state.selectedSessionId = sessionId;
  } else {
    delete state.prompts[sessionId];
  }

  renderBotSelector();
});
socket.on("bot-log", addLog);
socket.on("bot-log-history", (events) => {
  state.logs = Array.isArray(events) ? events.slice(0, 300) : [];
  renderLogs();
});

socket.on("maintenance", ({ pid, port, maxClients, agencyActiveCount, agencyMaxClients, activeSessions }) => {
  els.serverPid.textContent = String(pid);
  els.serverPort.textContent = String(port);
  const count = Number.isFinite(agencyActiveCount) ? agencyActiveCount : activeSessions.length;
  const limit = Number.isFinite(agencyMaxClients) ? agencyMaxClients : maxClients;
  state.agencyActiveCount = count;
  state.agencyMaxClients = limit;
  els.activeCount.textContent = `${count} / ${limit}`;
  els.dashboardActiveCount.textContent = `${count} / ${limit}`;
  els.botActiveCount.textContent = `${count} / ${limit}`;
  els.botName.placeholder = `Bot ${count + 1}`;
  els.startBot.disabled = count >= limit;
  state.sessions = activeSessions;
  const activeIds = new Set(activeSessions.map((session) => session.id));
  for (const promptSessionId of Object.keys(state.prompts)) {
    if (!activeIds.has(promptSessionId)) {
      delete state.prompts[promptSessionId];
    }
  }
  for (const session of activeSessions) {
    if (session.promptMessage) {
      state.prompts[session.id] = session.promptMessage;
    }
  }
  renderBotSelector();
  els.sessionList.replaceChildren();

  if (activeSessions.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "Aucun client actif";
    els.sessionList.append(empty);
    return;
  }

  for (const session of activeSessions) {
    const item = document.createElement("li");
    const status = document.createElement("strong");
    const portText = document.createElement("span");
    const id = document.createElement("small");
    const stopButton = document.createElement("button");
    status.textContent = session.status;
    portText.textContent = `Chrome ${session.port}`;
    id.textContent = `${session.name || session.id} - ${session.id}`;
    stopButton.className = "danger";
    stopButton.type = "button";
    stopButton.textContent = "Arreter";
    stopButton.addEventListener("click", () => socket.emit("stop-session", { sessionId: session.id }));
    item.append(status, portText, id, stopButton);
    els.sessionList.append(item);
  }
});

const boot = async () => {
  try {
    const { user } = await requestJson("/api/me");
    setAuthenticated(user);
    await showPage("dashboard");
  } catch {
    els.loginScreen.hidden = false;
    els.appLayout.hidden = true;
  }
};

void boot();
