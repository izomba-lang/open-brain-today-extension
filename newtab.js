/* Open Brain — Cockpit newtab
 * Backend: Supabase format-focus + MCP (preserved from v1)
 * UI: Variant B (Tri-column Cockpit)
 */

// ── Config & Storage ────────────────────────────────────────────────────

const STORAGE_KEY = "open-brain-today-config";
const CACHE_KEY = "open-brain-today-cache";
const BRIEF_CACHE_KEY = "open-brain-brief-cache";
const CACHE_TTL_MS = 5 * 60 * 1000;
const BRIEF_CACHE_TTL_MS = 60 * 60 * 1000;
const TOP_N = 3;

async function storageGet(key) {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((r) => chrome.storage.local.get(key, (res) => r(res[key])));
  }
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
async function storageSet(key, val) {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((r) => chrome.storage.local.set({ [key]: val }, r));
  }
  localStorage.setItem(key, JSON.stringify(val));
}
async function storageRemove(key) {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((r) => chrome.storage.local.remove(key, r));
  }
  localStorage.removeItem(key);
}

const getConfig = () => storageGet(STORAGE_KEY);
const saveConfig = (endpoint, mcp, key) => storageSet(STORAGE_KEY, { endpoint, mcp, key });

async function getCached(key, ttl) {
  const cached = await storageGet(key);
  if (cached && cached.data) {
    return { data: cached.data, isFresh: Date.now() - cached.ts < ttl };
  }
  return null;
}
const setCached = (key, data) => storageSet(key, { data, ts: Date.now() });

// ── API ─────────────────────────────────────────────────────────────────

