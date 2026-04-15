// ── Config ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = "open-brain-today-config";
const TOP_N = 3;
const CACHE_KEY = "open-brain-today-cache";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getConfig() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEY, (result) => {
          resolve(result[STORAGE_KEY] || null);
        });
      });
    }
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

async function saveConfig(endpoint, mcp, key) {
  const config = { endpoint, mcp, key };
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: config }, resolve);
    });
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// ── Cache ─────────────────────────────────────────────────────────────────

async function getCachedTasks() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get(CACHE_KEY, (result) => {
          const cached = result[CACHE_KEY];
          if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
            resolve(cached.data);
          } else {
            resolve(null);
          }
        });
      });
    }
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;
    }
    return null;
  } catch {
    return null;
  }
}

async function setCachedTasks(data) {
  const entry = { data, ts: Date.now() };
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [CACHE_KEY]: entry }, resolve);
    });
  }
  localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
}

async function clearCache() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(CACHE_KEY, resolve);
    });
  }
  localStorage.removeItem(CACHE_KEY);
}

// ── API ───────────────────────────────────────────────────────────────────

async function fetchFocus() {
  const config = await getConfig();
  if (!config) throw new Error("Not configured");

  const url = `${config.endpoint}?key=${config.key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function mcpCall(toolName, args = {}) {
  const config = await getConfig();
  if (!config) throw new Error("Not configured");

  const url = `${config.mcp}?key=${config.key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.result?.content?.[0]?.text;
  if (!text) throw new Error("Empty response");
  return JSON.parse(text);
}

async function markDone(id) {
  await clearCache();
  return mcpCall("update_thought", { id, status: "done" });
}

async function processUpdate(taskId, updateText) {
  const config = await getConfig();
  if (!config) throw new Error("Not configured");

  // Derive process-update URL from format-focus endpoint
  const processUrl = config.endpoint.replace("format-focus", "process-update");
  const res = await fetch(`${processUrl}?key=${config.key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: taskId, update_text: updateText }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  await clearCache();
  return data;
}

// ── Sorting ──────────────────────────────────────────────────────────────

function sortTasks(tasks) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const nowMs = now.getTime();

  return [...tasks].sort((a, b) => {
    const areaOrder = { work: 0, finance: 1, learning: 2, personal: 3, health: 4, social: 5 };
    const aArea = areaOrder[a.area] ?? 3;
    const bArea = areaOrder[b.area] ?? 3;

    const aDl = a.due_date ? new Date(a.due_date).getTime() : null;
    const bDl = b.due_date ? new Date(b.due_date).getTime() : null;

    const aOverdue = aDl && aDl < nowMs;
    const bOverdue = bDl && bDl < nowMs;
    const aHasDl = aDl !== null;
    const bHasDl = bDl !== null;

    if (aOverdue && !bOverdue) return -1;
    if (!aOverdue && bOverdue) return 1;
    if (aHasDl && !bHasDl) return -1;
    if (!aHasDl && bHasDl) return 1;
    if (aHasDl && bHasDl) return aDl - bDl;
    if (aArea !== bArea) return aArea - bArea;
    return 0;
  });
}

// ── Rendering ────────────────────────────────────────────────────────────

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

function formatDate() {
  return new Date().toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatDeadline(dueDateStr) {
  if (!dueDateStr) return null;
  const dl = new Date(dueDateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((dl.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  let label, cls;
  if (diffDays < 0) {
    label = `${Math.abs(diffDays)}д просрочен`;
    cls = "overdue";
  } else if (diffDays === 0) {
    label = "сегодня";
    cls = "urgent";
  } else if (diffDays === 1) {
    label = "завтра";
    cls = "urgent";
  } else if (diffDays <= 7) {
    label = `${diffDays}д`;
    cls = "";
  } else {
    label = dl.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
    cls = "";
  }

  return { label, cls };
}

function buildTagsHtml(task) {
  let html = "";
  const dl = formatDeadline(task.due_date);
  if (dl) html += `<span class="task-deadline ${dl.cls}">${escapeHtml(dl.label)}</span>`;
  if (task.area) html += `<span class="task-area">${escapeHtml(task.area)}</span>`;
  if (task.topic) html += `<span class="task-topic">${escapeHtml(task.topic)}</span>`;
  return html;
}

function buildTaskHtml(task, index) {
  return `
    <li class="task-item" data-id="${task.id}">
      <span class="task-number">${index + 1}</span>
      <div class="task-body">
        <div class="task-title">${escapeHtml(task.title)}</div>
        <div class="task-tags">${buildTagsHtml(task)}</div>
      </div>
      <div class="task-check" data-id="${task.id}"></div>
    </li>`;
}

// ── Global state ─────────────────────────────────────────────────────────

let allTasks = [];
let activeTaskId = null;

// ── Detail panel ─────────────────────────────────────────────────────────

function getDetailElements(viewId) {
  const suffix = viewId === "all" ? "-all" : "";
  return {
    layout: document.getElementById(`split-layout${suffix}`),
    panel: document.getElementById(`detail-panel${suffix}`),
    title: document.getElementById(`detail-title${suffix}`),
    tags: document.getElementById(`detail-tags${suffix}`),
    content: document.getElementById(`detail-content${suffix}`),
    input: document.getElementById(`detail-input${suffix}`),
    sendBtn: document.getElementById(`detail-send${suffix}`),
    doneBtn: document.getElementById(`detail-done${suffix}`),
    closeBtn: document.getElementById(`detail-close${suffix}`),
  };
}

function openDetail(taskId, viewId) {
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) return;

  activeTaskId = taskId;
  const els = getDetailElements(viewId);

  // Highlight active task
  const listEl = viewId === "all"
    ? document.getElementById("all-tasks-list")
    : document.getElementById("tasks");
  listEl.querySelectorAll(".task-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.id === taskId);
  });

  // Fill detail panel
  els.title.textContent = task.title;
  els.tags.innerHTML = buildTagsHtml(task);
  els.content.textContent = task.content;
  els.input.value = "";

  // Show panel
  els.layout.classList.add("has-detail");
  els.panel.classList.remove("hidden");
  els.panel.classList.add("open");
  document.body.classList.add("detail-open");
}

function closeDetail(viewId) {
  activeTaskId = null;
  const els = getDetailElements(viewId);

  els.layout.classList.remove("has-detail");
  els.panel.classList.remove("open");
  setTimeout(() => {
    els.panel.classList.add("hidden");
  }, 350);
  document.body.classList.remove("detail-open");

  // Remove active highlight
  const listEl = viewId === "all"
    ? document.getElementById("all-tasks-list")
    : document.getElementById("tasks");
  listEl.querySelectorAll(".task-item.active").forEach((item) => {
    item.classList.remove("active");
  });
}

function getCurrentView() {
  return document.getElementById("all-tasks").classList.contains("hidden") ? "focus" : "all";
}

// ── Wire detail panel buttons ────────────────────────────────────────────

function wireDetailPanel(viewId) {
  const els = getDetailElements(viewId);

  els.closeBtn.addEventListener("click", () => closeDetail(viewId));

  els.doneBtn.addEventListener("click", async () => {
    if (!activeTaskId) return;
    const id = activeTaskId;
    els.doneBtn.disabled = true;
    els.doneBtn.textContent = "...";
    try {
      await markDone(id);
      allTasks = allTasks.filter((t) => t.id !== id);
      closeDetail(viewId);
      if (viewId === "all") renderAllTasks();
      else renderFocusTasks();
    } catch (err) {
      console.error("Done failed:", err);
      els.doneBtn.disabled = false;
      els.doneBtn.textContent = "Выполнено";
    }
  });

  els.sendBtn.addEventListener("click", () => submitDetailUpdate(viewId));
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitDetailUpdate(viewId);
    }
  });
}

async function submitDetailUpdate(viewId) {
  if (!activeTaskId) return;
  const els = getDetailElements(viewId);
  const text = els.input.value.trim();
  if (!text) return;

  const id = activeTaskId;
  els.sendBtn.disabled = true;
  els.input.disabled = true;
  els.sendBtn.textContent = "...";

  try {
    const result = await processUpdate(id, text);
    const action = result.action || {};

    // Task was marked done
    if (action.mark_done) {
      allTasks = allTasks.filter((t) => t.id !== id);
    } else {
      // Content was updated — refresh local state
      const task = allTasks.find((t) => t.id === id);
      if (task && action.append_to_content) {
        const date = new Date().toLocaleDateString("ru-RU");
        task.content = `${task.content}\n\n[${date}]: ${action.append_to_content}`;
        els.content.textContent = task.content;
      }
    }

    // New task was created or deadline changed — refresh everything
    const needsRefresh = action.mark_done || result.new_task_id || result.deadline_updated;

    if (needsRefresh) {
      // Refetch from format-focus to get fresh AI titles
      try {
        const data = await fetchFocus();
        allTasks = sortTasks(data.tasks || []);
        await setCachedTasks(data);
      } catch {
        // If refresh fails, just use what we have
      }
      closeDetail(viewId);
      if (viewId === "all") renderAllTasks();
      else renderFocusTasks();

      // Show notification
      if (result.new_task_content) {
        showNotification(`Новая задача: ${result.new_task_content}`);
      } else if (action.mark_done) {
        showNotification("Задача выполнена");
      } else if (result.deadline_updated) {
        const d = new Date(result.deadline_updated).toLocaleDateString("ru-RU");
        showNotification(`Дедлайн сдвинут на ${d}`);
      }
    } else {
      els.input.value = "";
      els.sendBtn.textContent = "\u2713";
      setTimeout(() => { els.sendBtn.textContent = "\u2191"; }, 1000);
    }
  } catch (err) {
    console.error("Update failed:", err);
    els.sendBtn.textContent = "!";
    setTimeout(() => { els.sendBtn.textContent = "\u2191"; }, 1500);
  } finally {
    els.sendBtn.disabled = false;
    els.input.disabled = false;
  }
}

function showNotification(text) {
  let el = document.getElementById("notification");
  if (!el) {
    el = document.createElement("div");
    el.id = "notification";
    el.className = "notification";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3000);
}

// ── Task list rendering ──────────────────────────────────────────────────

function updateRemaining() {
  const rem = document.getElementById("remaining");
  const waiting = allTasks.length - TOP_N;
  if (waiting > 0) {
    rem.textContent = `+ ещё ${waiting} задач`;
    rem.classList.remove("hidden");
  } else {
    rem.classList.add("hidden");
  }
}

function bindTaskEvents(el, viewId) {
  el.querySelectorAll(".task-check").forEach((cb) => {
    cb.addEventListener("click", handleCheck);
  });
  el.querySelectorAll(".task-title").forEach((title) => {
    title.addEventListener("click", () => {
      const taskId = title.closest(".task-item").dataset.id;
      if (activeTaskId === taskId) {
        closeDetail(viewId);
      } else {
        openDetail(taskId, viewId);
      }
    });
  });
}

function renderFocusTasks() {
  const el = document.getElementById("tasks");

  if (allTasks.length === 0) {
    el.innerHTML = '<li class="task-item" style="opacity:1; text-align:center; display:block;"><span class="task-title" style="color:#444; cursor:default;">Нет открытых задач. Свободный день.</span></li>';
    return;
  }

  const visible = allTasks.slice(0, TOP_N);
  el.innerHTML = visible.map((task, i) => buildTaskHtml(task, i)).join("");
  updateRemaining();
  bindTaskEvents(el, "focus");
}

// 4 quadrants: group areas into logical blocks
const QUADRANTS = [
  { key: "work",     areas: ["work"],                label: "Работа",   color: "#3a5ba0" },
  { key: "finance",  areas: ["finance"],              label: "Финансы",  color: "#8a6520" },
  { key: "personal", areas: ["personal"],             label: "Личное",   color: "#6a4a8a" },
  { key: "other",    areas: ["health", "learning", "social", "other"], label: "Прочее", color: "#2d6a4f" },
];

function buildCompactTaskHtml(task, idx) {
  let dlHtml = "";
  const dl = formatDeadline(task.due_date);
  if (dl) dlHtml = `<span class="q-deadline ${dl.cls}">${escapeHtml(dl.label)}</span>`;

  let topicHtml = "";
  if (task.topic) topicHtml = `<span class="q-topic">${escapeHtml(task.topic)}</span>`;

  return `
    <li class="q-item task-item" data-id="${task.id}">
      <div class="q-text task-title">${escapeHtml(task.title)}</div>
      <div class="q-meta">${dlHtml}${topicHtml}</div>
      <div class="task-check q-check" data-id="${task.id}"></div>
    </li>`;
}

function renderAllTasks() {
  const el = document.getElementById("all-tasks-list");

  if (allTasks.length === 0) {
    el.innerHTML = '<div class="group-empty">Нет открытых задач</div>';
    return;
  }

  // Bucket tasks into quadrants
  const buckets = {};
  for (const q of QUADRANTS) buckets[q.key] = [];

  for (const task of allTasks) {
    const area = task.area || "other";
    const quad = QUADRANTS.find((q) => q.areas.includes(area)) || QUADRANTS[3];
    buckets[quad.key].push(task);
  }

  let html = '<div class="quadrant-grid">';

  for (const q of QUADRANTS) {
    const tasks = buckets[q.key];
    const count = tasks.length;

    html += `<div class="quadrant" data-area="${q.key}">`;
    html += `<div class="q-header">
      <div class="q-indicator" style="background: ${q.color}"></div>
      <span class="q-label">${q.label}</span>
      <span class="q-count">${count}</span>
    </div>`;

    if (count === 0) {
      html += '<div class="q-empty">Нет задач</div>';
    } else {
      html += '<ul class="q-list">';
      for (const task of tasks) {
        html += buildCompactTaskHtml(task);
      }
      html += '</ul>';
    }

    html += '</div>';
  }

  html += '</div>';
  el.innerHTML = html;
  bindTaskEvents(el, "all");
}

async function handleCheck(e) {
  const cb = e.currentTarget;
  const id = cb.dataset.id;
  const item = cb.closest(".task-item");

  if (item.classList.contains("leaving")) return;

  cb.classList.add("done");
  item.classList.add("checked");

  try {
    await markDone(id);
  } catch (err) {
    cb.classList.remove("done");
    item.classList.remove("checked");
    console.error("Failed:", err);
    return;
  }

  // Close detail if this task was open
  if (activeTaskId === id) {
    closeDetail(getCurrentView());
  }

  allTasks = allTasks.filter((t) => t.id !== id);
  item.classList.add("leaving");

  item.addEventListener("animationend", () => {
    const view = getCurrentView();
    if (view === "all") {
      renderAllTasks();
    } else {
      const el = document.getElementById("tasks");
      const visible = allTasks.slice(0, TOP_N);

      if (visible.length === 0) {
        el.innerHTML = '<li class="task-item entering" style="opacity:1; text-align:center; display:block;"><span class="task-title" style="color:#444; cursor:default;">Все задачи выполнены. Красота.</span></li>';
        document.getElementById("remaining").classList.add("hidden");
        return;
      }

      el.innerHTML = visible.map((task, i) => buildTaskHtml(task, i)).join("");
      updateRemaining();

      const items = el.querySelectorAll(".task-item");
      if (items.length > 0) {
        items[items.length - 1].classList.add("entering");
      }

      bindTaskEvents(el, "focus");
    }
  }, { once: true });
}

// ── Quick capture ────────────────────────────────────────────────────────

async function captureTask(text) {
  const input = document.getElementById("capture-input");
  const btn = document.getElementById("capture-btn");

  input.disabled = true;
  btn.disabled = true;
  btn.textContent = "...";

  try {
    await mcpCall("capture_thought", { content: text, type: "task" });
    input.value = "";
    await clearCache();

    // Refresh tasks
    try {
      const data = await fetchFocus();
      allTasks = sortTasks(data.tasks || []);
      await setCachedTasks(data);
      renderFocusTasks();
    } catch {
      // silent
    }

    showNotification("Задача добавлена");
  } catch (err) {
    console.error("Capture failed:", err);
    btn.textContent = "!";
    setTimeout(() => { btn.textContent = "\u2191"; }, 1500);
  } finally {
    input.disabled = false;
    btn.disabled = false;
    btn.textContent = "\u2191";
    input.focus();
  }
}

// ── Explore / Collapse ───────────────────────────────────────────────────

function showAllTasks() {
  closeDetail("focus");
  document.getElementById("focus").classList.add("hidden");
  document.getElementById("all-tasks").classList.remove("hidden");
  document.body.classList.add("all-open");
  renderAllTasks();
}

function showFocus() {
  closeDetail("all");
  document.getElementById("all-tasks").classList.add("hidden");
  document.getElementById("focus").classList.remove("hidden");
  document.body.classList.remove("all-open");
  renderFocusTasks();
}

// ── Settings ─────────────────────────────────────────────────────────────

async function showSettings() {
  const config = await getConfig();
  document.getElementById("settings-endpoint").value = config?.endpoint || "";
  document.getElementById("settings-mcp").value = config?.mcp || "";
  document.getElementById("settings-key").value = config?.key || "";
  document.getElementById("settings-overlay").classList.remove("hidden");
}

function hideSettings() {
  document.getElementById("settings-overlay").classList.add("hidden");
}

document.getElementById("gear-btn").addEventListener("click", showSettings);
document.getElementById("setup-btn")?.addEventListener("click", showSettings);
document.getElementById("settings-cancel").addEventListener("click", hideSettings);
document.getElementById("settings-save").addEventListener("click", async () => {
  const endpoint = document.getElementById("settings-endpoint").value.trim();
  const mcp = document.getElementById("settings-mcp").value.trim();
  const key = document.getElementById("settings-key").value.trim();

  if (!endpoint || !key) {
    if (!endpoint) document.getElementById("settings-endpoint").style.borderColor = "#c66";
    if (!key) document.getElementById("settings-key").style.borderColor = "#c66";
    return;
  }

  await saveConfig(endpoint, mcp, key);
  hideSettings();
  init();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const view = getCurrentView();
    if (activeTaskId) {
      closeDetail(view);
    } else if (view === "all") {
      showFocus();
    } else {
      hideSettings();
    }
  }
});

document.getElementById("explore-btn").addEventListener("click", showAllTasks);
document.getElementById("collapse-btn").addEventListener("click", showFocus);
document.getElementById("remaining").addEventListener("click", showAllTasks);

// Quick capture
document.getElementById("capture-btn").addEventListener("click", () => {
  const text = document.getElementById("capture-input").value.trim();
  if (text) captureTask(text);
});
document.getElementById("capture-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const text = e.target.value.trim();
    if (text) captureTask(text);
  }
});

// Wire both detail panels
wireDetailPanel("focus");
wireDetailPanel("all");

// ── Init ─────────────────────────────────────────────────────────────────

async function init() {
  document.getElementById("greeting").textContent = getGreeting();
  document.getElementById("date").textContent = formatDate();

  const config = await getConfig();

  document.getElementById("loading").classList.remove("hidden");
  document.getElementById("error").classList.add("hidden");
  document.getElementById("no-config").classList.add("hidden");
  document.getElementById("focus").classList.add("hidden");
  document.getElementById("all-tasks").classList.add("hidden");
  document.body.classList.remove("all-open");
  document.body.classList.remove("detail-open");

  if (!config) {
    document.getElementById("loading").classList.add("hidden");
    document.getElementById("no-config").classList.remove("hidden");
    return;
  }

  try {
    // Try cache first for instant display
    const cached = await getCachedTasks();
    if (cached) {
      allTasks = sortTasks(cached.tasks || []);
      document.getElementById("loading").classList.add("hidden");
      document.getElementById("focus").classList.remove("hidden");
      document.getElementById("explore-btn").classList.remove("hidden");
      document.getElementById("capture-bar").classList.remove("hidden");
      renderFocusTasks();

      // Refresh in background
      fetchFocus().then((data) => {
        allTasks = sortTasks(data.tasks || []);
        setCachedTasks(data);
        if (!activeTaskId) renderFocusTasks();
      }).catch((err) => console.error("Background refresh failed:", err));
      return;
    }

    const data = await fetchFocus();
    allTasks = sortTasks(data.tasks || []);
    await setCachedTasks(data);

    document.getElementById("loading").classList.add("hidden");
    document.getElementById("focus").classList.remove("hidden");
    document.getElementById("explore-btn").classList.remove("hidden");
    document.getElementById("capture-bar").classList.remove("hidden");

    renderFocusTasks();
  } catch (err) {
    document.getElementById("loading").classList.add("hidden");
    const errorEl = document.getElementById("error");
    errorEl.textContent = `Ошибка: ${err.message}`;
    errorEl.classList.remove("hidden");
  }
}

init();
