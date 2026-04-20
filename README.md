# Open Brain — Today (Chrome Extension)

Замена новой вкладки: Claude каждое утро отбирает 3 главных задачи и пишет дневной бриф.

## Установка (dev-режим)

1. Распаковать ZIP в любую папку.
2. Открыть `chrome://extensions/`.
3. Включить **Developer mode** (справа вверху).
4. Нажать **Load unpacked** → выбрать распакованную папку.
5. Открыть новую вкладку → если конфиг не задан, появится кнопка «Настроить».

## Настройка

На странице настроек (или через кнопку «Настроить» в новой вкладке) укажи:

- **Format Focus URL** — `https://<project>.supabase.co/functions/v1/format-focus`
- **MCP Endpoint** — `https://<project>.supabase.co/functions/v1/open-brain-mcp`
- **API Key** — ключ, который бэкенд ждёт в `?key=`

Кнопка **Тест** проверит Format Focus и покажет число задач.

## Что где

- `newtab.html` / `newtab.js` / `newtab.css` — cockpit новой вкладки (Variant B).
- `options.html` / `options.js` — страница настроек.
- `manifest.json` — Manifest V3, оверрайд `newtab`, permissions: `storage`.

## Endpoints, которые вызывает расширение

- `GET {endpoint}?key=...` — format-focus, возвращает `{ tasks: [...] }`.
- `GET {endpoint (replace format-focus → daily-brief)}?key=...` — бриф (опц.).
- `POST {mcp}?key=...` — JSON-RPC `tools/call` с именами:
  - `complete_thought` — пометить задачу выполненной.
  - `process_update` — свободный апдейт по задаче (Claude сам решает, что делать).

## Кеш

- Задачи — 5 мин (`open-brain-today-cache`).
- Бриф — 60 мин (`open-brain-brief-cache`).
- Конфиг — `open-brain-today-config`.

Всё в `chrome.storage.local`. Сбросить можно через `chrome://extensions/` → Details → Clear data.
