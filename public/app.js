const socket = io();

const state = {
  user: null,
  billing: null,
  users: [],
  agencies: [],
  logs: [],
  page: "dashboard",
  botStatus: "Pret",
  agencyActiveCount: 0,
  agencyMaxClients: null,
  sessions: [],
  prompts: {},
  extensions: [],
  categories: []
};

let dashboardPromptSessionId = null;

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
  botForm: $("#botForm"),
  botFormName: $("#botFormName"),
  botFormCategory: $("#botFormCategory"),
  botFormLogin: $("#botFormLogin"),
  botFormPassword: $("#botFormPassword"),
  botActiveCount: $("#botActiveCount"),
  botQuotaMessage: $("#botQuotaMessage"),
  botSearch: $("#botSearch"),
  botTableBody: $("#botTableBody"),
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
  userEmail: $("#userEmail"),
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
  extensionForm: $("#extensionForm"),
  extensionAgencyLabel: $("#extensionAgencyLabel"),
  extensionAgency: $("#extensionAgency"),
  extensionName: $("#extensionName"),
  extensionUrl: $("#extensionUrl"),
  extensionActive: $("#extensionActive"),
  extensionMessage: $("#extensionMessage"),
  extensionTableBody: $("#extensionTableBody"),
  categoryForm: $("#categoryForm"),
  categoryAgencyLabel: $("#categoryAgencyLabel"),
  categoryAgency: $("#categoryAgency"),
  categoryName: $("#categoryName"),
  categoryMessage: $("#categoryMessage"),
  categoryTableBody: $("#categoryTableBody"),
  profileInitial: $("#profileInitial"),
  profileName: $("#profileName"),
  profileLogin: $("#profileLogin"),
  profileLoginValue: $("#profileLoginValue"),
  profileEmail: $("#profileEmail"),
  profileRole: $("#profileRole"),
  profileStatus: $("#profileStatus"),
  profileLastLogin: $("#profileLastLogin"),
  profileCreated: $("#profileCreated"),
  passwordForm: $("#passwordForm"),
  currentPassword: $("#currentPassword"),
  newPassword: $("#newPassword"),
  confirmPassword: $("#confirmPassword"),
  passwordMessage: $("#passwordMessage"),
  billingLockScreen: $("#billingLockScreen"),
  billingLockDate: $("#billingLockDate"),
  billingLockLogout: $("#billingLockLogout"),
  billingBanner: $("#billingBanner"),
  billingBannerMessage: $("#billingBannerMessage")
};