async function fetchFocus() {
  const cfg = await getConfig();
  if (!cfg) throw new Error("Not configured");
  const res = await fetch(`${cfg.endpoint}?key=${cfg.key}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchBrief() {
  const cfg = await getConfig();
  if (!cfg) return null;
  const url = cfg.endpoint.replace("format-focus", "daily-brief");
  const res = await fetch(`${url}?key=${cfg.key}`);
  if (!res.ok) return null;
  return res.json();
}

async function mcpCall(tool, args = {}) {
  const cfg = await getConfig();
  if (!cfg) throw new Error("Not configured");
  const res = await fetch(`${cfg.mcp}?key=${cfg.key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool, arguments: args } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.result?.content?.[0]?.text;
  if (!text) throw new Error("Empty response");
  return JSON.parse(text);
}

async function markDone(id) {
  await storageRemove(CACHE_KEY);
  const task = state.tasks.find((t) => t.id === id);
  const merged = task?.merged_ids || [];
  await Promise.all([
    mcpCall("update_thought", { id, status: "done" }),
    ...merged.map((mid) => mcpCall("update_thought", { id: mid, status: "done" })),
  ]);
}

async function processUpdate(taskId, text) {
  const cfg = await getConfig();
  if (!cfg) throw new Error("Not configured");
  const url = cfg.endpoint.replace("format-focus", "process-update");
  const res = await fetch(`${url}?key=${cfg.key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: taskId, update_text: text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  await storageRemove(CACHE_KEY);
  return data;
}

// ── Date/formatting helpers ─────────────────────────────────────────────

function getGreeting() {
  const h = new Date().getHours();
  if (h < 6) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

function formatDateLong() {
  return new Date().toLocaleDateString("ru-RU", {
    weekday: "short", day: "numeric", month: "short",
  });
}

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t == null ? "" : String(t);
  return d.innerHTML;
}

function formatDeadline(due) {
  if (!due) return null;
  const dl = new Date(due);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.ceil((dl.getTime() - now.getTime()) / 86400000);
  let label, cls = "";
  if (diff < 0) { label = `-${Math.abs(diff)}Д ПРОСРОЧЕНО`; cls = "overdue"; }
  else if (diff === 0) { label = "СЕГОДНЯ"; cls = "urgent"; }
  else if (diff === 1) { label = "ЗАВТРА"; cls = "urgent"; }
  else if (diff <= 7) { label = `ДО ${dl.toLocaleDateString("ru-RU", { weekday: "short" }).toUpperCase()}`; }
  else { label = dl.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).toUpperCase(); }
  return { label, cls, diff };
}

// ── Zone mapping (Cockpit) ──────────────────────────────────────────────

const ZONES = [
  { key: "work",     areas: ["work"],                          title: "Работа",    color: "oklch(0.65 0.15 250)" },
  { key: "finance",  areas: ["finance"],                        title: "Финансы",   color: "oklch(0.68 0.13 80)"  },
  { key: "personal", areas: ["personal"],                       title: "Личное",    color: "oklch(0.63 0.15 310)" },
  { key: "other",    areas: ["health", "learning", "social", "other"], title: "Прочее", color: "oklch(0.65 0.12 160)" },
];

function zoneOf(task) {
  const a = task.area || "other";
  return ZONES.find((z) => z.areas.includes(a)) || ZONES[ZONES.length - 1];
}

// ── Global state ────────────────────────────────────────────────────────

const state = {
  tasks: [],
  brief: null,
  activeTaskId: null,
  activeZone: null,
};

// ── Renderers ───────────────────────────────────────────────────────────

function renderLeftBrief() {
  const greet = document.querySelector(".b-brief-greet");
  const date = document.querySelector(".b-brief-date");
  const b = state.brief?.brief;

  // Use Claude-generated greeting if available, else fallback
  if (greet) greet.textContent = b?.greeting || getGreeting();
  if (date) date.textContent = formatDateLong();

  // Helper: clear section content except <h4>, set header, append body
  const fillSection = (selector, headerText, bodyNode) => {
    const sec = document.querySelector(selector);
    if (!sec) return;
    const h4 = sec.querySelector("h4");
    if (h4) h4.textContent = headerText;
    [...sec.children].forEach((c) => { if (c !== h4) c.remove(); });
    sec.appendChild(bodyNode);
  };

  // Focus
  const focusBody = document.createElement("div");
  focusBody.className = "b-brief-body";
  focusBody.textContent = b?.focus || "Брифинг появится после подключения.";
  fillSection(".b-brief-section.focus", "Фокус", focusBody);

  // Advice
  const adviceBody = document.createElement("ul");
  if (b?.advice?.length) {
    adviceBody.innerHTML = b.advice.map((a) => `<li>${escapeHtml(a)}</li>`).join("");
  } else {
    adviceBody.innerHTML = '<li style="opacity:.5">Пока нечего советовать</li>';
  }
  fillSection(".b-brief-section.advice", "Советы", adviceBody);

  // Risks / warnings (markup uses .risks, not .warn)
  const risksBody = document.createElement("ul");
  if (b?.warnings?.length) {
    risksBody.innerHTML = b.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("");
    fillSection(".b-brief-section.risks", "Риски", risksBody);
    const risksSec = document.querySelector(".b-brief-section.risks");
    if (risksSec) risksSec.style.display = "";
  } else {
    // Hide the risks section entirely when there's nothing to warn about
    const risksSec = document.querySelector(".b-brief-section.risks");
    if (risksSec) risksSec.style.display = "none";
  }

  // Insight
  const insightSec = document.querySelector(".b-brief-section.insight");
  if (insightSec) {
    if (b?.insight) {
      const p = document.createElement("p");
      p.className = "lead";
      p.textContent = b.insight;
      fillSection(".b-brief-section.insight", "Инсайт", p);
      insightSec.style.display = "";
    } else {
      insightSec.style.display = "none";
    }
  }
}

function renderHomeMain() {
  const main = document.getElementById("b-home-main");
  if (!main) return;

  const countBtn = document.getElementById("b-count-btn");
  const total = state.tasks.length;
  const overdue = state.tasks.filter((t) => {
    const d = formatDeadline(t.due_date);
    return d && d.diff < 0;
  }).length;
  if (countBtn) {
    countBtn.innerHTML = `${total} открытых${overdue ? ` · ${overdue} просрочено` : ""}<span class="arrow">→</span>`;
  }

  // Remove any existing .b-task cards (but keep .b-main-head)
  main.querySelectorAll(".b-task").forEach((n) => n.remove());

  const focusTasks = state.tasks.slice(0, TOP_N);
  const h2 = main.querySelector(".b-main-head h2");
  if (h2) {
    if (focusTasks.length === 0) h2.textContent = "Свободный день";
    else if (focusTasks.length === 1) h2.textContent = "Сегодня — одна задача";
    else if (focusTasks.length === 2) h2.textContent = "Сегодня — две задачи";
    else h2.textContent = "Сегодня — три задачи";
  }

  focusTasks.forEach((task, i) => {
    const card = document.createElement("div");
    card.className = "b-task" + (i === 0 ? " primary" : "");
    card.dataset.task = String(task.id);
    const dl = formatDeadline(task.due_date);
    const dlPill = dl ? `<span class="pill dl ${dl.cls}">${escapeHtml(dl.label)}</span>` : "";
    const areaPill = task.area ? `<span class="pill area">${escapeHtml(task.area)}</span>` : "";
    const topicPill = task.topic ? `<span class="pill topic">${escapeHtml(task.topic)}</span>` : "";

    // Use first non-empty line of content as "why"
    const why = (task.content || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";

    card.innerHTML = `
      <div class="b-task-num">${i + 1}</div>
      <div class="b-task-body">
        <div class="b-task-title">${escapeHtml(task.title)}</div>
        ${why ? `<p class="b-task-why">${escapeHtml(why)}</p>` : ""}
        <div class="b-task-meta">
          ${areaPill}${topicPill}${dlPill}
        </div>
      </div>
      <span class="b-task-open">OPEN →</span>
    `;
    card.addEventListener("click", () => openTask(task.id));
    main.appendChild(card);
  });
}

function renderAllView() {
  const grid = document.getElementById("b-all-grid");
  const head = document.querySelector(".b-all-head h1");
  const sub = document.querySelector(".b-all-head .sub");
  const filters = document.querySelector(".b-all-filters");

  // Header
  const total = state.tasks.length;
  const working = state.tasks.length; // we don't have a "working" flag, show all open
  const overdue = state.tasks.filter((t) => { const d = formatDeadline(t.due_date); return d && d.diff < 0; }).length;
  const week = state.tasks.filter((t) => { const d = formatDeadline(t.due_date); return d && d.diff >= 0 && d.diff <= 7; }).length;
  if (head) head.innerHTML = `<span class="n">${total}</span> открытые задачи`;
  if (sub) sub.textContent = `По всем зонам${overdue ? ` · ${overdue} просрочено` : ""}`;
  if (filters) {
    filters.innerHTML = `
      <button class="active" data-afilter="all">ВСЕ · ${total}</button>
      <button data-afilter="overdue">ПРОСРОЧ · ${overdue}</button>
      <button data-afilter="week">ЭТА НЕД · ${week}</button>
    `;
    filters.querySelectorAll("button").forEach((b) => b.addEventListener("click", (e) => {
      filters.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      renderAllGrid(b.dataset.afilter);
    }));
  }

  renderAllGrid("all");
}

function renderAllGrid(filter) {
  const grid = document.getElementById("b-all-grid");
  if (!grid) return;
  grid.innerHTML = "";

  let pool = state.tasks;
  if (filter === "overdue") pool = pool.filter((t) => { const d = formatDeadline(t.due_date); return d && d.diff < 0; });
  else if (filter === "week") pool = pool.filter((t) => { const d = formatDeadline(t.due_date); return d && d.diff >= 0 && d.diff <= 7; });

  ZONES.forEach((z) => {
    const zTasks = pool.filter((t) => zoneOf(t).key === z.key);
    const card = document.createElement("div");
    card.className = "b-all-zone";
    card.style.setProperty("--zone-c", z.color);
    const rows = zTasks.slice(0, 4).map((t) => {
      const dl = formatDeadline(t.due_date);
      const dlPill = dl ? `<span class="pill dl ${dl.cls}">${escapeHtml(dl.label)}</span>` : "";
      const topicPill = t.topic ? `<span class="pill topic">${escapeHtml(t.topic)}</span>` : "";
      return `<div class="b-all-row" data-tid="${t.id}"><div class="t">${escapeHtml(t.title)}</div><div class="r">${topicPill}${dlPill}</div></div>`;
    }).join("");

    card.innerHTML = `
      <div class="b-all-zone-head" data-zopen="${z.key}">
        <div class="b-all-zone-title"><span class="n">${zTasks.length}</span> ${escapeHtml(z.title)}</div>
        <span class="link">ОТКРЫТЬ ЗОНУ →</span>
      </div>
      ${rows || '<div class="b-all-row" style="opacity:.4"><div class="t">— пусто —</div><div class="r"></div></div>'}
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll("[data-zopen]").forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); document.body.dataset.from = "all"; openZone(el.dataset.zopen); });
  });
  grid.querySelectorAll("[data-tid]").forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); document.body.dataset.from = "all"; openTask(parseInt(el.dataset.tid, 10)); });
  });
}

