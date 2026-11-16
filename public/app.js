const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  accountPill: $("#accountPill"),
  accountText: $('[data-bind="account"]'),
  modelPill: $("#modelPill"),
  modelText: $('[data-bind="model"]'),
  logout: $("#logoutBtn"),
  authScreen: $("#authScreen"),
  authForm: $("#authForm"),
  authPassword: $("#authPassword"),
  authError: $("#authError"),
  form: $("#scoopForm"),
  topic: $("#topic"),
  source: $("#source"),
  limit: $("#limit"),
  scoopBtn: $("#scoopBtn"),
  suggestions: $("#suggestions"),
  postList: $("#postList"),
  feedMeta: $("#feedMeta"),
  selectAll: $("#selectAllBtn"),
  draft: $("#draftText"),
  composeMeta: $("#composeMeta"),
  generate: $("#generateBtn"),
  save: $("#saveBtn"),
  post: $("#postBtn"),
  charCount: $("#charCount"),
  charRing: $("#charRing"),
  ringValue: $("#ringValue"),
  modeHint: $("#modeHint"),
  composerLink: $("#composerLink"),
  history: $("#historyList"),
  refreshHistory: $("#refreshHistory"),
  remindersBtn: $("#remindersBtn"),
  reminderStatus: $("#reminderStatus"),
  toasts: $("#toasts"),
};

const state = {
  posts: [],
  selected: new Set(),
  topic: "",
  status: null,
  maxChars: 280,
  draftModel: "",
  busy: false,
  authRequired: false,
  reminderTimer: null,
  generatingHourlyDraft: false,
};

const HOUR_MS = 60 * 60 * 1000;
const LOCAL_DRAFTS_KEY = "xpost.localDrafts.v1";
const REMINDERS_ENABLED_KEY = "xpost.hourlyReminders.enabled";
const REMINDERS_NEXT_KEY = "xpost.hourlyReminders.nextAt";
const NOTIFIED_DRAFT_KEY = "xpost.hourlyReminders.openDraft";
const TOPIC_KEY = "xpost.hourlyReminders.topic";

const MODE_COPY = {
  auto: "Publish directly through the official X API. X API credits may be required.",
  composer: "Prepare an X composer link in your browser. Review the post and press Post yourself.",
};

/* ---------- helpers ---------- */

function toast({ type = "info", title, message = "", link = "" }) {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  const bar = document.createElement("span");
  bar.className = "bar";

  const body = document.createElement("div");
  body.className = "toast-body";
  const heading = document.createElement("strong");
  heading.textContent = title;
  body.append(heading);

  if (message) {
    const text = document.createElement("p");
    text.textContent = message;
    body.append(text);
  }
  if (link) {
    const anchor = document.createElement("a");
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = link;
    const wrap = document.createElement("p");
    wrap.append(anchor);
    body.append(wrap);
  }

  node.append(bar, body);
  els.toasts.append(node);

  const remove = () => {
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 240);
  };
  setTimeout(remove, type === "error" ? 12000 : 7000);
  node.addEventListener("click", remove);
}

