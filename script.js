"use strict";

/* Coders Club PS Selector — frontend logic.
   Security note: nothing in this file is trusted for authorization. The database
   decides who may roll, who is an administrator, and what each user can read. */

(() => {
  /* ------------------------------------------------------------------ *
   * Config + Supabase client
   * ------------------------------------------------------------------ */
  const cfg = window.APP_CONFIG || {};
  const PLACEHOLDER = /YOUR-|your-project/i;
  const EMAIL_DOMAIN = cfg.EMAIL_DOMAIN || "coders-club.example";
  const PASSWORD_PREFIX = typeof cfg.PASSWORD_PREFIX === "string" ? cfg.PASSWORD_PREFIX : "";

  const configMissing =
    !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
    PLACEHOLDER.test(cfg.SUPABASE_URL) || PLACEHOLDER.test(cfg.SUPABASE_PUBLISHABLE_KEY);
  const libraryMissing = !window.supabase || typeof window.supabase.createClient !== "function";

  const sb = !configMissing && !libraryMissing
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      })
    : null;

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Build DOM safely (text is always inserted as text, never as HTML). */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key === "dataset") Object.assign(el.dataset, value);
        else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
        else if (value === true) el.setAttribute(key, "");
        else el.setAttribute(key, String(value));
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const fmtDateTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : dateTimeFmt.format(d); };

  function setLoading(button, on, busyText) {
    if (!button) return;
    if (on) {
      if (button.dataset.label == null) button.dataset.label = button.textContent;
      button.disabled = true;
      button.classList.add("is-loading");
      button.setAttribute("aria-busy", "true");
      if (busyText) button.textContent = busyText;
    } else {
      button.disabled = false;
      button.classList.remove("is-loading");
      button.removeAttribute("aria-busy");
      if (button.dataset.label != null) { button.textContent = button.dataset.label; delete button.dataset.label; }
    }
  }

  /* ------------------------------------------------------------------ *
   * Toasts
   * ------------------------------------------------------------------ */
  const toastRoot = $("#toasts");
  function toast(message, type = "info", ms = 4500) {
    const el = h("div", { class: `toast toast--${type}`, role: type === "error" ? "alert" : "status" }, message);
    el.addEventListener("click", () => el.remove());
    toastRoot.append(el);
    while (toastRoot.children.length > 3) toastRoot.firstElementChild.remove();
    setTimeout(() => el.remove(), ms);
  }

  /* ------------------------------------------------------------------ *
   * Error translation (friendly, never leaks details)
   * ------------------------------------------------------------------ */
  function classifyError(err) {
    const msg = String((err && (err.message || err.error_description || err.details)) || "");
    const code = err && (err.code || err.status);
    if (!navigator.onLine || (err && err.status === 0) ||
        /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg)) {
      return { kind: "network", message: "Can't reach the server. Check your internet connection and try again." };
    }
    if (code === "PGRST202" || code === "42883" || /could not find the function|schema cache/i.test(msg)) {
      return { kind: "config", message: "The database isn't set up correctly yet. Please tell the organisers." };
    }
    if (/not_authenticated|jwt expired|invalid jwt|invalid token/i.test(msg) || (err && err.status === 401)) {
      return { kind: "session", message: "Your session has expired. Please sign in again." };
    }
    if (code === 429 || code === "over_request_rate_limit" || /rate limit|too many/i.test(msg)) {
      return { kind: "rate", message: "Too many requests. Please wait a minute and try again." };
    }
    if (code === "42501" || /forbidden|permission denied|not_a_team_account/i.test(msg)) {
      return { kind: "forbidden", message: "You don't have permission to do that." };
    }
    if (/unknown_team/i.test(msg)) {
      return { kind: "unknown_team", message: "That team doesn't exist." };
    }
    return { kind: "unknown", message: "Something went wrong. Please try again." };
  }

  /** Toast a friendly error; sign out if the session is no longer valid. */
  async function handleError(err, fallback) {
    console.error("[PS Selector]", err && (err.code || err.status), err && err.message);
    const info = classifyError(err);
    toast(info.kind === "unknown" && fallback ? fallback : info.message, "error", 6000);
    if (info.kind === "session") await resetToLogin(info.message);
    return info;
  }

  /* ------------------------------------------------------------------ *
   * Views
   * ------------------------------------------------------------------ */
  const views = { boot: $("#view-boot"), login: $("#view-login"), student: $("#view-student"), admin: $("#view-admin") };
  let currentView = "boot";
  const TITLES = { boot: "Coders Club PS Selector", login: "Sign in · Coders Club PS Selector", student: "Your challenge · Coders Club PS Selector", admin: "Control room · Coders Club PS Selector" };

  function showView(name) {
    currentView = name;
    for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
    document.title = TITLES[name];
    window.scrollTo(0, 0);
    const heading = views[name].querySelector("[data-focus]");
    if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus({ preventScroll: true }); }
  }

  /* ------------------------------------------------------------------ *
   * Dice (CSS 3D; the animation only ever lands on a result from the database)
   * ------------------------------------------------------------------ */
  const FACE_PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  // [rotateX, rotateY] that brings each face toward the viewer
  const FACE_ORIENT = { 1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [0, 180] };

  function createDice({ small = false } = {}) {
    const diceEl = h("div", { class: "dice" });
    for (let n = 1; n <= 6; n += 1) {
      const face = h("div", { class: "dice__face", dataset: { face: n } });
      for (const cell of FACE_PIPS[n]) {
        face.append(h("span", { class: "pip", style: `grid-row:${Math.ceil(cell / 3)};grid-column:${((cell - 1) % 3) + 1}` }));
      }
      diceEl.append(face);
    }
    const root = h("div", { class: `dice-scene${small ? " dice-scene--sm" : ""}`, "aria-hidden": "true" },
      h("div", { class: "dice-shadow" }),
      h("div", { class: "dice-hop" }, h("div", { class: "dice-tilt" }, diceEl)));

    let ax = 0, ay = 0, az = 0, timer = null;
    const apply = (ms, easing) => {
      diceEl.style.transition = ms ? `transform ${ms}ms ${easing}` : "none";
      diceEl.style.transform = `rotateX(${ax}deg) rotateY(${ay}deg) rotateZ(${az}deg)`;
    };
    const api = {
      root,
      show(n) { [ax, ay] = FACE_ORIENT[n]; az = 0; apply(0); },
      startRolling() {
        if (reduced()) return;
        root.classList.add("is-rolling");
        const step = () => {
          ax += 180 + Math.random() * 270; ay += 180 + Math.random() * 270; az += 90 + Math.random() * 180;
          apply(650, "linear");
          timer = setTimeout(step, 650);
        };
        step();
      },
      stopRolling() { clearTimeout(timer); timer = null; root.classList.remove("is-rolling"); },
      /** Spin forward and land exactly on face n. */
      settle(n) {
        if (reduced()) { api.show(n); return Promise.resolve(); }
        const [fx, fy] = FACE_ORIENT[n];
        const forward = (cur, target) => target + 360 * (Math.ceil((cur - target) / 360) + 1);
        ax = forward(ax, fx); ay = forward(ay, fy); az = forward(az, 0);
        apply(1400, "cubic-bezier(.18,.9,.25,1)");
        return sleep(1450);
      },
    };
    api.show(small ? 6 : 1);
    return api;
  }

  /* ------------------------------------------------------------------ *
   * Confirmation dialog
   * ------------------------------------------------------------------ */
  const dlg = $("#confirm-dialog");
  const dlgTitle = $("#dlg-title"), dlgBody = $("#dlg-body"), dlgConfirm = $("#dlg-confirm"), dlgCancel = $("#dlg-cancel");
  const dlgTypeWrap = $("#dlg-type-wrap"), dlgType = $("#dlg-type"), dlgTypeLabel = $("#dlg-type-label");

  function confirmDialog({ title, paragraphs = [], chip, confirmLabel, requireText }) {
    if (typeof dlg.showModal !== "function") {
      return Promise.resolve(window.confirm(`${title}\n\n${paragraphs.join("\n\n")}`));
    }
    return new Promise((resolve) => {
      dlgTitle.textContent = title;
      dlgBody.replaceChildren(...(chip ? [h("span", { class: "chip" }, chip)] : []), ...paragraphs.map((t) => h("p", null, t)));
      dlgConfirm.textContent = confirmLabel;
      dlgType.value = "";
      dlgTypeWrap.hidden = !requireText;
      if (requireText) {
        dlgTypeLabel.textContent = `Type ${requireText} to confirm`;
        dlgConfirm.disabled = true;
      } else {
        dlgConfirm.disabled = false;
      }
      const onType = () => { dlgConfirm.disabled = dlgType.value.trim().toUpperCase() !== requireText; };
      const onKey = (e) => { if (e.key === "Enter" && requireText && !dlgConfirm.disabled) { e.preventDefault(); dlg.close("confirm"); } };
      const onBackdrop = (e) => { if (e.target === dlg) dlg.close("cancel"); };
      const onConfirm = () => dlg.close("confirm");
      const onCancel = () => dlg.close("cancel");
      if (requireText) { dlgType.addEventListener("input", onType); dlgType.addEventListener("keydown", onKey); }
      dlg.addEventListener("click", onBackdrop);
      dlgConfirm.addEventListener("click", onConfirm);
      dlgCancel.addEventListener("click", onCancel);
      dlg.addEventListener("close", () => {
        dlgType.removeEventListener("input", onType); dlgType.removeEventListener("keydown", onKey);
        dlg.removeEventListener("click", onBackdrop);
        dlgConfirm.removeEventListener("click", onConfirm);
        dlgCancel.removeEventListener("click", onCancel);
        resolve(dlg.returnValue === "confirm");
      }, { once: true });
      dlg.returnValue = "";
      dlg.showModal();
      (requireText ? dlgType : dlgCancel).focus();
    });
  }

  /* ------------------------------------------------------------------ *
   * Login
   * ------------------------------------------------------------------ */
  const loginForm = $("#login-form"), usernameInput = $("#username"), passwordInput = $("#password");
  const loginError = $("#login-error"), loginSubmit = $("#login-submit"), togglePassword = $("#toggle-password");
  const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{1,31}$/;
  const toEmail = (username) => `${username.toLowerCase()}@${EMAIL_DOMAIN}`;

  // Courtesy rate limit in the browser (the real limit is Supabase Auth's server-side limit).
  const GUARD_KEY = "psel.loginGuard";
  let memGuard = { fails: 0, until: 0 };
  function readGuard() {
    try { return JSON.parse(localStorage.getItem(GUARD_KEY)) || memGuard; } catch { return memGuard; }
  }
  function writeGuard(g) {
    memGuard = g;
    try { localStorage.setItem(GUARD_KEY, JSON.stringify(g)); } catch { /* storage blocked: memory only */ }
  }
  function lockSecondsLeft() { return Math.max(0, Math.ceil((readGuard().until - Date.now()) / 1000)); }
  function registerFailure() {
    const g = readGuard();
    g.fails = (g.fails || 0) + 1;
    if (g.fails >= 5) g.until = Date.now() + Math.min(30 * 2 ** (g.fails - 5), 300) * 1000;
    writeGuard(g);
  }

  function showLoginError(message) { loginError.textContent = message; loginError.hidden = false; }
  function clearLoginError() { loginError.hidden = true; loginError.textContent = ""; }

  togglePassword.addEventListener("click", () => {
    const show = passwordInput.type === "password";
    passwordInput.type = show ? "text" : "password";
    togglePassword.textContent = show ? "Hide" : "Show";
    togglePassword.setAttribute("aria-pressed", String(show));
    togglePassword.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearLoginError();

    if (!sb) { showLoginError(setupProblemMessage()); return; }

    const wait = lockSecondsLeft();
    if (wait > 0) { showLoginError(`Too many attempts. Try again in ${wait} second${wait === 1 ? "" : "s"}.`); return; }

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username && !password) { showLoginError("Enter your username and password."); usernameInput.focus(); return; }
    if (!username) { showLoginError("Enter your username."); usernameInput.focus(); return; }
    if (!password) { showLoginError("Enter your password."); passwordInput.focus(); return; }
    if (!USERNAME_RE.test(username)) { showLoginError("That username isn't valid. Use your team ID, like T001."); usernameInput.focus(); return; }

    setLoading(loginSubmit, true, "Signing in");
    try {
      const { error } = await sb.auth.signInWithPassword({ email: toEmail(username), password: PASSWORD_PREFIX + password });
      if (error) {
        const info = classifyError(error);
        if (info.kind === "network" || info.kind === "rate" || info.kind === "config") { showLoginError(info.message); }
        else { registerFailure(); showLoginError("Incorrect username or password."); }
        return;
      }
      writeGuard({ fails: 0, until: 0 });
      const result = await enterApp();
      if (!result.ok) { await localSignOut(); showLoginError(result.message); }
      else { loginForm.reset(); }
    } catch (err) {
      showLoginError(classifyError(err).message);
    } finally {
      setLoading(loginSubmit, false);
    }
  });

  function setupProblemMessage() {
    if (configMissing) return "This site isn't connected to a database yet. The organisers need to finish setup (public/config.js).";
    return "Couldn't load a required library. Check your connection and reload the page.";
  }

  /* ------------------------------------------------------------------ *
   * Session + routing
   * ------------------------------------------------------------------ */
  let loginDice = null;
  function showLogin(message) {
    if (!loginDice) { loginDice = createDice({ small: true }); $("#login-dice").append(loginDice.root); }
    showView("login");
    if (message) showLoginError(message); else clearLoginError();
    if (!sb) showLoginError(setupProblemMessage());
  }

  async function localSignOut() {
    try { await sb.auth.signOut({ scope: "local" }); } catch { /* ignore */ }
  }

  async function resetToLogin(message) {
    if (sb) await localSignOut();
    studentReset();
    adminReset();
    showLogin(message);
  }

  /** Loads the account from the database and opens the right dashboard. */
  async function enterApp() {
    const { data, error } = await sb.rpc("get_my_state");
    if (error) {
      console.error("[PS Selector]", error.code, error.message);
      return { ok: false, message: classifyError(error).message };
    }
    if (!data || !data.role) return { ok: false, message: "This account isn't set up for the PS Selector. Please contact the organisers." };
    if (data.role === "admin") { await showAdmin(data); return { ok: true }; }
    showStudent(data);
    return { ok: true };
  }

  async function logout(button) {
    setLoading(button, true);
    await resetToLogin();
    setLoading(button, false);
  }
  $("#student-logout").addEventListener("click", (e) => logout(e.currentTarget));
  $("#admin-logout").addEventListener("click", (e) => logout(e.currentTarget));

  /* ------------------------------------------------------------------ *
   * Student dashboard
   * ------------------------------------------------------------------ */
  const rollBtn = $("#roll-btn"), rollLabel = $("#roll-label"), rollStatus = $("#roll-status");
  const rollPanel = $("#roll-panel"), resultPanel = $("#result-panel");
  let studentDice = null, studentTeam = null, rolling = false;

  function setRollStatus(text, isError = false) {
    rollStatus.textContent = text;
    rollStatus.classList.toggle("is-error", isError);
  }
  const psNumber = (id) => Math.min(6, Math.max(1, parseInt(String(id).replace(/\D/g, ""), 10) || 1));

  function studentReset() {
    studentDice = null; studentTeam = null; rolling = false;
    $("#dice-mount").replaceChildren();
    resultPanel.hidden = true; rollPanel.hidden = false;
    setRollStatus("");
  }

  function showStudent(state) {
    studentReset();
    studentTeam = state.team_code;
    $("#student-team").textContent = studentTeam;
    $("#student-welcome").textContent = studentTeam;
    studentDice = createDice();
    $("#dice-mount").append(studentDice.root);
    if (state.assignment) renderLocked(state.assignment.problem_statement_id, { animate: false });
    else renderRollable();
    showView("student");
  }

  function renderRollable() {
    resultPanel.hidden = true; rollPanel.hidden = false;
    rollBtn.disabled = false; rollBtn.classList.remove("is-loading"); rollBtn.removeAttribute("aria-busy");
    rollLabel.textContent = "ROLL THE DICE 🎲";
    studentDice.show(1);
  }

  function renderLocked(psId, { animate }) {
    studentDice.show(psNumber(psId));
    rollPanel.hidden = true;
    $("#result-ps").textContent = psId;
    $("#result-team").textContent = studentTeam;
    resultPanel.classList.toggle("no-anim", !animate);
    resultPanel.hidden = false;
    if (animate) resultPanel.focus({ preventScroll: false });
  }

  rollBtn.addEventListener("click", async () => {
    if (rolling || !sb) return;
    rolling = true;
    rollBtn.disabled = true;
    rollBtn.classList.add("is-loading");
    rollBtn.setAttribute("aria-busy", "true");
    rollLabel.textContent = "Rolling";
    setRollStatus("Finding your challenge...");

    const startedAt = performance.now();
    studentDice.startRolling();

    // The database picks and saves the result. The animation only waits for it.
    let result = null, failure = null;
    try {
      const { data, error } = await sb.rpc("roll_problem_statement");
      if (error) throw error;
      result = data;
    } catch (err) { failure = err; }

    await sleep(Math.max(0, (reduced() ? 600 : 2400) - (performance.now() - startedAt)));
    studentDice.stopRolling();

    if (failure) {
      rolling = false;
      renderRollable();
      const info = await handleError(failure, "Couldn't complete your roll. Please try again.");
      if (info.kind !== "session") setRollStatus(info.message, true);
      return;
    }
    if (!result || result.status === "full") {
      rolling = false;
      renderRollable();
      rollLabel.textContent = "TRY AGAIN 🎲";
      setRollStatus("Every problem statement is taken right now. Please tell the organisers.", true);
      return;
    }

    await studentDice.settle(psNumber(result.problem_statement_id));
    setRollStatus("");
    renderLocked(result.problem_statement_id, { animate: true });
    if (result.status === "existing") toast("You already had an assignment. Showing your saved result.");
    rolling = false;
  });

  // If an administrator changes this team's assignment while the page is open,
  // pick that up when the student returns to the tab.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || currentView !== "student" || rolling || !sb) return;
    const { data, error } = await sb.rpc("get_my_state");
    if (error || !data || data.role !== "team") return;
    const shown = resultPanel.hidden ? null : $("#result-ps").textContent;
    const saved = data.assignment ? data.assignment.problem_statement_id : null;
    if (shown === saved) return;
    if (saved) renderLocked(saved, { animate: false }); else { renderRollable(); setRollStatus(""); }
  });

  /* ------------------------------------------------------------------ *
   * Administrator dashboard
   * ------------------------------------------------------------------ */
  const admin = { data: null, tab: "overview", busy: false, filters: { q: "", status: "all", ps: "all" }, psOptionsBuilt: false };
  const refreshBtn = $("#admin-refresh");

  function adminReset() {
    admin.data = null; admin.tab = "overview"; admin.psOptionsBuilt = false;
    admin.filters = { q: "", status: "all", ps: "all" };
    $("#filter-q").value = ""; $("#filter-status").value = "all";
    $("#filter-ps").replaceChildren(h("option", { value: "all" }, "All"));
    $("#teams-body").replaceChildren(); $("#ps-grid").replaceChildren(); $("#activity-list").replaceChildren();
    selectTab("overview", false);
  }

  async function showAdmin() {
    adminReset();
    showView("admin");
    await loadAdmin();
  }

  async function fetchOverview() {
    const { data, error } = await sb.rpc("admin_get_overview");
    if (error) throw error;
    return data;
  }

  async function loadAdmin() {
    if (admin.busy) return;
    admin.busy = true;
    setLoading(refreshBtn, true);
    try {
      admin.data = await fetchOverview();
      renderAdmin();
      $("#admin-updated").textContent = `Updated ${timeFmt.format(new Date())}`;
      if (admin.tab === "activity") await loadActivity();
    } catch (err) {
      await handleError(err, "Couldn't load the dashboard.");
    } finally {
      admin.busy = false;
      setLoading(refreshBtn, false);
    }
  }
  refreshBtn.addEventListener("click", loadAdmin);

  // Tabs ---------------------------------------------------------------
  const tabs = $$(".tab");
  function selectTab(name, focus = true) {
    admin.tab = name;
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      $(`#panel-${tab.dataset.tab}`).hidden = !on;
      if (on && focus) tab.focus();
    }
  }
  for (const tab of tabs) {
    tab.addEventListener("click", async () => { selectTab(tab.dataset.tab, false); if (tab.dataset.tab === "activity") await loadActivity(); });
    tab.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(tab);
      let next = null;
      if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); next.click(); next.focus(); }
    });
  }

  // Render --------------------------------------------------------------
  function renderAdmin() {
    const d = admin.data;
    $("#stat-total").textContent = d.total_teams;
    $("#stat-assigned").textContent = d.assigned_teams;
    $("#stat-unassigned").textContent = d.unassigned_teams;
    $("#stat-remaining").textContent = d.remaining_slots;
    renderCards(d.problem_statements);
    buildPsFilter(d.problem_statements);
    renderTable();
  }

  const badgeClass = (status) => (status === "Full" ? "badge--full" : status === "Almost Full" ? "badge--warn" : "badge--ok");

  function renderCards(list) {
    const fills = [];
    const cards = list.map((p) => {
      const pct = Math.min(100, Math.round((p.active_count / p.max_capacity) * 100));
      const fill = h("div", {
        class: `bar__fill${p.status === "Full" ? " is-full" : p.status === "Almost Full" ? " is-warn" : ""}`,
      });
      fills.push([fill, pct]);
      return h("article", { class: "ps-card", "aria-label": p.id },
        h("div", { class: "ps-card__top" },
          h("h3", { class: "ps-card__id" }, p.id),
          h("span", { class: `badge ${badgeClass(p.status)}` }, p.status)),
        h("p", { class: "ps-card__count" }, `${p.active_count} / ${p.max_capacity} teams`),
        h("div", { class: "bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": p.max_capacity, "aria-valuenow": p.active_count, "aria-label": `${p.id} capacity used` }, fill),
        h("p", { class: "muted" }, `${p.remaining} slot${p.remaining === 1 ? "" : "s"} remaining`));
    });
    $("#ps-grid").replaceChildren(...cards);
    // set widths on the next frame so the bars animate in
    requestAnimationFrame(() => requestAnimationFrame(() => { for (const [el, pct] of fills) el.style.width = `${pct}%`; }));
  }

  function buildPsFilter(list) {
    const select = $("#filter-ps");
    const wanted = list.map((p) => p.id).join(",");
    if (select.dataset.built === wanted) return;
    select.replaceChildren(h("option", { value: "all" }, "All"), ...list.map((p) => h("option", { value: p.id }, p.id)));
    select.value = admin.filters.ps;
    select.dataset.built = wanted;
  }

  function filteredTeams() {
    const { q, status, ps } = admin.filters;
    const needle = q.trim().toLowerCase();
    return admin.data.teams.filter((t) =>
      (!needle || t.team_code.toLowerCase().includes(needle)) &&
      (status === "all" || (status === "assigned") === t.assigned) &&
      (ps === "all" || t.problem_statement_id === ps));
  }

  function renderTable() {
    const all = admin.data.teams;
    const rows = filteredTeams();
    $("#teams-count").textContent = `Showing ${rows.length} of ${all.length} teams`;
    $("#table-wrap").hidden = rows.length === 0;
    $("#teams-empty").hidden = rows.length !== 0;
    $("#teams-body").replaceChildren(...rows.map((t) =>
      h("tr", { role: "row" },
        h("th", { role: "rowheader", scope: "row", class: "cell-team" }, t.team_code),
        h("td", { role: "cell", "data-label": "Status" }, h("span", { class: `pill ${t.assigned ? "pill--on" : "pill--off"}` }, t.assigned ? "Assigned" : "Unassigned")),
        h("td", { role: "cell", "data-label": "Problem statement", class: "cell-ps" }, t.assigned ? t.problem_statement_id : "—"),
        h("td", { role: "cell", "data-label": "Assigned at" }, t.assigned_at ? fmtDateTime(t.assigned_at) : "—"),
        h("td", { role: "cell", "data-label": "Action" },
          t.assigned
            ? h("button", { class: "btn btn--danger btn--sm", type: "button", "aria-label": `Clear assignment for ${t.team_code}`, onclick: (e) => clearOne(t, e.currentTarget) }, "Clear Assignment")
            : h("span", { class: "muted" }, "—")))));
  }

  $("#filter-q").addEventListener("input", (e) => { admin.filters.q = e.target.value; if (admin.data) renderTable(); });
  $("#filter-status").addEventListener("change", (e) => { admin.filters.status = e.target.value; if (admin.data) renderTable(); });
  $("#filter-ps").addEventListener("change", (e) => { admin.filters.ps = e.target.value; if (admin.data) renderTable(); });
  $("#clear-filters").addEventListener("click", () => {
    admin.filters = { q: "", status: "all", ps: "all" };
    $("#filter-q").value = ""; $("#filter-status").value = "all"; $("#filter-ps").value = "all";
    renderTable();
  });

  // Destructive actions ------------------------------------------------
  async function clearOne(team, button) {
    const ok = await confirmDialog({
      title: "Clear this assignment?",
      chip: team.team_code,
      paragraphs: [
        `${team.team_code} currently has ${team.problem_statement_id}. Clearing it releases that slot and lets the team roll again.`,
        "The old assignment stays in the history.",
      ],
      confirmLabel: "Clear Assignment",
    });
    if (!ok) return;
    setLoading(button, true);
    try {
      const { data, error } = await sb.rpc("admin_clear_assignment", { p_team_code: team.team_code });
      if (error) throw error;
      toast(data && data.cleared ? `Cleared ${team.team_code}. ${team.problem_statement_id} has a free slot.` : `${team.team_code} had no active assignment.`, "success");
      await loadAdmin();
    } catch (err) {
      await handleError(err, "Couldn't clear that assignment.");
      setLoading(button, false);
    }
  }

  $("#clear-all").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    const total = admin.data ? admin.data.total_teams : 46;
    const ok = await confirmDialog({
      title: "Clear all assignments?",
      paragraphs: [
        `Every active assignment will be released. All ${total} teams will be able to roll again.`,
        "Team accounts and passwords are not deleted. Assignment history is kept and this action is written to the audit log.",
      ],
      confirmLabel: "Clear All Assignments",
      requireText: "CLEAR ALL",
    });
    if (!ok) return;
    setLoading(button, true);
    try {
      const { data, error } = await sb.rpc("admin_clear_all_assignments");
      if (error) throw error;
      toast(`All assignments cleared (${data ? data.cleared_count : 0} released).`, "success");
      await loadAdmin();
    } catch (err) {
      await handleError(err, "Couldn't clear all assignments.");
    } finally {
      setLoading(button, false);
    }
  });

  // Activity log -------------------------------------------------------
  async function loadActivity() {
    try {
      const { data, error } = await sb.rpc("admin_get_audit_logs", { p_limit: 100 });
      if (error) throw error;
      const items = data || [];
      $("#activity-empty").hidden = items.length > 0;
      $("#activity-list").hidden = items.length === 0;
      $("#activity-list").replaceChildren(...items.map((log) => {
        const det = log.details || {};
        const title = log.action === "clear_assignment" ? `Cleared ${log.target_team_code}'s assignment`
          : log.action === "clear_all_assignments" ? "Cleared all assignments" : log.action;
        const extra = log.action === "clear_assignment" ? `Released ${det.problem_statement_id}`
          : log.action === "clear_all_assignments" ? `${det.cleared_count ?? 0} released` : "";
        return h("li", null,
          h("span", { class: "activity__title" }, title),
          h("span", { class: "activity__meta" }, [extra, `by ${log.actor_username || "unknown"}`, fmtDateTime(log.created_at)].filter(Boolean).join(" · ")));
      }));
    } catch (err) {
      await handleError(err, "Couldn't load the activity log.");
    }
  }

  // CSV exports --------------------------------------------------------
  function csvCell(value) {
    let s = value == null ? "" : String(value);
    // Stop spreadsheet apps from treating text as a formula.
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const toCsv = (rows) => `\uFEFF${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;

  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = h("a", { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const EXPORTS = {
    all: {
      file: "coderscrew_assignments.csv",
      build: (d) => [["Team ID", "Assignment Status", "Problem Statement ID", "Assignment Timestamp"],
        ...d.teams.map((t) => [t.team_code, t.assigned ? "Assigned" : "Unassigned", t.problem_statement_id || "", t.assigned_at || ""])],
    },
    unassigned: {
      file: "coderscrew_unassigned_teams.csv",
      build: (d) => [["Team ID", "Assignment Status"], ...d.teams.filter((t) => !t.assigned).map((t) => [t.team_code, "Unassigned"])],
    },
    summary: {
      file: "coderscrew_problem_summary.csv",
      build: (d) => [["Problem Statement ID", "Active Assignments", "Maximum Capacity", "Remaining Slots", "Status"],
        ...d.problem_statements.map((p) => [p.id, p.active_count, p.max_capacity, p.remaining, p.status])],
    },
  };

  for (const button of $$("[data-export]")) {
    button.addEventListener("click", async () => {
      const spec = EXPORTS[button.dataset.export];
      setLoading(button, true, "Preparing");
      try {
        const data = await fetchOverview();           // always the live database
        admin.data = data; renderAdmin();
        const rows = spec.build(data);
        download(spec.file, toCsv(rows));
        toast(rows.length === 1 ? `${spec.file} downloaded (headers only, nothing to list).` : `${spec.file} downloaded.`, "success");
      } catch (err) {
        await handleError(err, "Couldn't build that file.");
      } finally {
        setLoading(button, false);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */
  window.addEventListener("offline", () => toast("You're offline. Actions will fail until you reconnect.", "error"));
  window.addEventListener("online", () => toast("Back online."));

  async function boot() {
    if (!sb) { showLogin(); return; }
    try {
      const { data } = await sb.auth.getSession();
      if (data && data.session) {
        const result = await enterApp();
        if (!result.ok) { await localSignOut(); showLogin(result.message); }
      } else {
        showLogin();
      }
    } catch (err) {
      showLogin(classifyError(err).message);
    }
    // Signed out in another tab → return to the login screen here too.
    sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT" && currentView !== "login" && currentView !== "boot") {
        studentReset(); adminReset(); showLogin("You have been signed out.");
      }
    });
  }

  boot();
})();