const pageMeta = {
  dashboard: ["Dashboard", "Vue rapide de la surveillance locale."],
  bot: ["Bot", "Demarrage du navigateur client et validation des pauses."],
  logs: ["Logs", "Historique important pour support et maintenance."],
  maintenance: ["Maintenance", "Sessions Chrome et serveur web local."],
  settings: ["Parametres", "Orchestration et rythme de surveillance des bots."],
  extensions: ["Extensions", "Liens ouverts au demarrage des bots pour installation manuelle."],
  categories: ["Categories", "Categories de bots propres a cette agence, independantes des autres."],
  users: ["User Management", "Gestion des comptes utilisateurs et activation."],
  agencies: ["Agences", "Limites clients et activation des agences."],
  profile: ["Profil", "Informations du compte et securite."],
  "agent-setup": ["Configurer RendezBot Agent", "Detection et appairage de l'agent local."],
  agent: ["Agent local", "Ordinateurs autorises a executer les navigateurs et bots de cette agence."]
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
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const looksLikeHtml = text.trim().startsWith("<");
      throw new Error(looksLikeHtml
        ? "Le serveur ne reconnait pas cette route API. Redemarrez RendezBot pour charger la derniere version."
        : "Reponse serveur invalide.");
    }
  }

  if (!response.ok) {
    // CHANTIER CIBLE (gestion des echeances et impayes des agences):
    // reconnaissance GLOBALE du code machine PAYMENT_SUSPENDED, quel que soit
    // l'appelant - jamais un simple texte d'erreur local a chaque formulaire.
    // Bascule immediate sur l'ecran de blocage, PUIS l'erreur continue a
    // remonter normalement pour que l'appelant arrete son propre traitement.
    if (data.code === "PAYMENT_SUSPENDED") {
      showBillingLockScreen(data.billing);
    }
    const error = new Error(data.error || "Erreur serveur");
    error.code = data.code;
    throw error;
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

// CHANTIER CIBLE (gestion des echeances et impayes des agences): les dates de
// facturation sont des chaines 'YYYY-MM-DD' pures (jamais un objet Date, pour
// eviter tout glissement de fuseau horaire cote navigateur) - reformatage
// texte simple, jamais new Date(...).
const formatDateOnly = (dateOnly) => {
  if (!dateOnly) {
    return "-";
  }
  const [year, month, day] = dateOnly.split("-");
  return `${day}/${month}/${year}`;
};

// Ecran de blocage suspension paiement - distinct du login (aucun retour
// possible vers l'app, seule la deconnexion est proposee). Appele depuis
// requestJson (toute reponse 403 PAYMENT_SUSPENDED) ET depuis
// applyBillingState (etat retourne par un /api/login ou /api/me reussi).
const showBillingLockScreen = (billing) => {
  state.billing = billing || state.billing;
  els.loginScreen.hidden = true;
  els.appLayout.hidden = true;
  els.billingLockScreen.hidden = false;
  els.billingLockDate.textContent = formatDateOnly(state.billing?.nextPaymentDate);
};

const hideBillingLockScreen = () => {
  els.billingLockScreen.hidden = true;
};

// Bandeau non bloquant (due_today/grace_period/override) - jamais reutilise
// pour VERSION_INCOMPATIBLE (Task 3, agentUpdateBanner) ni l'inverse.
const renderBillingBanner = (billing) => {
  if (!billing || !els.billingBanner) {
    return;
  }

  els.billingBanner.classList.remove("billing-banner-override");

  if (billing.status === "due_today") {
    els.billingBannerMessage.textContent = `Votre paiement RendezBot etait du aujourd'hui (${formatDateOnly(billing.nextPaymentDate)}). Merci de regulariser votre situation.`;
    els.billingBanner.hidden = false;
    return;
  }

  if (billing.status === "grace_period") {
    els.billingBannerMessage.textContent = `Paiement en attente depuis le ${formatDateOnly(billing.nextPaymentDate)}. Il vous reste ${billing.graceDaysRemaining} jour${billing.graceDaysRemaining > 1 ? "s" : ""} avant la suspension de l'acces.`;
    els.billingBanner.hidden = false;
    return;
  }

  if (billing.status === "override") {
    els.billingBanner.classList.add("billing-banner-override");
    els.billingBannerMessage.textContent = `Acces autorise temporairement jusqu'au ${formatDate(billing.overrideUntil)}, en attente de regularisation du paiement du ${formatDateOnly(billing.nextPaymentDate)}.`;
    els.billingBanner.hidden = false;
    return;
  }

  els.billingBanner.hidden = true;
};

// Point d'entree unique appele apres chaque reponse contenant `billing`
// (login, /api/me, rafraichissement periodique) - jamais le seul canal
// requestJson/PAYMENT_SUSPENDED, qui ne couvre que les refus explicites d'une
// action business alors que la session est deja ouverte.
const applyBillingState = (billing) => {
  state.billing = billing || null;

  if (!billing) {
    hideBillingLockScreen();
    if (els.billingBanner) {
      els.billingBanner.hidden = true;
    }
    return;
  }

  if (!billing.accessAllowed) {
    showBillingLockScreen(billing);
    return;
  }

  hideBillingLockScreen();
  // Restaure l'app si l'ecran de blocage l'avait masquee (ex. rafraichissement
  // periodique detectant un paiement regularise entre-temps) - sans effet si
  // l'utilisateur n'est pas encore authentifie (boot() gere ce cas seul).
  if (state.user) {
    els.appLayout.hidden = false;
  }
  renderBillingBanner(billing);
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

// Point d'extension Phase 2: si agentUi.js (charge apres ce fichier) a
// enregistre un routeur, on lui delegue la navigation post-authentification
// (detection d'agent, /agent/setup...). Sinon comportement historique
// inchange: acces direct au dashboard.
const routeAfterAuth = async () => {
  if (window.AgentUi && typeof window.AgentUi.routeAfterAuth === "function") {
    await window.AgentUi.routeAfterAuth();
    return;
  }

  await showPage("dashboard");
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
  if (page === "extensions" && ![0, 1].includes(state.user?.role)) {
    page = "dashboard";
  }
  if (page === "categories" && ![0, 1].includes(state.user?.role)) {
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
  if (page === "extensions") {
    await loadExtensions();
  }
  if (page === "categories") {
    await loadCategories();
  }
  if (page === "bot") {
    await loadBotFormCategoryOptions();
  }

  if (window.AgentUi && typeof window.AgentUi.onShowPage === "function") {
    await window.AgentUi.onShowPage(page);
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

// Retour visuel unifie pour tout bouton "Copier" (mot de passe temporaire,
// code d'appairage Agent, ...): jamais de secret transmis au reseau ni
// journalise ici - navigator.clipboard.writeText() est une operation
// strictement locale au navigateur.
const COPY_FEEDBACK_MS = 2_000;

const bindCopyButton = (button, sourceEl) => {
  if (!button || !sourceEl) {
    return;
  }

  const originalLabel = button.textContent;
  // aria-live sur le bouton lui-meme: un changement de son propre texte
  // ("Copie" -> "Copie ✓") est alors annonce, sans dependre d'une
  // region separee ni de la seule couleur.
  button.setAttribute("aria-live", "polite");
  button.setAttribute("aria-atomic", "true");
  let resetTimer = null;

  // Repli accessible en cas d'echec (section 3): jamais force manuellement,
  // uniquement une pre-selection pratique - l'utilisateur reste libre de
  // copier lui-meme (Ctrl+C) sans dependre du bouton.
  const selectSourceText = () => {
    try {
      const range = document.createRange();
      range.selectNodeContents(sourceEl);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // Uniquement un confort: son echec ne doit jamais empecher l'affichage
      // du message "Copie impossible" lui-meme.
    }
  };

  button.addEventListener("click", async () => {
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }

    const text = sourceEl.textContent || "";
    if (!text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copié ✓";
      button.disabled = true;
      resetTimer = setTimeout(() => {
        button.textContent = originalLabel;
        button.disabled = false;
        resetTimer = null;
      }, COPY_FEEDBACK_MS);
    } catch {
      // Jamais "Copie" en cas d'echec (section 3): le presse-papiers peut
      // etre indisponible (permission refusee, contexte non securise...).
      button.textContent = "Copie impossible";
      selectSourceText();
    }
  });
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

// CHANTIER CIBLE (gestion des echeances et impayes des agences): badge de
// statut COMMERCIAL (billing.status), volontairement separe du badge
// "Statut agence" (is_active, administratif) ci-dessus - jamais fusionnes,
// pour ne pas laisser croire qu'une reactivation de l'un reactive l'autre.
const billingStatusBadge = (billing) => {
  switch (billing?.status) {
    case "current":
      return makeBadge("A jour", "green");
    case "due_today":
      return makeBadge("Echeance du jour", "amber");
    case "grace_period":
      return makeBadge(`Delai de grace (${billing.graceDaysRemaining}j)`, "amber");
    case "override":
      return makeBadge("Autorisation temporaire", "blue");
    case "suspended":
      return makeBadge("Suspendu", "red");
    case "not_configured":
    default:
      return makeBadge("Non configure", "grey");
  }
};

const renderAgencies = () => {
  els.agencyTableBody.replaceChildren();
  els.userAgency.replaceChildren();

  for (const agency of state.agencies) {
    const option = document.createElement("option");
    option.value = String(agency.id);
    option.textContent = agency.name;
    els.userAgency.append(option);

    const billing = agency.billing || null;
    const row = document.createElement("tr");
    addCell(row, agency.name);
    addCell(row, agency.notification_email || "-");
    addCell(row, String(agency.active_users));
    addCell(row, String(agency.max_active_clients));

    const statusCell = document.createElement("td");
    statusCell.append(makeBadge(agency.is_active ? "Active" : "Inactive", agency.is_active ? "green" : "red"));
    row.append(statusCell);

    // Prochain paiement: <input type="date"> + bouton "Enregistrer" - jamais
    // window.prompt (correction utilisateur explicite).
    const paymentDateCell = document.createElement("td");
    const paymentDateForm = document.createElement("div");
    paymentDateForm.className = "billing-inline-form";
    const paymentDateInput = document.createElement("input");
    paymentDateInput.type = "date";
    paymentDateInput.value = billing?.nextPaymentDate || "";
    paymentDateInput.dataset.role = "next-payment-date-input";
    const paymentDateSave = document.createElement("button");
    paymentDateSave.type = "button";
    paymentDateSave.className = "outline";
    paymentDateSave.textContent = "Enregistrer";
    paymentDateSave.dataset.saveNextPaymentDate = String(agency.id);
    paymentDateForm.append(paymentDateInput, paymentDateSave);
    paymentDateCell.append(paymentDateForm);
    row.append(paymentDateCell);

    // Statut paiement: badge derive de computeAgencyBillingState (jamais un
    // etat stocke) + gestion inline de l'autorisation temporaire.
    const billingStatusCell = document.createElement("td");
    billingStatusCell.append(billingStatusBadge(billing));

    if (billing?.status === "override") {
      const overrideInfo = document.createElement("div");
      overrideInfo.className = "billing-inline-form";
      const overrideText = document.createElement("small");
      overrideText.textContent = `Jusqu'au ${formatDate(billing.overrideUntil)}`;
      const removeOverrideButton = document.createElement("button");
      removeOverrideButton.type = "button";
      removeOverrideButton.className = "outline danger-text";
      removeOverrideButton.textContent = "Supprimer l'autorisation";
      removeOverrideButton.dataset.removeOverride = String(agency.id);
      overrideInfo.append(overrideText, removeOverrideButton);
      billingStatusCell.append(overrideInfo);
    } else {
      const overrideForm = document.createElement("div");
      overrideForm.className = "billing-inline-form";
      const overrideInput = document.createElement("input");
      overrideInput.type = "datetime-local";
      overrideInput.dataset.role = "override-until-input";
      const grantOverrideButton = document.createElement("button");
      grantOverrideButton.type = "button";
      grantOverrideButton.className = "outline";
      grantOverrideButton.textContent = "Autoriser temporairement";
      grantOverrideButton.dataset.grantOverride = String(agency.id);
      overrideForm.append(overrideInput, grantOverrideButton);
      billingStatusCell.append(overrideForm);
    }
    row.append(billingStatusCell);

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

const currentSettingsAgencyId = () => state.user?.role === 0 ? Number(els.settingsAgency.value) : undefined;

const currentExtensionAgencyId = () => state.user?.role === 0 ? Number(els.extensionAgency.value) : undefined;

const extensionAgencyQuery = () => {
  const agencyId = currentExtensionAgencyId();
  return agencyId ? `?agencyId=${encodeURIComponent(agencyId)}` : "";
};

const loadExtensions = async () => {
  if (![0, 1].includes(state.user?.role)) {
    return;
  }

  if (state.user.role === 0 && state.agencies.length === 0) {
    await loadAgencies();
  }

  els.extensionAgencyLabel.hidden = state.user.role !== 0;
  els.extensionAgency.replaceChildren();
  if (state.user.role === 0) {
    for (const agency of state.agencies) {
      const option = document.createElement("option");
      option.value = String(agency.id);
      option.textContent = agency.name;
      els.extensionAgency.append(option);
    }
  }

  const { extensions } = await requestJson(`/api/extensions${extensionAgencyQuery()}`);
  state.extensions = extensions || [];
  renderExtensions();
};

const renderExtensions = () => {
  els.extensionTableBody.replaceChildren();

  if (state.extensions.length === 0) {
    const row = document.createElement("tr");
    addCell(row, "Aucun lien", "strong-cell");
    addCell(row, "-");
    addCell(row, "-");
    addCell(row, "-");
    addCell(row, "-");
    els.extensionTableBody.append(row);
    return;
  }

  for (const extension of state.extensions) {
    const row = document.createElement("tr");
    addCell(row, extension.name, "strong-cell");
    addCell(row, extension.installUrl);
    const statusCell = document.createElement("td");
    statusCell.append(makeBadge(extension.isActive ? "Active" : "Inactive", extension.isActive ? "green" : "red"));
    row.append(statusCell);
    addCell(row, formatDate(extension.createdAt));

    const actions = document.createElement("td");
    actions.className = "action-cell";

    const toggle = document.createElement("button");
    toggle.className = extension.isActive ? "outline danger-text" : "outline success-text";
    toggle.dataset.extensionAction = "toggle";
    toggle.dataset.extensionId = String(extension.id);
    toggle.dataset.active = String(!extension.isActive);
    toggle.textContent = extension.isActive ? "Desactiver" : "Activer";
    actions.append(toggle);

    const edit = document.createElement("button");
    edit.className = "outline";
    edit.dataset.extensionAction = "edit";
    edit.dataset.extensionId = String(extension.id);
    edit.dataset.name = extension.name;
    edit.dataset.url = extension.installUrl;
    edit.textContent = "Modifier";
    actions.append(edit);

    const remove = document.createElement("button");
    remove.className = "outline danger-text";
    remove.dataset.extensionAction = "delete";
    remove.dataset.extensionId = String(extension.id);
    remove.dataset.name = extension.name;
    remove.textContent = "Supprimer";
    actions.append(remove);

    row.append(actions);
    els.extensionTableBody.append(row);
  }
};

const currentCategoryAgencyId = () => state.user?.role === 0 ? Number(els.categoryAgency.value) : undefined;

const categoryAgencyQuery = () => {
  const agencyId = currentCategoryAgencyId();
  return agencyId ? `?agencyId=${encodeURIComponent(agencyId)}` : "";
};

// Page d'administration (role 0/1 uniquement, deja filtre par showPage()):
// gere SES propres categories, jamais melangees a celles d'une autre agence.
const loadCategories = async () => {
  if (![0, 1].includes(state.user?.role)) {
    return;
  }

  if (state.user.role === 0 && state.agencies.length === 0) {
    await loadAgencies();
  }

  els.categoryAgencyLabel.hidden = state.user.role !== 0;
  els.categoryAgency.replaceChildren();
  if (state.user.role === 0) {
    for (const agency of state.agencies) {
      const option = document.createElement("option");
      option.value = String(agency.id);
      option.textContent = agency.name;
      els.categoryAgency.append(option);
    }
  }

  const { categories } = await requestJson(`/api/categories${categoryAgencyQuery()}`);
  state.categories = categories || [];
  renderCategories();
};

const renderCategories = () => {
  els.categoryTableBody.replaceChildren();

  if (state.categories.length === 0) {
    const row = document.createElement("tr");
    addCell(row, "Aucune categorie", "strong-cell");
    addCell(row, "-");
    addCell(row, "-");
    els.categoryTableBody.append(row);
    return;
  }

  for (const category of state.categories) {
    const row = document.createElement("tr");
    addCell(row, category.name, "strong-cell");
    addCell(row, formatDate(category.createdAt));

    const actions = document.createElement("td");
    actions.className = "action-cell";

    const rename = document.createElement("button");
    rename.className = "outline";
    rename.dataset.categoryAction = "rename";
    rename.dataset.categoryId = String(category.id);
    rename.dataset.name = category.name;
    rename.textContent = "Modifier";
    actions.append(rename);

    const remove = document.createElement("button");
    remove.className = "outline danger-text";
    remove.dataset.categoryAction = "delete";
    remove.dataset.categoryId = String(category.id);
    remove.dataset.name = category.name;
    remove.textContent = "Supprimer";
    actions.append(remove);

    row.append(actions);
    els.categoryTableBody.append(row);
  }
};

// Dropdown "Categorie" du formulaire Bot: accessible aux 3 roles (role 2
// UTILISE les categories de SA propre agence sans jamais les administrer) -
// toujours l'agence de l'utilisateur connecte, jamais un melange entre
// agences.
const loadBotFormCategoryOptions = async () => {
  const previousValue = els.botFormCategory.value;
  let categories = [];
  try {
    ({ categories } = await requestJson("/api/categories"));
  } catch {
    categories = [];
  }

  els.botFormCategory.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.textContent = "Choisir une categorie";
  els.botFormCategory.append(placeholder);

  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category.name;
    option.textContent = category.name;
    els.botFormCategory.append(option);
  }

  if (categories.some((category) => category.name === previousValue)) {
    els.botFormCategory.value = previousValue;
  } else {
    placeholder.selected = true;
  }
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
      user.email || "",
      roleLabel(user.role),
      user.is_active ? "active" : "inactive"
    ].join(" ").toLowerCase();
    return text.includes(query);
  });

  for (const user of visibleUsers) {
    const row = document.createElement("tr");
    addCell(row, user.login, "strong-cell");
    addCell(row, user.name);
    addCell(row, user.email || "-");

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

    const editEmail = document.createElement("button");
    editEmail.className = "outline";
    editEmail.dataset.userAction = "edit-email";
    editEmail.dataset.userId = String(user.id);
    editEmail.dataset.currentEmail = user.email || "";
    editEmail.textContent = "Modifier email";
    actions.append(editEmail);

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
  els.profileEmail.textContent = user.email || "Non renseigne";
  els.profileRole.textContent = roleLabel(user.role);
  els.profileStatus.textContent = user.is_active ? "Active" : "Inactive";
  els.profileLastLogin.textContent = formatDate(user.last_login_at);
  els.profileCreated.textContent = formatDate(user.created_at);
};

const updateBotStatus = (status) => {
  state.botStatus = status;
  els.dashboardStatus.textContent = status;
};

const statusLabel = (status) => ({
  created: "Cree",
  starting: "Demarrage",
  waiting: "En attente",
  monitoring: "Surveillance",
  paused: "En pause",
  stopped: "Arrete",
  error: "Erreur"
}[status] || status);

const statusPillClass = (status) => ({
  monitoring: "green",
  waiting: "blue",
  starting: "blue",
  created: "blue",
  paused: "amber",
  error: "red",
  stopped: "red"
}[status] || "blue");

const profileStatusLabel = (status) => ({
  not_configured: "Non configure",
  pending: "A preparer",
  preparing: "Preparation",
  intervention_required: "Intervention requise",
  ready: "Pret",
  error: "Erreur"
}[status] || status);

const profileStatusClass = (status) => ({
  ready: "green",
  preparing: "blue",
  intervention_required: "amber",
  pending: "amber",
  error: "red",
  not_configured: "blue"
}[status] || "blue");

const dashboardPrompt = () => {
  const sessionId = Object.keys(state.prompts)[0] || null;
  dashboardPromptSessionId = sessionId;
  const message = sessionId ? state.prompts[sessionId] : "";
  const session = sessionId ? state.sessions.find((item) => item.id === sessionId) : null;
  const visibleMessage = message && session ? `${session.name}: ${message}` : message;
  els.dashboardPromptText.textContent = visibleMessage || "Aucune action en attente.";
  els.dashboardContinue.disabled = !message;
};

const renderDashboardSummary = () => {
  const first = state.sessions[0];
  updateBotStatus(first ? statusLabel(first.status) : "Pret");
  els.dashboardChromePort.textContent = first ? String(first.port) : "-";
};

const renderBotTable = () => {
  const query = els.botSearch.value.trim().toLowerCase();
  els.botTableBody.replaceChildren();

  const visibleSessions = state.sessions.filter((session) => {
    const text = [session.name, session.login].join(" ").toLowerCase();
    return text.includes(query);
  });

  for (const session of visibleSessions) {
    const row = document.createElement("tr");
    const needsValidation = Boolean(state.prompts[session.id]);
    if (needsValidation) {
      row.className = "needs-validation";
    }

    addCell(row, session.name || session.id, "strong-cell");
    addCell(row, session.category || "-");
    addCell(row, session.login || "-");

    const statusCell = document.createElement("td");
    statusCell.append(makeBadge(statusLabel(session.status), statusPillClass(session.status)));
    row.append(statusCell);

    addCell(row, String(session.port));

    const actions = document.createElement("td");
    actions.className = "action-cell";

    if (needsValidation) {
      const validate = document.createElement("button");
      validate.className = "primary";
      validate.dataset.sessionAction = "validate";
      validate.dataset.sessionId = session.id;
      validate.textContent = "Valider";
      actions.append(validate);
    }

    if (session.status === "monitoring") {
      const pause = document.createElement("button");
      pause.className = "outline";
      pause.dataset.sessionAction = "pause";
      pause.dataset.sessionId = session.id;
      pause.textContent = "Pause";
      actions.append(pause);
    } else if (session.status === "paused") {
      const resume = document.createElement("button");
      resume.className = "outline success-text";
      resume.dataset.sessionAction = "resume";
      resume.dataset.sessionId = session.id;
      resume.textContent = "Reprendre";
      actions.append(resume);
    }

    const stop = document.createElement("button");
    stop.className = "outline danger-text";
    stop.dataset.sessionAction = "stop";
    stop.dataset.sessionId = session.id;
    stop.textContent = "Arreter";
    actions.append(stop);

    row.append(actions);
    els.botTableBody.append(row);
  }

  renderDashboardSummary();
  dashboardPrompt();
};

const mergeSession = (session) => {
  const index = state.sessions.findIndex((item) => item.id === session.id);
  if (index >= 0) {
    state.sessions[index] = { ...state.sessions[index], ...session };
  } else {
    state.sessions.unshift(session);
  }

  renderBotTable();
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

const continueBot = (sessionId) => {
  if (!sessionId) {
    return;
  }

  delete state.prompts[sessionId];
  socket.emit("continue-bot", { sessionId });
  renderBotTable();
};

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.loginError.textContent = "";

  try {
    const { user, billing } = await requestJson("/api/login", {
      method: "POST",
      body: JSON.stringify({
        login: els.loginInput.value,
        password: els.passwordInput.value
      })
    });
    setAuthenticated(user);
    applyBillingState(billing);
    socket.disconnect();
    socket.connect();
    await routeAfterAuth();
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
els.billingLockLogout.addEventListener("click", logout);

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

  // CHANTIER CIBLE (gestion des echeances et impayes des agences): route
  // DEDIEE /api/agencies/:id/billing - jamais le PATCH generique ci-dessus
  // (son COALESCE ne peut pas exprimer "remettre explicitement a NULL").
  const saveDateButton = event.target.closest("button[data-save-next-payment-date]");
  if (saveDateButton) {
    const input = saveDateButton.closest("tr").querySelector('input[data-role="next-payment-date-input"]');
    await requestJson(`/api/agencies/${saveDateButton.dataset.saveNextPaymentDate}/billing`, {
      method: "PATCH",
      body: JSON.stringify({ nextPaymentDate: input.value || null })
    });
    await loadAgencies();
    return;
  }

  const grantOverrideButton = event.target.closest("button[data-grant-override]");
  if (grantOverrideButton) {
    const input = grantOverrideButton.closest("tr").querySelector('input[data-role="override-until-input"]');
    if (!input.value) {
      return;
    }
    await requestJson(`/api/agencies/${grantOverrideButton.dataset.grantOverride}/billing`, {
      method: "PATCH",
      body: JSON.stringify({ overrideUntil: input.value })
    });
    await loadAgencies();
    return;
  }

  const removeOverrideButton = event.target.closest("button[data-remove-override]");
  if (removeOverrideButton) {
    await requestJson(`/api/agencies/${removeOverrideButton.dataset.removeOverride}/billing`, {
      method: "PATCH",
      body: JSON.stringify({ overrideUntil: null })
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

els.extensionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.extensionMessage.textContent = "";
  els.extensionMessage.className = "form-message";

  try {
    await requestJson("/api/extensions", {
      method: "POST",
      body: JSON.stringify({
        agencyId: currentExtensionAgencyId(),
        name: els.extensionName.value.trim(),
        installUrl: els.extensionUrl.value.trim(),
        isActive: els.extensionActive.value === "true"
      })
    });
    els.extensionForm.reset();
    els.extensionActive.value = "true";
    els.extensionMessage.textContent = "Lien d'extension ajoute.";
    els.extensionMessage.classList.add("success");
    await loadExtensions();
  } catch (error) {
    els.extensionMessage.textContent = error.message;
    els.extensionMessage.classList.add("error");
  }
});

els.categoryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.categoryMessage.textContent = "";
  els.categoryMessage.className = "form-message";

  try {
    await requestJson("/api/categories", {
      method: "POST",
      body: JSON.stringify({
        agencyId: currentCategoryAgencyId(),
        name: els.categoryName.value.trim()
      })
    });
    els.categoryForm.reset();
    els.categoryMessage.textContent = "Categorie ajoutee.";
    els.categoryMessage.classList.add("success");
    await loadCategories();
  } catch (error) {
    els.categoryMessage.textContent = error.message;
    els.categoryMessage.classList.add("error");
  }
});

els.categoryTableBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-category-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.categoryAction;
  const categoryId = button.dataset.categoryId;
  els.categoryMessage.textContent = "";
  els.categoryMessage.className = "form-message";

  try {
    if (action === "delete") {
      const name = button.dataset.name;
      const confirmation = window.confirm(`Supprimer la categorie "${name}" ? Les bots deja demarres avec cette categorie ne sont jamais affectes.`);
      if (!confirmation) {
        return;
      }

      await requestJson(`/api/categories/${categoryId}${categoryAgencyQuery()}`, {
        method: "DELETE"
      });
      els.categoryMessage.textContent = "Categorie supprimee.";
      els.categoryMessage.classList.add("success");
    }

    if (action === "rename") {
      const name = window.prompt("Nom de la categorie", button.dataset.name || "");
      if (name === null) {
        return;
      }

      await requestJson(`/api/categories/${categoryId}`, {
        method: "PATCH",
        body: JSON.stringify({
          agencyId: currentCategoryAgencyId(),
          name
        })
      });
      els.categoryMessage.textContent = "Categorie modifiee.";
      els.categoryMessage.classList.add("success");
    }

    await loadCategories();
  } catch (error) {
    els.categoryMessage.textContent = error.message;
    els.categoryMessage.classList.add("error");
  }
});

els.extensionTableBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-extension-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.extensionAction;
  const extensionId = button.dataset.extensionId;
  els.extensionMessage.textContent = "";
  els.extensionMessage.className = "form-message";

  try {
    if (action === "delete") {
      const name = button.dataset.name;
      const confirmation = window.confirm(`Supprimer le lien d'extension "${name}" ?`);
      if (!confirmation) {
        return;
      }

      await requestJson(`/api/extensions/${extensionId}${extensionAgencyQuery()}`, {
        method: "DELETE"
      });
      els.extensionMessage.textContent = "Lien supprime.";
      els.extensionMessage.classList.add("success");
    }

    if (action === "toggle") {
      await requestJson(`/api/extensions/${extensionId}`, {
        method: "PATCH",
        body: JSON.stringify({
          agencyId: currentExtensionAgencyId(),
          isActive: button.dataset.active === "true"
        })
      });
      els.extensionMessage.textContent = "Statut modifie.";
      els.extensionMessage.classList.add("success");
    }

    if (action === "edit") {
      const name = window.prompt("Nom de l'extension", button.dataset.name || "");
      if (name === null) {
        return;
      }

      const installUrl = window.prompt("Lien d'installation", button.dataset.url || "");
      if (installUrl === null) {
        return;
      }

      await requestJson(`/api/extensions/${extensionId}`, {
        method: "PATCH",
        body: JSON.stringify({
          agencyId: currentExtensionAgencyId(),
          name,
          installUrl
        })
      });
      els.extensionMessage.textContent = "Lien modifie.";
      els.extensionMessage.classList.add("success");
    }

    await loadExtensions();
  } catch (error) {
    els.extensionMessage.textContent = error.message;
    els.extensionMessage.classList.add("error");
  }
});

els.extensionAgency.addEventListener("change", () => {
  void loadExtensions();
});

els.categoryAgency.addEventListener("change", () => {
  void loadCategories();
});

els.settingsAgency.addEventListener("change", () => {
  void loadMonitoringSettings();
});

els.userForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const body = {
    login: els.userLogin.value.trim(),
    name: els.userName.value.trim(),
    email: els.userEmail.value.trim(),
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

  try {
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

    if (action === "edit-email") {
      const nextEmail = window.prompt("Email notifications utilisateur", button.dataset.currentEmail || "");
      if (nextEmail === null) {
        return;
      }

      await requestJson(`/api/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ email: nextEmail.trim() })
      });
    }

    await loadUsers();
  } catch (error) {
    window.alert(error.message);
  }
});

bindCopyButton(els.copyPassword, els.temporaryPassword);

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

// Compose les deux sources independantes de blocage du bouton Demarrer: le
// quota de clients actifs (logique historique) et, si agentUi.js est charge
// et actif, l'absence d'agent local connecte. Ni l'une ni l'autre ne doit
// pouvoir reactiver le bouton a la place de l'autre: le calcul se refait a
// chaque fois a partir des deux conditions.
//
// Le quota rend le bouton reellement indisponible (disabled): il n'y a rien
// d'utile a communiquer de plus. L'absence d'agent, elle, ne doit desactiver
// le bouton que VISUELLEMENT: un clic doit rester possible pour ouvrir la
// modale explicative "RendezBot Agent requis" (sinon l'evenement submit ne
// se declenche jamais et cette modale ne peut jamais s'afficher).
const updateStartBotAvailability = () => {
  const quotaOk = state.agencyMaxClients === null || state.agencyActiveCount < state.agencyMaxClients;
  const agentOk = !(window.AgentUi && typeof window.AgentUi.canStartBot === "function") || window.AgentUi.canStartBot();
  els.startBot.disabled = !quotaOk;
  els.startBot.classList.toggle("agent-blocked", quotaOk && !agentOk);
  // Le serveur reste seul juge (agencyActiveCount/agencyMaxClients viennent
  // deja de l'evenement "maintenance", jamais recalcules depuis le tableau
  // HTML): ce message est purement informatif, le vrai refus a
  // START_BOT reste toujours applique cote serveur meme si ce texte
  // n'apparaissait pas.
  els.botQuotaMessage.hidden = quotaOk;
  if (!quotaOk) {
    els.botQuotaMessage.textContent = `Limite de bots actifs atteinte (${state.agencyActiveCount}/${state.agencyMaxClients}).`;
  }
};

els.botForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (window.AgentUi && typeof window.AgentUi.canStartBot === "function" && !window.AgentUi.canStartBot()) {
    window.AgentUi.showAgentRequiredModal();
    return;
  }

  els.startBot.disabled = true;

  const botName = els.botFormName.value.trim();
  const category = els.botFormCategory.value.trim();
  const login = els.botFormLogin.value.trim();
  const password = els.botFormPassword.value;
  // Un seul identifiant par clic legitime: une repetition du meme
  // clientRequestId (retry reseau, double-clic, nouvelle selection d'agent
  // apres AGENT_SELECTION_REQUIRED) ne doit jamais creer une seconde commande
  // cote serveur (idempotence, section 7 Phase 3).
  const clientRequestId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  state.lastBotSubmission = { botName, category, login, password, clientRequestId };
  socket.emit("start-bot", { botName, category, login, password, clientRequestId });
  els.botForm.reset();
  els.botFormName.placeholder = `Bot ${state.agencyActiveCount + 2}`;

  window.setTimeout(updateStartBotAvailability, 1500);
});

els.dashboardContinue.addEventListener("click", () => continueBot(dashboardPromptSessionId));

els.botSearch.addEventListener("input", renderBotTable);

els.botTableBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-session-action]");
  if (!button) {
    return;
  }

  const sessionId = button.dataset.sessionId;
  const action = button.dataset.sessionAction;

  if (action === "validate") {
    continueBot(sessionId);
  } else if (action === "pause") {
    socket.emit("pause-bot", { sessionId });
  } else if (action === "resume") {
    socket.emit("resume-bot", { sessionId });
  } else if (action === "stop") {
    socket.emit("stop-bot", { sessionId });
  }
});

els.clearLogs.addEventListener("click", () => {
  state.logs = [];
  renderLogs();
});

els.stopAllSessions.addEventListener("click", () => socket.emit("stop-all-sessions"));
els.shutdownServer.addEventListener("click", () => socket.emit("shutdown-server"));

socket.on("bot-session", (session) => {
  mergeSession(session);
  updateStartBotAvailability();
});

socket.on("bot-status", ({ sessionId, status, code, billing }) => {
  // CHANTIER CIBLE (gestion des echeances et impayes des agences): start-bot
  // passe par Socket.IO, jamais requestJson - la reconnaissance du code
  // machine PAYMENT_SUSPENDED doit donc AUSSI etre geree ici pour rester
  // "globale" (pas seulement HTTP).
  if (code === "PAYMENT_SUSPENDED") {
    showBillingLockScreen(billing);
  }

  const session = state.sessions.find((item) => item.id === sessionId);
  if (session) {
    session.status = status;
  }

  if (status === "stopped" || status === "error") {
    delete state.prompts[sessionId];
    state.sessions = state.sessions.filter((item) => item.id !== sessionId);
  }

  renderBotTable();
  updateStartBotAvailability();
});

socket.on("bot-prompt", ({ sessionId, message }) => {
  if (!sessionId) {
    return;
  }

  if (message) {
    state.prompts[sessionId] = message;
  } else {
    delete state.prompts[sessionId];
  }

  renderBotTable();
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
  els.botFormName.placeholder = `Bot ${count + 1}`;
  updateStartBotAvailability();
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
  renderBotTable();
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

// Rafraichissement periodique leger de l'etat de facturation en session (ex.
// une agence suspendue par le scheduler, ou reactivee par l'admin, pendant
// qu'un utilisateur reste connecte) - jamais pour role 0 (toujours
// accessAllowed=true, aucun etat a suivre). Ignore silencieusement les echecs
// reseau: requestJson gere deja elle-meme le cas PAYMENT_SUSPENDED explicite.
const BILLING_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const refreshBillingState = async () => {
  if (!state.user || state.user.role === 0) {
    return;
  }
  try {
    const { billing } = await requestJson("/api/me");
    applyBillingState(billing);
  } catch {
    // Suspension deja geree par requestJson; autres erreurs (reseau) ignorees.
  }
};

setInterval(refreshBillingState, BILLING_REFRESH_INTERVAL_MS);

const boot = async () => {
  try {
    const { user, billing } = await requestJson("/api/me");
    setAuthenticated(user);
    applyBillingState(billing);
    await routeAfterAuth();
  } catch {
    els.loginScreen.hidden = false;
    els.appLayout.hidden = true;
  }
};

window.RendezBotApp = {
  state,
  els,
  socket,
  requestJson,
  showPage,
  formatDate,
  makeBadge,
  addCell,
  bindCopyButton,
  updateStartBotAvailability,
  $,
  $$
};

void boot();
