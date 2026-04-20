/* Open Brain — Options page
 * Пишет конфиг в chrome.storage.local под ключом open-brain-today-config
 */

const KEY = "open-brain-today-config";

function storageGet(k) {
  return new Promise((r) => {
    if (chrome?.storage?.local) chrome.storage.local.get(k, (res) => r(res[k]));
    else r(JSON.parse(localStorage.getItem(k) || "null"));
  });
}
function storageSet(k, v) {
  return new Promise((r) => {
    if (chrome?.storage?.local) chrome.storage.local.set({ [k]: v }, r);
    else { localStorage.setItem(k, JSON.stringify(v)); r(); }
  });
}

function setStatus(msg, isError = false) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

async function load() {
  const cfg = (await storageGet(KEY)) || {};
  document.getElementById("endpoint").value = cfg.endpoint || "";
  document.getElementById("mcp").value = cfg.mcp || "";
  document.getElementById("key").value = cfg.key || "";
}

async function save() {
  const endpoint = document.getElementById("endpoint").value.trim();
  const mcp = document.getElementById("mcp").value.trim();
  const key = document.getElementById("key").value.trim();
  if (!endpoint || !key) {
    setStatus("Нужны как минимум Format Focus URL и API Key", true);
    return;
  }
  await storageSet(KEY, { endpoint, mcp, key });
  setStatus("Сохранено. Открой новую вкладку, чтобы увидеть задачи.");
}

async function test() {
  const endpoint = document.getElementById("endpoint").value.trim();
  const key = document.getElementById("key").value.trim();
  if (!endpoint || !key) {
    setStatus("Заполни URL и ключ перед тестом", true);
    return;
  }
  setStatus("Проверяю…");
  try {
    const res = await fetch(`${endpoint}?key=${encodeURIComponent(key)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const n = (data?.tasks || []).length;
    setStatus(`OK · получено задач: ${n}`);
  } catch (err) {
    setStatus(`Ошибка: ${err.message}`, true);
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);
load();
