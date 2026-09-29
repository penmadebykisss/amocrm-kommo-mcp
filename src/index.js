#!/usr/bin/env node
// MCP-сервер amoCRM / Kommo: сделки, контакты, задачи и примечания, плюс аналитика отдела продаж —
// отчёт по воронке, зависшие сделки, просроченные задачи по менеджерам.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as amo from './api.js';

const server = new McpServer({ name: 'amocrm-kommo', version: '1.0.1' }, {
  instructions: 'amoCRM / Kommo CRM. Сначала вызовите crm_account: он даёт id воронок, этапов и менеджеров для фильтров и записи. ' +
    'Вопросы руководителя («как идут продажи», «кто лучше закрывает», «что зависло») — crm_pipeline_report, crm_stale_leads, crm_tasks. ' +
    'Перед звонком клиенту — crm_find_contact и crm_get_lead. Инструменты создания и изменения пишут в живую CRM: ' +
    'покажите пользователю, что будет записано, и дождитесь согласия. ' +
    'Start with crm_account for pipeline, stage and user ids; write tools change live CRM data and need user confirmation.',
});

const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = e => ({ isError: true, content: [{ type: 'text', text: 'Ошибка: ' + (e?.message || String(e)) }] });
const safe = fn => async args => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

const Id = z.number().int().positive();
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}/).describe('Дата ГГГГ-ММ-ДД или дата-время ISO');
const readOnly = { readOnlyHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const WRITE_NOTE = ' Изменяет данные в CRM: покажите пользователю, что будет записано, и получите согласие.';

function leadView(l, d) {
  return {
    id: l.id, name: l.name, price: l.price,
    pipeline: d.pipeline(l.pipeline_id), pipeline_id: l.pipeline_id,
    status: d.status(l.pipeline_id, l.status_id), status_id: l.status_id,
    responsible: d.user(l.responsible_user_id), responsible_user_id: l.responsible_user_id,
    created_at: amo.date(l.created_at), updated_at: amo.date(l.updated_at), closed_at: amo.date(l.closed_at) || undefined,
    closest_task_at: amo.date(l.closest_task_at) || undefined,
    tags: l._embedded?.tags?.map(t => t.name) || undefined,
    contact_ids: l._embedded?.contacts?.map(c => c.id) || undefined,
    custom_fields: amo.customFields(l),
  };
}

function contactView(c, d) {
  return {
    id: c.id, name: c.name, ...amo.contactChannels(c),
    responsible: d.user(c.responsible_user_id),
    lead_ids: c._embedded?.leads?.map(x => x.id) || undefined,
    company_ids: c._embedded?.companies?.map(x => x.id) || undefined,
    created_at: amo.date(c.created_at), custom_fields: amo.customFields(c),
  };
}

// ================= Справочники =================

server.registerTool('crm_account', {
  title: 'Аккаунт, воронки и менеджеры',
  description: 'Справочник аккаунта amoCRM/Kommo: account (название, поддомен, валюта), users (id, name, email, active) и pipelines со statuses (id, name, type: open/won/lost). ' +
    'Вызывайте первым в разговоре: id воронок, этапов и менеджеров нужны фильтрам crm_search_leads, crm_tasks, crm_pipeline_report и записи в crm_create_lead / crm_update_lead. ' +
    'Результат кэшируется на 10 минут, повторно вызывать не нужно. Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически. Только чтение.',
  inputSchema: {},
  annotations: readOnly,
}, safe(async () => {
  const [acc, d] = await Promise.all([amo.getAccount(), amo.dictionaries()]);
  return {
    account: { id: acc.id, name: acc.name, subdomain: acc.subdomain, currency: acc.currency, country: acc.country },
    users: d.users.map(u => ({ id: u.id, name: u.name, email: u.email, active: u.rights?.is_active })),
    pipelines: d.pipelines.map(p => ({
      id: p.id, name: p.name, is_main: p.is_main,
      statuses: (p._embedded?.statuses || []).map(s => ({ id: s.id, name: s.name, type: s.id === amo.WON ? 'won' : s.id === amo.LOST ? 'lost' : 'open' })),
    })),
  };
}));

// ================= Сделки =================

server.registerTool('crm_search_leads', {
  title: 'Поиск сделок',
  description: 'Ищет сделки по тексту (название, телефон, e-mail, значения полей) и фильтрам: воронка, этап, ответственный, период создания. ' +
    'Возвращает count, total_budget и leads (id, name, price, pipeline, status, responsible, даты, tags, contact_ids, custom_fields), свежие изменения первыми. ' +
    'Используйте, чтобы найти сделку или список сделок; полная карточка с контактами и задачами — crm_get_lead, агрегированная аналитика — crm_pipeline_report, зависшие сделки — crm_stale_leads. ' +
    'Этап фильтруется только вместе с pipeline_id (иначе ошибка). Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически. Только чтение.',
  inputSchema: {
    query: z.string().optional().describe('Поисковая строка'),
    pipeline_id: Id.optional().describe('ID воронки (из crm_account)'),
    status_id: Id.optional().describe('ID этапа воронки (из crm_account); 142 — успешно, 143 — проиграно').describe('Этап (нужен вместе с pipeline_id); 142 — успешно, 143 — проиграно'),
    responsible_user_id: Id.optional().describe('ID ответственного менеджера (из crm_account)'),
    created_from: DateStr.optional().describe('Созданы не раньше этой даты'), created_to: DateStr.optional().describe('Созданы не позже этой даты'),
    limit: z.number().int().min(1).max(250).default(50).describe('Максимум сделок в ответе'),
  },
  annotations: readOnly,
}, safe(async ({ query, pipeline_id, status_id, responsible_user_id, created_from, created_to, limit }) => {
  if (status_id && !pipeline_id) throw new Error('Для фильтра по этапу укажите и pipeline_id');
  const filter = {
    ...(status_id ? { statuses: [{ pipeline_id, status_id }] } : pipeline_id ? { pipeline_id: [pipeline_id] } : {}),
    ...(responsible_user_id ? { responsible_user_id: [responsible_user_id] } : {}),
    ...(created_from || created_to ? { created_at: { from: amo.ts(created_from), to: amo.ts(created_to) } } : {}),
  };
  const [leads, d] = await Promise.all([
    amo.list('/leads', 'leads', { query, filter, with: 'contacts', order: { updated_at: 'desc' } }, limit),
    amo.dictionaries(),
  ]);
  return { count: leads.length, total_budget: leads.reduce((s, l) => s + (l.price || 0), 0), leads: leads.map(l => leadView(l, d)) };
}));

server.registerTool('crm_get_lead', {
  title: 'Карточка сделки',
  description: 'Полная карточка одной сделки по id: всё из crm_search_leads плюс contacts (телефоны, e-mail, доп. поля, is_main), company, open_tasks (со сроком и флагом overdue) и последние notes (текст, автор, дата). ' +
    'Используйте перед звонком или письмо клиенту, чтобы понять историю; id берите из crm_search_leads или crm_find_contact. ' +
    'Несуществующий id вернёт ошибку «не найдена». Делает 3–5 запросов к API. Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически. Только чтение.',
  inputSchema: { id: Id.describe('ID сделки'), notes_limit: z.number().int().min(0).max(100).default(10) },
  annotations: readOnly,
}, safe(async ({ id, notes_limit }) => {
  const [l, d] = await Promise.all([amo.api(`/leads/${id}`, { query: { with: 'contacts,companies' } }), amo.dictionaries()]);
  if (!l) throw new Error(`Сделка ${id} не найдена`);
  const contactIds = l._embedded?.contacts?.map(c => c.id) || [];
  const companyId = l._embedded?.companies?.[0]?.id;
  const [contacts, company, tasks, notes] = await Promise.all([
    contactIds.length ? amo.list('/contacts', 'contacts', { filter: { id: contactIds } }, 50) : [],
    companyId ? amo.api(`/companies/${companyId}`) : null,
    amo.list('/tasks', 'tasks', { filter: { entity_type: 'leads', entity_id: [id], is_completed: 0 } }, 50),
    notes_limit ? amo.list(`/leads/${id}/notes`, 'notes', { order: { id: 'desc' } }, notes_limit) : [],
  ]);
  return {
    ...leadView(l, d),
    contacts: contacts.map(c => ({ ...contactView(c, d), is_main: l._embedded.contacts.find(x => x.id === c.id)?.is_main })),
    company: company ? { id: company.id, name: company.name, custom_fields: amo.customFields(company) } : undefined,
    open_tasks: tasks.map(t => ({ id: t.id, text: t.text, due: amo.date(t.complete_till), responsible: d.user(t.responsible_user_id), overdue: t.complete_till * 1000 < Date.now() })),
    notes: notes.map(n => ({ id: n.id, type: n.note_type, text: n.params?.text || n.params?.service || undefined, params: n.params?.text ? undefined : n.params, author: d.user(n.created_by), at: amo.date(n.created_at) })),
  };
}));

server.registerTool('crm_create_lead', {
  title: 'Создать сделку с контактом',
  description: 'Создаёт сделку одним запросом вместе с новым контактом (имя, телефон, e-mail), компанией и тегами; при note добавляет примечание. ' +
    'Без pipeline_id/status_id сделка встаёт в первый этап основной воронки; id бери из crm_account. amoCRM может склеить контакт с существующим — тогда merged_with_existing=true. ' +
    'Возвращает lead_id, contact_id, company_id. Чтобы изменить уже существующую сделку, используйте crm_update_lead; не создавайте дубль — сначала проверьте crm_find_contact. ' +
    'Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически.' + WRITE_NOTE,
  inputSchema: {
    name: z.string().min(1).describe('Название сделки'),
    price: z.number().int().min(0).optional().describe('Бюджет'),
    pipeline_id: Id.optional().describe('ID воронки (из crm_account)'), status_id: Id.optional().describe('ID этапа воронки (из crm_account); 142 — успешно, 143 — проиграно'), responsible_user_id: Id.optional().describe('ID ответственного менеджера (из crm_account)'),
    contact_name: z.string().optional().describe('Имя контакта'), phone: z.string().optional().describe('Телефон контакта, например +79001234567'), email: z.string().optional().describe('E-mail контакта'),
    company_name: z.string().optional().describe('Название компании клиента'),
    tags: z.array(z.string()).optional().describe('Теги сделки'),
    note: z.string().optional().describe('Текст примечания к сделке'),
  },
  annotations: write,
}, safe(async a => {
  const cf = [
    a.phone && { field_code: 'PHONE', values: [{ value: a.phone, enum_code: 'WORK' }] },
    a.email && { field_code: 'EMAIL', values: [{ value: a.email, enum_code: 'WORK' }] },
  ].filter(Boolean);
  const lead = {
    name: a.name, price: a.price, pipeline_id: a.pipeline_id, status_id: a.status_id, responsible_user_id: a.responsible_user_id,
    _embedded: {
      ...(a.contact_name || cf.length ? { contacts: [{ name: a.contact_name || a.phone || a.email, ...(cf.length ? { custom_fields_values: cf } : {}) }] } : {}),
      ...(a.company_name ? { companies: [{ name: a.company_name }] } : {}),
      ...(a.tags?.length ? { tags: a.tags.map(name => ({ name })) } : {}),
    },
  };
  const [r] = await amo.api('/leads/complex', { method: 'POST', body: [lead] });
  if (a.note) await amo.api('/leads/notes', { method: 'POST', body: [{ entity_id: r.id, note_type: 'common', params: { text: a.note } }] });
  return { created: true, lead_id: r.id, contact_id: r.contact_id || undefined, company_id: r.company_id || undefined, merged_with_existing: r.merged || undefined };
}));

server.registerTool('crm_update_lead', {
  title: 'Изменить сделку',
  description: 'Частично обновляет существующую сделку: передавайте только поля, которые меняются. Перевод по воронке — status_id (+ pipeline_id при смене воронки), ' +
    'закрыть успешно — status_id 142, проиграно — 143; tags заменяют весь набор тегов; custom_fields — [{field_id, value}]. ' +
    'Возвращает updated и список changed. Без изменяемых полей — ошибка. Новую сделку создаёт crm_create_lead, примечание — crm_add_note. ' +
    'Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически.' + WRITE_NOTE,
  inputSchema: {
    id: Id.describe('ID сделки'),
    name: z.string().optional().describe('Новое название'), price: z.number().int().min(0).optional().describe('Новый бюджет'),
    pipeline_id: Id.optional().describe('ID воронки (из crm_account)'), status_id: Id.optional().describe('ID этапа воронки (из crm_account); 142 — успешно, 143 — проиграно'), responsible_user_id: Id.optional().describe('ID ответственного менеджера (из crm_account)'),
    tags: z.array(z.string()).optional().describe('Теги (заменяют текущие)'),
    custom_fields: z.array(z.object({ field_id: Id.describe('ID доп. поля'), value: z.union([z.string(), z.number(), z.boolean()]).describe('Значение') })).optional()
      .describe('Доп. поля: [{field_id, value}]; id полей — в карточке сделки или настройках amoCRM'),
  },
  annotations: write,
}, safe(async ({ id, tags, custom_fields, ...rest }) => {
  const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if (tags) body._embedded = { tags: tags.map(name => ({ name })) };
  if (custom_fields) body.custom_fields_values = custom_fields.map(f => ({ field_id: f.field_id, values: [{ value: f.value }] }));
  if (!Object.keys(body).length) throw new Error('Нечего менять: передайте хотя бы одно поле');
  const r = await amo.api(`/leads/${id}`, { method: 'PATCH', body });
  return { updated: true, id: r?.id ?? id, changed: Object.keys(body) };
}));

// ================= Контакты =================

server.registerTool('crm_find_contact', {
  title: 'Найти контакт',
  description: 'Ищет контакты по имени, телефону (в любом формате) или e-mail — например при входящем звонке или письме. ' +
    'Возвращает contacts: id, name, phones, emails, responsible, lead_ids (связанные сделки), company_ids, custom_fields. ' +
    'Дальше откройте сделку через crm_get_lead; искать сами сделки удобнее crm_search_leads. Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически. Только чтение.',
  inputSchema: { query: z.string().min(2).describe('Имя, телефон или e-mail'), limit: z.number().int().min(1).max(100).default(10).describe('Максимум контактов') },
  annotations: readOnly,
}, safe(async ({ query, limit }) => {
  const [contacts, d] = await Promise.all([amo.list('/contacts', 'contacts', { query, with: 'leads' }, limit), amo.dictionaries()]);
  return { count: contacts.length, contacts: contacts.map(c => contactView(c, d)) };
}));

// ================= Примечания и задачи =================

server.registerTool('crm_add_note', {
  title: 'Добавить примечание',
  description: 'Добавляет обычное текстовое примечание в ленту сделки, контакта или компании: итог звонка, договорённости, комментарий. ' +
    'Не меняет поля сущности (для этого crm_update_lead) и не ставит задач (crm_create_task). Возвращает note_id. ' +
    'Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически.' + WRITE_NOTE,
  inputSchema: {
    entity_type: z.enum(['leads', 'contacts', 'companies']).default('leads').describe('Тип сущности: сделка, контакт или компания'),
    entity_id: Id.describe('ID сделки, контакта или компании'), text: z.string().min(1).describe('Текст примечания'),
  },
  annotations: write,
}, safe(async ({ entity_type, entity_id, text }) => {
  const r = await amo.api(`/${entity_type}/notes`, { method: 'POST', body: [{ entity_id, note_type: 'common', params: { text } }] });
  return { created: true, note_id: r?._embedded?.notes?.[0]?.id };
}));

server.registerTool('crm_tasks', {
  title: 'Задачи',
  description: 'Незавершённые задачи: scope=open — все, overdue — просроченные, today — со сроком до конца сегодняшнего дня; фильтры по ответственному и по сделке. ' +
    'Возвращает count и tasks (id, text, due, overdue, responsible, entity_type, entity_id), ближайшие сроки первыми. ' +
    'Используйте для «что просрочено у менеджера» и планирования дня; поставить задачу — crm_create_task, закрыть — crm_complete_task. Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически. Только чтение.',
  inputSchema: {
    scope: z.enum(['open', 'overdue', 'today']).default('open').describe('open — все незавершённые, overdue — просроченные, today — со сроком до конца сегодняшнего дня'),
    responsible_user_id: Id.optional().describe('ID ответственного менеджера (из crm_account)'),
    lead_id: Id.optional().describe('Только задачи этой сделки'),
    limit: z.number().int().min(1).max(500).default(100).describe('Максимум задач в ответе'),
  },
  annotations: readOnly,
}, safe(async ({ scope, responsible_user_id, lead_id, limit }) => {
  const now = Math.floor(Date.now() / 1000);
  const endOfDay = Math.floor(new Date(new Date().setHours(23, 59, 59, 999)).getTime() / 1000);
  const filter = {
    is_completed: 0,
    ...(responsible_user_id ? { responsible_user_id: [responsible_user_id] } : {}),
    ...(lead_id ? { entity_type: 'leads', entity_id: [lead_id] } : {}),
    ...(scope === 'overdue' ? { complete_till: { to: now } } : scope === 'today' ? { complete_till: { to: endOfDay } } : {}),
  };
  const [tasks, d] = await Promise.all([amo.list('/tasks', 'tasks', { filter, order: { complete_till: 'asc' } }, limit), amo.dictionaries()]);
  const shown = scope === 'overdue' ? tasks.filter(t => t.complete_till < now) : scope === 'today' ? tasks.filter(t => t.complete_till <= endOfDay) : tasks;
  return {
    count: shown.length,
    tasks: shown.map(t => ({
      id: t.id, text: t.text, due: amo.date(t.complete_till), overdue: t.complete_till < now,
      responsible: d.user(t.responsible_user_id), entity_type: t.entity_type, entity_id: t.entity_id,
    })),
  };
}));

server.registerTool('crm_create_task', {
  title: 'Поставить задачу',
  description: 'Ставит задачу со сроком: звонок или встреча, привязанная к сделке, контакту или компании (или без привязки), с ответственным. ' +
    'Дата без времени означает 18:00 по часовому поясу сервера; для точного времени передайте ISO с зоной, например 2026-10-01T11:00:00+03:00. ' +
    'Возвращает task_id и due. Закрыть задачу — crm_complete_task, посмотреть задачи — crm_tasks. ' +
    'Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически.' + WRITE_NOTE,
  inputSchema: {
    text: z.string().min(1).describe('Текст задачи, например «Перезвонить и обсудить КП»'),
    due: DateStr.describe('Срок: ГГГГ-ММ-ДД или дата-время ISO, например 2026-10-01T15:00:00+03:00'),
    entity_type: z.enum(['leads', 'contacts', 'companies']).default('leads').describe('Тип сущности: сделка, контакт или компания'),
    entity_id: Id.optional().describe('ID сделки, контакта или компании; без него задача не привязана'),
    responsible_user_id: Id.optional().describe('ID ответственного менеджера (из crm_account)'),
    task_type: z.enum(['call', 'meeting']).optional().describe('Тип: звонок или встреча; по умолчанию звонок'),
  },
  annotations: write,
}, safe(async ({ text, due, entity_type, entity_id, responsible_user_id, task_type }) => {
  const due_ts = amo.ts(/T/.test(due) ? due : due + 'T18:00:00');
  const body = [{ text, complete_till: due_ts, task_type_id: task_type === 'meeting' ? 2 : 1, responsible_user_id, ...(entity_id ? { entity_type, entity_id } : {}) }];
  const r = await amo.api('/tasks', { method: 'POST', body });
  return { created: true, task_id: r?._embedded?.tasks?.[0]?.id, due: amo.date(due_ts) };
}));

server.registerTool('crm_complete_task', {
  title: 'Завершить задачу',
  description: 'Закрывает задачу по id с текстом результата (например «Дозвонился, отправил КП»); результат виден в ленте сделки. ' +
    'id берите из crm_tasks или crm_get_lead. Закрытую задачу этим инструментом не открыть. Возвращает completed. ' +
    'Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически.' + WRITE_NOTE,
  inputSchema: { id: Id.describe('ID задачи'), result: z.string().min(1).describe('Результат выполнения') },
  annotations: write,
}, safe(async ({ id, result }) => {
  await amo.api(`/tasks/${id}`, { method: 'PATCH', body: { is_completed: true, result: { text: result } } });
  return { completed: true, id };
}));

// ================= Аналитика отдела продаж =================

server.registerTool('crm_pipeline_report', {
  title: 'Отчёт по воронке продаж',
  description: 'Аналитика отдела продаж по одной воронке для сделок, созданных за период (по умолчанию 30 дней): stages (сделки и бюджет по этапам), won/lost/open, ' +
    'win_rate_pct (успешные / закрытые), avg_deal, avg_cycle_days (от создания до успеха) и managers — рейтинг менеджеров по выигранному бюджету. ' +
    'Используйте для «как идут продажи», «кто лучше закрывает», сравнения месяцев; конкретные сделки ищите crm_search_leads, проблемные — crm_stale_leads. ' +
    'Загружает до max_leads сделок (truncated=true, если упёрлись), на больших периодах может занять десятки секунд. Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически. Только чтение.',
  inputSchema: {
    pipeline_id: Id.optional().describe('ID воронки (из crm_account)').describe('Воронка; по умолчанию основная'),
    created_from: DateStr.optional().describe('Начало периода (по умолчанию 30 дней назад)'),
    created_to: DateStr.optional().describe('Конец периода (по умолчанию сейчас)'),
    max_leads: z.number().int().min(50).max(10000).default(3000).describe('Сколько сделок максимум загрузить для расчёта'),
  },
  annotations: readOnly,
}, safe(async ({ pipeline_id, created_from, created_to, max_leads }) => {
  const d = await amo.dictionaries();
  const p = pipeline_id ? d.pipelines.find(x => x.id === pipeline_id) : d.pipelines.find(x => x.is_main) || d.pipelines[0];
  if (!p) throw new Error('Воронка не найдена');
  const from = created_from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const leads = await amo.list('/leads', 'leads', { filter: { pipeline_id: [p.id], created_at: { from: amo.ts(from), to: amo.ts(created_to) } } }, max_leads);
  const sum = xs => xs.reduce((s, l) => s + (l.price || 0), 0);
  const won = leads.filter(l => l.status_id === amo.WON), lost = leads.filter(l => l.status_id === amo.LOST);
  const closed = won.length + lost.length;
  const cycle = won.filter(l => l.closed_at).map(l => (l.closed_at - l.created_at) / 86400);
  const stages = (p._embedded?.statuses || []).map(s => {
    const xs = leads.filter(l => l.status_id === s.id);
    return { status_id: s.id, name: d.status(p.id, s.id), leads: xs.length, budget: sum(xs) };
  });
  const byUser = new Map();
  for (const l of leads) {
    const u = byUser.get(l.responsible_user_id) || { manager: d.user(l.responsible_user_id), leads: 0, won: 0, won_budget: 0, lost: 0, open_budget: 0 };
    u.leads++;
    if (l.status_id === amo.WON) { u.won++; u.won_budget += l.price || 0; }
    else if (l.status_id === amo.LOST) u.lost++;
    else u.open_budget += l.price || 0;
    byUser.set(l.responsible_user_id, u);
  }
  return {
    pipeline: p.name, period: { from, to: created_to || 'сейчас' }, leads: leads.length, truncated: leads.length >= max_leads || undefined,
    won: { count: won.length, budget: sum(won) }, lost: { count: lost.length, budget: sum(lost) },
    open: { count: leads.length - closed, budget: sum(leads) - sum(won) - sum(lost) },
    win_rate_pct: closed ? Math.round(won.length / closed * 1000) / 10 : null,
    avg_deal: won.length ? Math.round(sum(won) / won.length) : null,
    avg_cycle_days: cycle.length ? Math.round(cycle.reduce((a, b) => a + b, 0) / cycle.length * 10) / 10 : null,
    stages,
    managers: [...byUser.values()].map(u => ({ ...u, win_rate_pct: u.won + u.lost ? Math.round(u.won / (u.won + u.lost) * 1000) / 10 : null }))
      .sort((a, b) => b.won_budget - a.won_budget),
  };
}));

server.registerTool('crm_stale_leads', {
  title: 'Зависшие сделки',
  description: 'Открытые сделки под риском: без изменений days+ дней, без запланированной задачи или с просроченной задачей. ' +
    'Возвращает count, at_risk_budget и leads (id, name, price, stage, pipeline, responsible, idle_days, reasons), сначала самые дорогие. ' +
    'Используйте для «что зависло», ежедневной ревизии воронки и напоминаний менеджерам; общая картина — crm_pipeline_report, задачи — crm_tasks. ' +
    'Смотрит до 3000 открытых сделок. Требует AMOCRM_DOMAIN и AMOCRM_TOKEN; лимит amoCRM 7 запросов/с соблюдается автоматически. Только чтение.',
  inputSchema: {
    days: z.number().int().min(1).max(365).default(7).describe('Сколько дней без изменений считать зависанием'),
    pipeline_id: Id.optional().describe('ID воронки (из crm_account)'),
    responsible_user_id: Id.optional().describe('ID ответственного менеджера (из crm_account)'),
    include_no_task: z.boolean().default(true).describe('Добавить свежие сделки без запланированной задачи'),
    limit: z.number().int().min(1).max(500).default(50).describe('Максимум сделок в ответе'),
  },
  annotations: readOnly,
}, safe(async ({ days, pipeline_id, responsible_user_id, include_no_task, limit }) => {
  const d = await amo.dictionaries();
  const pipelines = pipeline_id ? d.pipelines.filter(p => p.id === pipeline_id) : d.pipelines;
  const statuses = pipelines.flatMap(p => (p._embedded?.statuses || []).filter(s => s.id !== amo.WON && s.id !== amo.LOST).map(s => ({ pipeline_id: p.id, status_id: s.id })));
  if (!statuses.length) return { count: 0, leads: [] };
  const leads = await amo.list('/leads', 'leads', {
    filter: { statuses, ...(responsible_user_id ? { responsible_user_id: [responsible_user_id] } : {}) },
    order: { updated_at: 'asc' },
  }, 3000);
  const now = Date.now() / 1000;
  const out = leads.map(l => {
    const idle = Math.floor((now - l.updated_at) / 86400);
    const reasons = [];
    if (idle >= days) reasons.push(`без изменений ${idle} дн.`);
    if (include_no_task && !l.closest_task_at) reasons.push('нет запланированной задачи');
    else if (l.closest_task_at && l.closest_task_at < now) reasons.push('задача просрочена');
    return { l, idle, reasons };
  }).filter(x => x.reasons.length)
    .sort((a, b) => (b.l.price || 0) - (a.l.price || 0) || b.idle - a.idle)
    .slice(0, limit);
  return {
    count: out.length, at_risk_budget: out.reduce((s, x) => s + (x.l.price || 0), 0),
    leads: out.map(({ l, idle, reasons }) => ({
      id: l.id, name: l.name, price: l.price, stage: d.status(l.pipeline_id, l.status_id), pipeline: d.pipeline(l.pipeline_id),
      responsible: d.user(l.responsible_user_id), idle_days: idle, reasons,
    })),
  };
}));

await server.connect(new StdioServerTransport());
