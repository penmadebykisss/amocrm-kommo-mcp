# amocrm-kommo-mcp — amoCRM и Kommo для ИИ-агентов

[![penmadebykisss/amocrm-kommo-mcp MCP server](https://glama.ai/mcp/servers/penmadebykisss/amocrm-kommo-mcp/badges/score.svg)](https://glama.ai/mcp/servers/penmadebykisss/amocrm-kommo-mcp)
[![CI](https://github.com/penmadebykisss/amocrm-kommo-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/penmadebykisss/amocrm-kommo-mcp/actions/workflows/ci.yml)

MCP-сервер, который подключает Claude, Cursor и других ИИ-ассистентов к **amoCRM** (и международной версии **Kommo**):
сделки, контакты, задачи и примечания — и **аналитика отдела продаж**, которую руководитель обычно собирает руками:
отчёт по воронке с конверсией и менеджерами, зависшие сделки без движения, просроченные задачи.

Спросите ассистента:
- *«Как идут продажи за сентябрь? Кто из менеджеров лучше закрывает?»*
- *«Какие сделки зависли больше недели и на какую сумму?»*
- *«Что у Анны просрочено сегодня?»*
- *«Найди клиента +7 900 123-45-67 и подготовь меня к звонку»*
- *«Создай сделку „Сайт для кафе“ на 90 000 с контактом Иван, +7 900…, и поставь задачу перезвонить завтра в 11»*

## Инструменты

| Инструмент | Что делает |
|---|---|
| `crm_account` | Аккаунт, менеджеры, воронки и этапы с id |
| `crm_search_leads` | Поиск сделок по тексту, воронке, этапу, менеджеру, периоду |
| `crm_get_lead` | Карточка сделки: контакты с телефонами, компания, открытые задачи, примечания |
| `crm_find_contact` | Поиск контакта по имени, телефону, e-mail |
| `crm_tasks` | Открытые, просроченные или сегодняшние задачи |
| `crm_pipeline_report` | Отчёт по воронке: этапы, выиграно/проиграно, конверсия, средний чек и цикл, рейтинг менеджеров |
| `crm_stale_leads` | Зависшие сделки: без изменений N дней, без задачи или с просроченной задачей |
| `crm_create_lead` ✏️ | Сделка сразу с контактом, компанией, тегами и примечанием |
| `crm_update_lead` ✏️ | Этап, бюджет, ответственный, теги, доп. поля; закрыть успешно/неуспешно |
| `crm_add_note` ✏️ | Примечание в сделку, контакт или компанию |
| `crm_create_task` ✏️ | Задача со сроком и ответственным |
| `crm_complete_task` ✏️ | Закрыть задачу с результатом |

✏️ — изменяют данные в CRM; ассистент должен показать, что запишет, и получить ваше согласие.

## Подключение

1. В amoCRM: **amoМаркет → ⋯ (справа вверху) → Создать интеграцию → Внешняя интеграция**, отметьте доступ ко всем данным,
   сохраните. На вкладке **Ключи и доступы** нажмите **Сгенерировать долгосрочный токен**.
2. Домен аккаунта — из адресной строки: `mycompany.amocrm.ru` (или `mycompany.kommo.com`).

Нужен [Node.js](https://nodejs.org) 18+.

### Claude Desktop

```json
{
  "mcpServers": {
    "amocrm": {
      "command": "npx",
      "args": ["-y", "github:penmadebykisss/amocrm-kommo-mcp"],
      "env": { "AMOCRM_DOMAIN": "mycompany.amocrm.ru", "AMOCRM_TOKEN": "долгосрочный токен" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add amocrm -e AMOCRM_DOMAIN=mycompany.amocrm.ru -e AMOCRM_TOKEN=токен -- npx -y github:penmadebykisss/amocrm-kommo-mcp
```

### Cursor, Windsurf и другие

Команда `npx`, аргументы `-y github:penmadebykisss/amocrm-kommo-mcp`, переменные `AMOCRM_DOMAIN` и `AMOCRM_TOKEN`.

### Облачная версия — без установки

Не хотите ставить Node.js и хранить токен у себя? Есть облачный доступ: вы получаете адрес и ключ
и подключаете сервер в Claude, Cursor или ChatGPT как удалённый MCP. Подписка — пишите в
[Telegram @penmadebykisss](https://t.me/penmadebykisss). Как развернуть такой сервер самому — [docs/cloud.md](docs/cloud.md).

## Ограничения

- Лимит amoCRM — 7 запросов в секунду; сервер сам выдерживает интервал и повторяет запрос при 429.
- Отчёт по воронке считает до 10 000 сделок за период (параметр `max_leads`).

## Проверка

```bash
npm test   # мок-сервер amoCRM API v4, реальный аккаунт не нужен
```

## Нужна настройка или доработка?

Подключу этот сервер под ключ: установка, настройка под ваши данные и процессы, доработка под нестандартные поля,
ежедневные сводки. Пишите в Telegram **[@penmadebykisss](https://t.me/penmadebykisss)** или оставьте заявку на
[penmadebykisss.github.io](https://penmadebykisss.github.io).

*Need help setting this up or a custom MCP server? Telegram [@penmadebykisss](https://t.me/penmadebykisss).*

## English

**amocrm-kommo-mcp** connects AI assistants to **amoCRM / Kommo** CRM: search and edit leads, create a lead with its
contact and company in one call, contacts lookup by phone or e-mail, notes, tasks — plus **sales analytics**: pipeline
report (stage totals, win rate, average deal and cycle, manager leaderboard), stale deals with no activity or no
scheduled task, overdue tasks. Set `AMOCRM_DOMAIN` (e.g. `mycompany.kommo.com`) and `AMOCRM_TOKEN` (long-lived token
of a private integration).

```bash
npx -y github:penmadebykisss/amocrm-kommo-mcp
```

## Смотрите также

- [ru-business-mcp](https://github.com/penmadebykisss/ru-business-mcp) — проверка контрагентов, курсы ЦБ, пени, производственный календарь
- [rf-marketplaces-mcp](https://github.com/penmadebykisss/rf-marketplaces-mcp) — аналитика Wildberries

## Лицензия

MIT