function getLocalDrafts() {
  try {
    const value = JSON.parse(localStorage.getItem(LOCAL_DRAFTS_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveLocalDraft({ text, status = "draft", url = null, id = null, createdAt = new Date().toISOString() }) {
  const record = { id: id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`, createdAt, status, text, url };
  const drafts = [record, ...getLocalDrafts()].slice(0, 50);
  try { localStorage.setItem(LOCAL_DRAFTS_KEY, JSON.stringify(drafts)); } catch { /* history is best effort */ }
  return record;
}

function reminderEnabled() {
  try { return localStorage.getItem(REMINDERS_ENABLED_KEY) === "1"; } catch { return false; }
}

function updateReminderControl() {
  const enabled = reminderEnabled();
  els.remindersBtn.textContent = enabled ? "Stop hourly automation" : "Start hourly automation";
  els.remindersBtn.setAttribute("aria-pressed", String(enabled));
  if (enabled) {
    const nextAt = Number(localStorage.getItem(REMINDERS_NEXT_KEY));
    els.reminderStatus.textContent = `Running. This app’s next post draft and browser notification are due ${Number.isFinite(nextAt) && nextAt ? localTime(new Date(nextAt).toISOString()) : "within an hour"}. Keep this dashboard open and signed in.`;
  } else {
    els.reminderStatus.textContent = "Stopped. Start the automation here to generate hourly drafts and receive notifications from this app. Keep the dashboard open and signed in.";
  }
}

function armHourlyReminder() {
  clearTimeout(state.reminderTimer);
  if (!reminderEnabled() || !("Notification" in window) || Notification.permission !== "granted") {
    updateReminderControl();
    return;
  }
  let nextAt = Number(localStorage.getItem(REMINDERS_NEXT_KEY));
  if (!Number.isFinite(nextAt) || !nextAt) {
    nextAt = Date.now() + HOUR_MS;
    localStorage.setItem(REMINDERS_NEXT_KEY, String(nextAt));
  }
  updateReminderControl();
  state.reminderTimer = setTimeout(async () => {
    await generateHourlyDraft();
    if (reminderEnabled()) {
      localStorage.setItem(REMINDERS_NEXT_KEY, String(Date.now() + HOUR_MS));
      armHourlyReminder();
    }
  }, Math.max(0, nextAt - Date.now()));
}

async function generateHourlyDraft() {
  if (state.generatingHourlyDraft) return;
  if (!state.status?.gemini?.ready) {
    toast({ type: "warn", title: "Hourly draft skipped", message: "Add GEMINI_API_KEY in the Vercel environment and redeploy." });
    return;
  }
  state.generatingHourlyDraft = true;
  try {
    const topic = els.topic.value.trim() || "software development, AI tools, and lessons from building projects";
    const result = await api("/api/draft", { method: "POST", body: { topic } });
    const record = saveLocalDraft({ text: result.text, status: "draft" });
    toast({ type: "success", title: "Hourly draft is ready", message: "Open the notification to review it, then choose X composer when you are ready." });
    if ("Notification" in window && Notification.permission === "granted") {
      const notification = new Notification("Your X draft is ready to review", {
        body: `${topic}: ${String(result.text).replace(/\s+/g, " ").slice(0, 120)}`,
        tag: `xpost-hourly-${record.id}`,
      });
      notification.onclick = () => {
        localStorage.setItem(NOTIFIED_DRAFT_KEY, record.id);
        window.focus();
        setTimeout(loadNotifiedDraft, 100);
        notification.close();
      };
    }
    await loadHistory();
  } catch (error) {
    toast({ type: "error", title: "Hourly draft failed", message: error.hint ? `${error.message} — ${error.hint}` : error.message });
  } finally {
    state.generatingHourlyDraft = false;
  }
}

function loadNotifiedDraft() {
  let id = null;
  try {
    id = localStorage.getItem(NOTIFIED_DRAFT_KEY);
    localStorage.removeItem(NOTIFIED_DRAFT_KEY);
  } catch { return; }
  if (!id) return;
  const record = getLocalDrafts().find((draft) => draft.id === id);
  if (!record) return;
  els.draft.value = record.text ?? "";
  updateCounter();
  document.querySelector(".compose-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
  toast({ type: "info", title: "Draft loaded", message: "Review and edit it before opening X." });
}

async function toggleHourlyReminders() {
  if (reminderEnabled()) {
    clearTimeout(state.reminderTimer);
    localStorage.setItem(REMINDERS_ENABLED_KEY, "0");
    updateReminderControl();
    toast({ type: "info", title: "Hourly automation stopped" });
    return;
  }
  if (!("Notification" in window)) {
    toast({ type: "error", title: "Notifications are unavailable", message: "Use a modern browser and open the secure HTTPS domain." });
    return;
  }
  const permission = Notification.permission === "default"
    ? await Notification.requestPermission()
    : Notification.permission;
  if (permission !== "granted") {
    toast({ type: "warn", title: "App notifications are blocked", message: "Allow browser notifications for this app’s domain, then start the automation again." });
    return;
  }
  localStorage.setItem(REMINDERS_ENABLED_KEY, "1");
  localStorage.setItem(REMINDERS_NEXT_KEY, String(Date.now() + HOUR_MS));
  armHourlyReminder();
  toast({ type: "success", title: "Hourly automation started", message: "This app will prepare your first post draft and notify you in about an hour. X login is only needed when you publish." });
}

function initializeHourlyReminders() {
  updateReminderControl();
  if (reminderEnabled()) armHourlyReminder();
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error ?? `Request failed (${response.status})`);
    error.hint = payload?.hint ?? "";
    error.code = payload?.code ?? "";
    if (response.status === 401 && error.code === "AUTH_REQUIRED") showAuth();
    throw error;
  }
  return payload;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.classList.toggle("loading", busy);
  if (label) button.querySelector(".label")?.replaceChildren(label);
}

function hashHue(value) {
  let hash = 0;
  for (const character of String(value)) {
    hash = (hash * 31 + character.charCodeAt(0)) % 360;
  }
  return hash;
}

function initials(author) {
  const handle = String(author ?? "").replace(/^@/, "");
  return handle.slice(0, 2).toUpperCase() || "X";
}

function relativeTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

function localTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? "");
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Same weighting X uses: every link counts as 23, wide characters as 2. */
const LIGHT = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x2017],
  [0x2032, 0x2037],
];

function tweetLength(text) {
  const flat = String(text ?? "").replace(/https?:\/\/[^\s]+/g, "x".repeat(23));
  let length = 0;
  for (const character of flat) {
    const code = character.codePointAt(0);
    length += LIGHT.some(([start, end]) => code >= start && code <= end) ? 1 : 2;
  }
  return length;
}

function updateCounter() {
  const length = tweetLength(els.draft.value);
  const max = state.maxChars;
  els.charCount.textContent = String(max - length);
  const ratio = Math.min(1, length / max);
  const circumference = 97.4;
  els.ringValue.style.strokeDashoffset = String(circumference * (1 - ratio));
  els.charRing.classList.toggle("near", length > max * 0.88 && length <= max);
  els.charRing.classList.toggle("full", length > max);
  els.charCount.style.color = length > max ? "var(--red)" : "";
}

/* ---------- status ---------- */

function paintStatus(status) {
  state.status = status;
  state.maxChars = status.maxChars ?? state.maxChars;

  if (status.account?.username) {
    els.accountPill.className = "pill ok";
    els.accountText.textContent = `@${status.account.username}`;
    els.accountPill.title = status.account.name ?? "";
  } else {
    els.accountPill.className = "pill warn";
    els.accountText.textContent = status.posting?.manual ? "manual X review" : "no X account";
    els.accountPill.title = status.accountError ?? "X credentials were not verified";
  }

  const apiMode = $$('input[name="mode"]').find((input) => input.value === "auto");
  if (apiMode) apiMode.closest(".mode").hidden = Boolean(status.posting?.manual);

  els.modelText.textContent = status.gemini?.model ?? "gemini";
  els.modelPill.title = status.gemini?.ready ? "Gemini key configured" : "Set GEMINI_API_KEY";

  paintModeHint();
  updateCounter();
}

function paintModeHint() {
  const mode = $$('input[name="mode"]').find((input) => input.checked)?.value ?? "auto";
  let hint = MODE_COPY[mode] ?? "";
  els.modeHint.textContent = hint;
}

async function loadStatus() {
  try {
    paintStatus(await api("/api/status"));
  } catch (error) {
    if (error.code === "AUTH_REQUIRED") return;
    els.accountText.textContent = "server offline";
    els.accountPill.className = "pill warn";
    toast({ type: "error", title: "Cannot reach the xpost server", message: error.message });
  }
}

function showAuth() {
  els.authScreen.hidden = false;
  els.logout.hidden = true;
  setTimeout(() => els.authPassword.focus(), 0);
}

function hideAuth() {
  els.authScreen.hidden = true;
  els.logout.hidden = !state.authRequired;
}

async function checkSession() {
  const session = await api("/api/auth/session");
  state.authRequired = session.required;
  if (!session.authenticated) {
    showAuth();
    return false;
  }
  hideAuth();
  try { els.topic.value = localStorage.getItem(TOPIC_KEY) ?? ""; } catch { /* optional preference */ }
  await Promise.all([loadStatus(), loadHistory()]);
  initializeHourlyReminders();
  return true;
}

async function signIn(event) {
  event.preventDefault();
  const button = els.authForm.querySelector("button");
  const label = button.querySelector(".label");
  const original = label.textContent;
  button.disabled = true;
  label.textContent = "Signing in…";
  els.authError.textContent = "";
  try {
    await api("/api/auth/login", { method: "POST", body: { password: els.authPassword.value } });
    els.authPassword.value = "";
    hideAuth();
    await Promise.all([loadStatus(), loadHistory()]);
    initializeHourlyReminders();
    toast({ type: "success", title: "Signed in", message: "Your private dashboard is ready." });
  } catch (error) {
    els.authError.textContent = error.message;
  } finally {
    button.disabled = false;
    label.textContent = original;
  }
}

async function signOut() {
  clearTimeout(state.reminderTimer);
  await api("/api/auth/logout", { method: "POST", body: {} });
  showAuth();
  els.authPassword.value = "";
}

/* ---------- feed ---------- */

function renderPosts() {
  els.postList.replaceChildren();
  state.selected.clear();

  if (!state.posts.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML =
      '<div class="empty-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h16M4 12h10M4 18h13" stroke-linecap="round"/></svg></div><p>No posts found for that topic.</p><small>Try a broader topic, or switch to the X API source.</small>';
    els.postList.append(empty);
    els.selectAll.disabled = true;
    paintSelection();
    return;
  }

  for (const [index, post] of state.posts.entries()) {
    els.postList.append(postCard(post, index));
  }
  els.selectAll.disabled = false;
  paintSelection();
}

function postCard(post, index) {
  const card = document.createElement("article");
  card.className = "post";
  card.dataset.index = String(index);

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  const hue = hashHue(post.author ?? post.url ?? index);
  avatar.style.background = `linear-gradient(140deg, hsl(${hue} 85% 72%), hsl(${(hue + 58) % 360} 88% 62%))`;
  avatar.textContent = initials(post.author);

  const body = document.createElement("div");
  body.className = "post-body";

  const meta = document.createElement("div");
  meta.className = "post-meta";
  const author = document.createElement("strong");
  author.textContent = post.author || "@unknown";
  meta.append(author);
  if (post.createdAt) {
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = `· ${relativeTime(post.createdAt)}`;
    time.title = String(post.createdAt);
    meta.append(time);
  }
  body.append(meta);

  const text = document.createElement("p");
  text.className = "post-text";
  text.textContent = post.text;
  body.append(text);

  const foot = document.createElement("div");
  foot.className = "post-foot";

  if (post.url) {
    const link = document.createElement("a");
    link.className = "post-link";
    link.href = post.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.innerHTML =
      'Open on X <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 17L17 7M9 7h8v8"/></svg>';
    foot.append(link);
  } else {
    const plain = document.createElement("span");
    plain.textContent = "no permalink";
    plain.style.color = "#6f788d";
    foot.append(plain);
  }

  const tools = document.createElement("div");
  tools.className = "post-tools";

  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "icon-btn";
  expand.title = "Show full text";
  expand.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>';
  expand.addEventListener("click", () => card.classList.toggle("expanded"));

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "icon-btn";
  copy.title = "Copy post text";
  copy.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M15 5.5A2.5 2.5 0 0012.5 3H6.5A2.5 2.5 0 004 5.5v6A2.5 2.5 0 006.5 14"/></svg>';
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(post.text);
      toast({ type: "success", title: "Copied to clipboard" });
    } catch {
      toast({ type: "error", title: "Clipboard is blocked", message: "Select the text manually." });
    }
  });

  const check = document.createElement("label");
  check.className = "check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = state.selected.has(index);
  check.classList.toggle("on", box.checked);
  box.addEventListener("change", () => {
    if (box.checked) state.selected.add(index);
    else state.selected.delete(index);
    check.classList.toggle("on", box.checked);
    card.classList.toggle("selected", box.checked);
    paintSelection();
  });
  check.append(box, document.createTextNode("context"));

  tools.append(expand, copy, check);
  foot.append(tools);
  body.append(foot);

  card.append(avatar, body);
  card.addEventListener("click", (event) => {
    if (event.target.closest("a, button, label, input")) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change"));
  });

  return card;
}

function selectedPosts() {
  if (state.selected.size === 0) return state.posts;
  return [...state.selected].map((index) => state.posts[index]).filter(Boolean);
}

function paintSelection() {
  const count = state.selected.size;
  const total = state.posts.length;
  els.composeMeta.textContent = !total
    ? "Selected posts become context, never copy."
    : count
      ? `${count} of ${total} posts selected as context`
      : `All ${total} posts will be used as context`;
  els.selectAll.textContent = count === total && total ? "Clear selection" : "Select all";
}

/* ---------- actions ---------- */

async function runScoop(event) {
  event?.preventDefault();
  const topic = els.topic.value.trim();
  if (!topic) {
    els.topic.focus();
    toast({ type: "warn", title: "Add a topic first", message: "For example: freelancing or web development." });
    return;
  }

  state.topic = topic;
  state.posts = [];
  els.postList.replaceChildren();
  for (let index = 0; index < 4; index += 1) {
    const skeleton = document.createElement("div");
    skeleton.className = "skeleton";
    els.postList.append(skeleton);
  }
  els.feedMeta.textContent = `Scraping live posts about “${topic}”…`;
  setBusy(els.scoopBtn, true, "Scraping");

  try {
    const result = await api("/api/scoop", {
      method: "POST",
      body: { topic, limit: Number(els.limit.value), source: els.source.value },
    });

    state.posts = result.posts ?? [];
    renderPosts();
    const host = result.host ? ` via ${result.host.replace(/^https?:\/\//, "")}` : "";
    els.feedMeta.textContent = `${state.posts.length} post${state.posts.length === 1 ? "" : "s"} · ${result.source === "api" ? "X API" : "public mirror feeds"}${host} · saved`;
    toast({
      type: "success",
      title: `Scraped ${state.posts.length} post${state.posts.length === 1 ? "" : "s"}`,
      message: result.saved ? `Saved to ${result.saved}` : "",
    });
  } catch (error) {
    els.postList.replaceChildren();
    els.feedMeta.textContent = "Scrape failed.";
    toast({
      type: "error",
      title: "Could not scrape posts",
      message: error.hint ? `${error.message} — ${error.hint}` : error.message,
    });
  } finally {
    setBusy(els.scoopBtn, false, "Scrape posts");
  }
}

async function runDraft({ regenerate = false } = {}) {
  const topic = els.topic.value.trim() || state.topic;
  const posts = selectedPosts();

  setBusy(els.generate, true, "Drafting");
  try {
    const result = await api("/api/draft", {
      method: "POST",
      body: {
        topic,
        posts,
        previousText: regenerate ? els.draft.value : "",
      },
    });
    els.draft.value = result.text;
    state.draftModel = result.model ?? "";
    updateCounter();
    els.draft.focus();
    toast({
      type: "success",
      title: regenerate ? "New angle drafted" : "Draft ready",
      message: `${result.length}/${state.maxChars} characters · ${result.model}`,
    });
  } catch (error) {
    toast({
      type: "error",
      title: "Draft failed",
      message: error.hint ? `${error.message} — ${error.hint}` : error.message,
    });
  } finally {
    setBusy(els.generate, false, "Draft with AI");
  }
}

async function runPublish() {
  const text = els.draft.value.trim();
  if (!text) {
    els.draft.focus();
    toast({ type: "warn", title: "Nothing to publish", message: "Write or draft something first." });
    return;
  }
  if (tweetLength(text) > state.maxChars) {
    toast({ type: "error", title: `Too long by ${tweetLength(text) - state.maxChars}`, message: `X allows ${state.maxChars} characters per post.` });
    return;
  }

  const mode = $$('input[name="mode"]').find((input) => input.checked)?.value ?? "auto";
  if (mode === "auto" && !window.confirm("Publish this post through the X API? This may use API credits.")) return;
  els.composerLink.hidden = true;
  setBusy(els.post, true, mode === "composer" ? "Preparing" : "Publishing");
  toast({
    type: "info", title: mode === "composer" ? "Preparing X composer…" : "Publishing through X API…",
  });

  try {
    const result = await api("/api/post", { method: "POST", body: { text, mode } });

    if (result.status === "composer") {
      els.composerLink.href = result.url;
      els.composerLink.hidden = false;
      toast({
        type: "warn",
        title: "Review and post in X",
        message: "The dashboard prepared the composer link. Publishing happens after you press Post in X.",
        link: result.url,
      });
      saveLocalDraft({ text, status: "manual", url: result.url });
    } else {
      toast({
        type: "success",
        title: "Posted through X API",
        message: result.file ? `Saved to ${result.file}` : "X confirmed the post.",
        link: result.url,
      });
      saveLocalDraft({ text, status: "posted", url: result.url });
    }
    loadHistory();
    loadStatus();
  } catch (error) {
    toast({
      type: "error",
      title: "Publish failed",
      message: error.hint ? `${error.message} — ${error.hint}` : error.message,
    });
  } finally {
    setBusy(els.post, false, "Publish");
  }
}

async function runSave() {
  const text = els.draft.value.trim();
  if (!text) {
    toast({ type: "warn", title: "Nothing to save" });
    return;
  }
  setBusy(els.save, true, "Saving");
  try {
    const result = await api("/api/save", { method: "POST", body: { text } });
    saveLocalDraft({ text, status: "saved" });
    toast({ type: "success", title: "Draft saved", message: result.file });
    loadHistory();
  } catch (error) {
    toast({ type: "error", title: "Could not save", message: error.message });
  } finally {
    setBusy(els.save, false, "Save");
  }
}

async function loadHistory() {
  try {
    const result = await api("/api/history?limit=12").catch(() => ({ drafts: [] }));
    els.history.replaceChildren();
    const merged = new Map();
    for (const draft of [...(result.drafts ?? []), ...getLocalDrafts()]) {
      const key = draft.id ?? `${draft.createdAt ?? ""}:${draft.text ?? ""}`;
      if (!merged.has(key)) merged.set(key, draft);
    }
    const drafts = [...merged.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 12);

    if (!drafts.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No drafts yet. Publish something and it shows up here.";
      els.history.append(empty);
      return;
    }

    for (const draft of drafts) {
      const row = document.createElement("div");
      row.className = "history-item";

      const badge = document.createElement("span");
      badge.className = `badge ${draft.status ?? "draft"}`;
      badge.textContent = draft.status ?? "draft";

      const text = document.createElement("span");
      text.className = "history-text";
      text.textContent = (draft.text ?? "").replace(/\s+/g, " ").trim() || "(empty)";
      if (draft.url) {
        text.style.cursor = "pointer";
        text.title = draft.url;
        text.addEventListener("click", () => window.open(draft.url, "_blank", "noreferrer"));
      }

      const time = document.createElement("span");
      time.className = "history-time";
      time.textContent = localTime(draft.createdAt);

      row.append(badge, text, time);
      els.history.append(row);
    }
  } catch (error) {
    els.history.replaceChildren();
    const failed = document.createElement("p");
    failed.className = "muted";
    failed.textContent = `Could not load history: ${error.message}`;
    els.history.append(failed);
  }
}

/* ---------- wiring ---------- */

els.form.addEventListener("submit", runScoop);
els.topic.addEventListener("input", () => {
  try { localStorage.setItem(TOPIC_KEY, els.topic.value); } catch { /* optional preference */ }
});
els.generate.addEventListener("click", () => runDraft());
els.post.addEventListener("click", runPublish);
els.save.addEventListener("click", runSave);
els.authForm.addEventListener("submit", signIn);
els.logout.addEventListener("click", () => signOut().catch((error) => toast({ type: "error", title: "Sign out failed", message: error.message })));
els.refreshHistory.addEventListener("click", loadHistory);
els.remindersBtn.addEventListener("click", () => toggleHourlyReminders().catch((error) => toast({ type: "error", title: "Could not update reminders", message: error.message })));
window.addEventListener("focus", loadNotifiedDraft);
els.draft.addEventListener("input", updateCounter);
els.draft.addEventListener("input", () => { els.composerLink.hidden = true; });

els.suggestions.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-topic]");
  if (!button) return;
  els.topic.value = button.dataset.topic;
  try { localStorage.setItem(TOPIC_KEY, els.topic.value); } catch { /* optional preference */ }
  els.topic.focus();
});

els.selectAll.addEventListener("click", () => {
  const all = state.selected.size === state.posts.length;
  state.selected = all ? new Set() : new Set(state.posts.map((_, index) => index));
  $$(".post").forEach((card, index) => {
    const box = card.querySelector('input[type="checkbox"]');
    const active = state.selected.has(index);
    box.checked = active;
    card.classList.toggle("selected", active);
    box.closest(".check").classList.toggle("on", active);
  });
  paintSelection();
});

$$('input[name="mode"]').forEach((input) => {
  input.addEventListener("change", () => {
    input.dataset.touched = "1";
    paintModeHint();
  });
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runPublish();
  }
});

checkSession().catch((error) => toast({ type: "error", title: "Could not connect", message: error.message }));
setInterval(() => { if (els.authScreen.hidden) loadStatus(); }, 30_000);
