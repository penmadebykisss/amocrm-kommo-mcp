# Облачный режим (платный доступ)

Клиент не ставит Node.js и не хранит токен amoCRM: он получает адрес и ключ и подключает сервер в Claude, Cursor или ChatGPT
как удалённый MCP. Вы держите сервер у себя и управляете подписками в файле `clients.json`.

## Запуск на сервере (VPS от ~300 ₽/мес)

```bash
git clone https://github.com/penmadebykisss/amocrm-kommo-mcp.git && cd amocrm-kommo-mcp
npm ci --omit=dev
MCP_HTTP_PORT=8787 CLIENTS_FILE=/etc/amocrm-mcp/clients.json node src/index.js --http
```

Поставьте перед ним HTTPS (Caddy сам получит сертификат):

```
mcp.example.ru {
  reverse_proxy 127.0.0.1:8787
}
```

Проверка: `https://mcp.example.ru/health` → `{"ok":true}`.

## Клиенты

```bash
# новый клиент: название, домен amoCRM, его долгосрочный токен, оплачено до
CLIENTS_FILE=/etc/amocrm-mcp/clients.json node scripts/add-client.js "ООО Ромашка" romashka.amocrm.ru <токен> 2026-11-30
# продление
CLIENTS_FILE=/etc/amocrm-mcp/clients.json node scripts/add-client.js --renew <ключ> 2026-12-31
```

Файл перечитывается на лету — перезапуск не нужен. После даты `paid_until` сервер отвечает клиенту
«Подписка закончилась, продлить: t.me/penmadebykisss». Лимит — 120 запросов в минуту на ключ (`RATE_PER_MIN`).

## Что отправить клиенту

- Адрес: `https://mcp.example.ru/mcp`
- Заголовок: `Authorization: Bearer <ключ>`

Claude Code:

```bash
claude mcp add --transport http amocrm https://mcp.example.ru/mcp --header "Authorization: Bearer <ключ>"
```

## Безопасность

- `clients.json` содержит токены amoCRM клиентов: права 600, не в git (уже в `.gitignore`), резервная копия — зашифрованная.
- Каждый запрос обрабатывается отдельным экземпляром сервера в контексте своего клиента; кэш справочников разделён по аккаунтам.
- Токен amoCRM клиент может отозвать в любой момент в настройках интеграции.
