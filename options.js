const STORAGE_KEY = "open-brain-today-config";

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      resolve(result[STORAGE_KEY] || null);
    });
  });
}

async function saveConfig(endpoint, mcp, key) {
  const config = { endpoint, mcp, key };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: config }, resolve);
  });
}

async function load() {
  const config = await getConfig();
  if (config) {
    document.getElementById("endpoint").value = config.endpoint || "";
    document.getElementById("mcp").value = config.mcp || "";
    document.getElementById("key").value = config.key || "";
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const endpoint = document.getElementById("endpoint").value.trim();
  const mcp = document.getElementById("mcp").value.trim();
  const key = document.getElementById("key").value.trim();

  if (!endpoint || !key) {
    document.getElementById("status").textContent = "Заполни URL и ключ";
    document.getElementById("status").className = "status error";
    return;
  }

  await saveConfig(endpoint, mcp, key);
  document.getElementById("status").textContent = "Сохранено";
  document.getElementById("status").className = "status";
});

document.getElementById("test").addEventListener("click", async () => {
  const endpoint = document.getElementById("endpoint").value.trim();
  const key = document.getElementById("key").value.trim();
  const status = document.getElementById("status");

  if (!endpoint || !key) {
    status.textContent = "Заполни URL и ключ";
    status.className = "status error";
    return;
  }

  status.textContent = "Тестирую...";
  status.className = "status";

  try {
    const res = await fetch(`${endpoint}?key=${key}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const count = data.tasks?.length ?? 0;
    status.textContent = `OK — ${count} задач`;
    status.className = "status";
  } catch (err) {
    status.textContent = `Ошибка: ${err.message}`;
    status.className = "status error";
  }
});

load();