function renderTaskView(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  const idx = state.tasks.findIndex((t) => t.id === taskId);
  const rankEl = document.getElementById("btv-rank");
  if (rankEl) {
    if (idx >= 0 && idx < TOP_N) {
      rankEl.innerHTML = `${idx + 1}<span class="of">/ ${Math.min(TOP_N, state.tasks.length)} сегодня</span>`;
      rankEl.style.color = "var(--accent-blue)";
    } else {
      rankEl.innerHTML = `·<span class="of">open task</span>`;
      rankEl.style.color = "var(--text-4)";
    }
  }

  const z = zoneOf(task);
  const kickEl = document.getElementById("btv-kick");
  if (kickEl) kickEl.textContent = `${(idx === 0 ? "PRIMARY · " : "")}${z.title.toUpperCase()}${task.topic ? " · " + String(task.topic).toUpperCase() : ""}`;

  const titleEl = document.getElementById("btv-title");
  if (titleEl) titleEl.textContent = task.title;

  const why = (task.content || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
  const whyEl = document.getElementById("btv-why");
  if (whyEl) whyEl.textContent = why;

  const metaEl = document.getElementById("btv-meta");
  if (metaEl) {
    const dl = formatDeadline(task.due_date);
    metaEl.innerHTML = `
      ${task.area ? `<span class="pill area">${escapeHtml(task.area)}</span>` : ""}
      ${task.topic ? `<span class="pill topic">${escapeHtml(task.topic)}</span>` : ""}
      ${dl ? `<span class="pill dl ${dl.cls}">${escapeHtml(dl.label)}</span>` : ""}
    `;
  }

  const contentEl = document.getElementById("btv-content");
  if (contentEl) contentEl.textContent = task.content || "";

  // Sidebar: populate with real data
  const sideEl = document.getElementById("btv-side") || document.querySelector(".b-tv-side");
  if (sideEl) {
    const merged = task.merged_ids || [];
    const people = task.people || [];
    const dl = formatDeadline(task.due_date);

    const rows = [];
    rows.push(`<div class="stat-row"><span>Зона</span><span class="v">${escapeHtml(z.title)}</span></div>`);
    if (idx >= 0 && idx < TOP_N) {
      rows.push(`<div class="stat-row"><span>Приоритет</span><span class="v" style="color: var(--accent-blue);">#${idx + 1}${idx === 0 ? " · primary" : ""}</span></div>`);
    }
    if (task.topic) {
      rows.push(`<div class="stat-row"><span>Тема</span><span class="v">${escapeHtml(task.topic)}</span></div>`);
    }
    if (dl) {
      rows.push(`<div class="stat-row"><span>Дедлайн</span><span class="v">${escapeHtml(dl.label)}</span></div>`);
    }
    if (people.length) {
      rows.push(`<div class="stat-row"><span>Люди</span><span class="v">${escapeHtml(people.join(", "))}</span></div>`);
    }
    if (merged.length) {
      rows.push(`<div class="stat-row"><span>Объединено</span><span class="v">+${merged.length} задач${merged.length > 4 ? "" : "и"}</span></div>`);
    }

    sideEl.innerHTML = `
      <div class="side-card">
        <h5>Детали</h5>
        ${rows.join("\n")}
      </div>
    `;
  }

  const crumb = document.getElementById("b-crumb-label");
  if (crumb) crumb.textContent = task.title;
}

function renderZoneView(zoneKey) {
  const z = ZONES.find((x) => x.key === zoneKey);
  if (!z) return;
  const zTasks = state.tasks.filter((t) => zoneOf(t).key === zoneKey);

  const numEl = document.getElementById("bzv-num");
  const titleEl = document.getElementById("bzv-title");
  const subEl = document.getElementById("bzv-sub");
  const listEl = document.getElementById("bzv-list");

  if (numEl) numEl.textContent = String(zTasks.length);
  if (titleEl) titleEl.textContent = z.title;
  if (subEl) {
    const overdue = zTasks.filter((t) => { const d = formatDeadline(t.due_date); return d && d.diff < 0; }).length;
    subEl.textContent = zTasks.length
      ? `${zTasks.length} открытых${overdue ? ` · ${overdue} просрочено` : ""}`
      : "Пусто";
  }

  if (listEl) {
    listEl.innerHTML = "";
    zTasks.forEach((t) => {
      const dl = formatDeadline(t.due_date);
      const dlPill = dl ? `<span class="pill dl ${dl.cls}">${escapeHtml(dl.label)}</span>` : "";
      const topicPill = t.topic ? `<span class="pill topic">${escapeHtml(t.topic)}</span>` : "";
      const row = document.createElement("div");
      row.className = "b-zv-row";
      row.dataset.tid = String(t.id);
      row.innerHTML = `
        <div class="b-zv-title">${escapeHtml(t.title)}</div>
        <div class="b-zv-meta">${topicPill}${dlPill}</div>
      `;
      row.addEventListener("click", () => { document.body.dataset.from = "zone"; openTask(t.id); });
      listEl.appendChild(row);
    });
  }

  const crumb = document.getElementById("b-crumb-label");
  if (crumb) crumb.textContent = z.title;
}

// ── Navigation ──────────────────────────────────────────────────────────

function goHome() {
  document.body.dataset.screen = "home";
  const crumb = document.getElementById("b-crumb-label");
  if (crumb) crumb.textContent = "";
  window.scrollTo({ top: 0, behavior: "instant" });
}

function openAll() {
  document.body.dataset.screen = "all";
  renderAllView();
  const crumb = document.getElementById("b-crumb-label");
  if (crumb) crumb.textContent = "Все задачи";
  window.scrollTo({ top: 0, behavior: "instant" });
}

function openTask(id) {
  state.activeTaskId = id;
  document.body.dataset.screen = "task";
  document.body.dataset.from = document.body.dataset.from || "home";
  renderTaskView(id);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function openZone(key) {
  state.activeZone = key;
  document.body.dataset.screen = "zone";
  document.body.dataset.zone = key;
  renderZoneView(key);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function goBack() {
  const screen = document.body.dataset.screen;
  const from = document.body.dataset.from;
  if (screen === "task" && from === "zone" && document.body.dataset.zone) {
    openZone(document.body.dataset.zone);
    document.body.dataset.from = "home";
  } else if ((screen === "task" || screen === "zone") && from === "all") {
    openAll();
    document.body.dataset.from = "home";
  } else {
    goHome();
    document.body.dataset.from = "home";
  }
}

// ── Settings overlay ────────────────────────────────────────────────────

async function showSettings() {
  const cfg = (await getConfig()) || {};
  document.getElementById("settings-endpoint").value = cfg.endpoint || "";
  document.getElementById("settings-mcp").value = cfg.mcp || "";
  document.getElementById("settings-key").value = cfg.key || "";
  document.getElementById("settings-overlay").classList.remove("hidden");
}
function hideSettings() {
  document.getElementById("settings-overlay").classList.add("hidden");
}

// ── State displays ──────────────────────────────────────────────────────

function showLoading(msg = "Загружаю…") {
  document.getElementById("ob-loading").textContent = msg;
  document.getElementById("ob-loading").classList.remove("hidden");
  document.getElementById("ob-error").classList.add("hidden");
  document.getElementById("ob-noconfig").classList.add("hidden");
  document.body.classList.add("ob-busy");
}
function showError(msg) {
  document.getElementById("ob-loading").classList.add("hidden");
  const e = document.getElementById("ob-error");
  e.textContent = `Ошибка: ${msg}`;
  e.classList.remove("hidden");
  document.body.classList.remove("ob-busy");
}
function showNoConfig() {
  document.getElementById("ob-loading").classList.add("hidden");
  document.getElementById("ob-error").classList.add("hidden");
  document.getElementById("ob-noconfig").classList.remove("hidden");
  document.body.classList.add("ob-busy");
}
function showReady() {
  document.getElementById("ob-loading").classList.add("hidden");
  document.getElementById("ob-error").classList.add("hidden");
  document.getElementById("ob-noconfig").classList.add("hidden");
  document.body.classList.remove("ob-busy");
}

// ── Init & data loading ─────────────────────────────────────────────────

async function loadData(opts = { force: false }) {
  const cached = await getCached(CACHE_KEY, CACHE_TTL_MS);
  if (cached && !opts.force) {
    state.tasks = cached.data.tasks || [];
    renderAll();
    showReady();
    if (!cached.isFresh) {
      fetchFocus().then((data) => {
        state.tasks = data.tasks || [];
        setCached(CACHE_KEY, data);
        renderAll();
      }).catch(() => {});
    }
  } else {
    try {
      const data = await fetchFocus();
      state.tasks = data.tasks || [];
      await setCached(CACHE_KEY, data);
      renderAll();
      showReady();
    } catch (err) {
      showError(err.message);
      return;
    }
  }

  // Brief (separate endpoint, slower, non-blocking)
  const briefCached = await getCached(BRIEF_CACHE_KEY, BRIEF_CACHE_TTL_MS);
  if (briefCached) {
    state.brief = briefCached.data;
    renderLeftBrief();
    if (!briefCached.isFresh) {
      fetchBrief().then((b) => { if (b) { state.brief = b; setCached(BRIEF_CACHE_KEY, b); renderLeftBrief(); } }).catch(() => {});
    }
  } else {
    fetchBrief().then((b) => { if (b) { state.brief = b; setCached(BRIEF_CACHE_KEY, b); renderLeftBrief(); } }).catch(() => {});
  }
}

function renderExploreCard() {
  const titleEl = document.getElementById("b-explore-title");
  const quadEl = document.getElementById("b-explore-quadrants");
  if (!quadEl) return;

  if (titleEl) {
    const total = state.tasks.length;
    titleEl.textContent = `Explore · ${total} ${total === 1 ? "задача" : total < 5 ? "задачи" : "задач"}`;
  }

  const now = new Date(); now.setHours(0, 0, 0, 0);
  quadEl.innerHTML = ZONES.map((z) => {
    const zTasks = state.tasks.filter((t) => zoneOf(t).key === z.key);
    const overdue = zTasks.filter((t) => {
      if (!t.due_date) return false;
      return new Date(t.due_date).getTime() < now.getTime();
    }).length;
    const nextDl = zTasks
      .filter((t) => t.due_date && new Date(t.due_date).getTime() >= now.getTime())
      .map((t) => formatDeadline(t.due_date))
      .filter(Boolean)
      .sort((a, b) => a.diff - b.diff)[0];
    const dlText = overdue ? `${overdue}↯` : (nextDl ? nextDl.label : "—");
    const dlCls = overdue ? "overdue" : (nextDl?.cls || "");
    return `
      <div class="b-quad" data-zone-key="${z.key}">
        <div class="top"><div class="n">${zTasks.length}</div><div class="dl ${dlCls}">${escapeHtml(dlText)}</div></div>
        <div class="lbl">${escapeHtml(z.title)}</div>
      </div>
    `;
  }).join("");

  // Wire individual quadrant clicks → drill into zone
  quadEl.querySelectorAll(".b-quad").forEach((q) => {
    q.addEventListener("click", (e) => {
      e.stopPropagation();
      const zoneKey = q.dataset.zoneKey;
      if (!zoneKey) return;
      state.activeZone = zoneKey;
      document.body.dataset.from = "home";
      document.body.dataset.screen = "zone";
      renderZoneView(zoneKey);
      window.scrollTo({ top: 0, behavior: "instant" });
    });
  });
}

function renderAll() {
  renderLeftBrief();
  renderHomeMain();
  renderExploreCard();
  if (document.body.dataset.screen === "all") renderAllView();
  if (document.body.dataset.screen === "task" && state.activeTaskId != null) renderTaskView(state.activeTaskId);
  if (document.body.dataset.screen === "zone" && state.activeZone) renderZoneView(state.activeZone);
}

async function init() {
  // Wire settings
  document.getElementById("settings-fab").addEventListener("click", showSettings);
  document.getElementById("ob-setup-btn").addEventListener("click", showSettings);
  document.getElementById("settings-cancel").addEventListener("click", hideSettings);
  document.getElementById("settings-save").addEventListener("click", async () => {
    const endpoint = document.getElementById("settings-endpoint").value.trim();
    const mcp = document.getElementById("settings-mcp").value.trim();
    const key = document.getElementById("settings-key").value.trim();
    if (!endpoint || !key) return;
    await saveConfig(endpoint, mcp, key);
    hideSettings();
    init();
  });

  // Wire count btn (Explore-all)
  const countBtn = document.getElementById("b-count-btn");
  if (countBtn) countBtn.addEventListener("click", openAll);

  // Wire Explore card (right sidebar) — clicking title/empty area opens all-tasks
  const exploreCard = document.getElementById("b-explore-card");
  if (exploreCard) {
    exploreCard.addEventListener("click", (e) => {
      // Ignore clicks that bubbled from a specific quadrant (it has its own handler)
      if (e.target.closest(".b-quad")) return;
      openAll();
    });
  }

  // Crumb back
  document.querySelectorAll('[data-goto="home"]').forEach((b) => b.addEventListener("click", goBack));

  // Esc
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (["task", "zone", "all"].includes(document.body.dataset.screen)) goBack();
      else if (!document.getElementById("settings-overlay").classList.contains("hidden")) hideSettings();
    }
  });

  // Task view actions (done / update-like via capture)
  const doneBtn = document.querySelector(".b-tv-actions .btn-d");
  if (doneBtn) doneBtn.addEventListener("click", async () => {
    if (state.activeTaskId == null) return;
    doneBtn.disabled = true;
    doneBtn.textContent = "…";
    try {
      await markDone(state.activeTaskId);
      state.tasks = state.tasks.filter((t) => t.id !== state.activeTaskId);
      state.activeTaskId = null;
      renderAll();
      goBack();
    } catch (err) {
      doneBtn.textContent = "! " + err.message;
    } finally {
      setTimeout(() => { doneBtn.disabled = false; doneBtn.textContent = "✓ Выполнено"; }, 1500);
    }
  });

  const startBtn = document.querySelector(".b-tv-actions .btn-p");
  if (startBtn) startBtn.addEventListener("click", async () => {
    // No "start" backend — fire a tiny update so it's journalled
    if (state.activeTaskId == null) return;
    startBtn.disabled = true;
    startBtn.textContent = "…";
    try {
      await processUpdate(state.activeTaskId, "Начал работу");
      const data = await fetchFocus();
      state.tasks = data.tasks || [];
      await setCached(CACHE_KEY, data);
      renderAll();
      renderTaskView(state.activeTaskId);
      startBtn.textContent = "✓";
    } catch (err) {
      startBtn.textContent = "!";
    } finally {
      setTimeout(() => { startBtn.disabled = false; startBtn.textContent = "Начать →"; }, 1500);
    }
  });

  // Task update input (free-form Claude-interpreted update)
  const updateBtn = document.getElementById("btv-update-btn");
  const updateInput = document.getElementById("btv-update-input");
  const submitUpdate = async () => {
    if (state.activeTaskId == null) return;
    const text = updateInput.value.trim();
    if (!text) return;
    updateBtn.disabled = true;
    updateInput.disabled = true;
    const orig = updateBtn.textContent;
    updateBtn.textContent = "…";
    try {
      const result = await processUpdate(state.activeTaskId, text);
      const action = result.action || {};
      if (action.mark_done) {
        state.tasks = state.tasks.filter((t) => t.id !== state.activeTaskId);
        state.activeTaskId = null;
        renderAll();
        goBack();
      } else {
        // Refetch fresh AI titles
        try {
          const data = await fetchFocus();
          state.tasks = data.tasks || [];
          await setCached(CACHE_KEY, data);
        } catch {}
        updateInput.value = "";
        renderAll();
        if (state.activeTaskId != null) renderTaskView(state.activeTaskId);
      }
      updateBtn.textContent = "✓";
    } catch (err) {
      updateBtn.textContent = "!";
    } finally {
      updateInput.disabled = false;
      setTimeout(() => { updateBtn.disabled = false; updateBtn.textContent = orig; }, 1200);
    }
  };
  if (updateBtn) updateBtn.addEventListener("click", submitUpdate);
  if (updateInput) updateInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitUpdate(); }
  });

  // Capture form (quick task add)
  const captureForm = document.getElementById("b-capture-form");
  if (captureForm) {
    captureForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("b-capture-input");
      const text = input.value.trim();
      if (!text) return;

      const btn = captureForm.querySelector("button[type='submit']");
      input.disabled = true;
      if (btn) { btn.disabled = true; btn.textContent = "…"; }

      try {
        await mcpCall("capture_thought", { content: text, type: "task" });
        input.value = "";
        await storageRemove(CACHE_KEY);
        const data = await fetchFocus();
        state.tasks = data.tasks || [];
        await setCached(CACHE_KEY, data);
        renderAll();
      } catch (err) {
        if (btn) btn.textContent = "!";
      } finally {
        input.disabled = false;
        if (btn) {
          btn.disabled = false;
          setTimeout(() => { btn.textContent = "↑"; }, 800);
        }
        input.focus();
      }
    });
  }

  // Show config state or load data
  const cfg = await getConfig();
  if (!cfg) {
    showNoConfig();
    return;
  }

  showLoading();
  await loadData();
}

document.addEventListener("DOMContentLoaded", init);
