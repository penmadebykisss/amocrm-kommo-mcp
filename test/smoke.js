// Дымовой тест: локальный мок amoCRM API v4 + сервер как MCP-клиент. Проверяет запросы и разбор ответов всех инструментов.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const now = Math.floor(Date.now() / 1000), day = 86400;
const pipelines = [{ id: 10, name: 'Продажи', is_main: true, _embedded: { statuses: [
  { id: 1, name: 'Первичный контакт' }, { id: 2, name: 'Переговоры' }, { id: 142, name: 'Успешно' }, { id: 143, name: 'Отказ' }] } }];
const users = [{ id: 7, name: 'Анна', email: 'anna@x.ru', rights: { is_active: true } }, { id: 8, name: 'Борис', email: 'b@x.ru', rights: { is_active: true } }];
const leads = [
  { id: 101, name: 'Сайт для кафе', price: 90000, pipeline_id: 10, status_id: 2, responsible_user_id: 7, created_at: now - 20 * day, updated_at: now - 12 * day, closest_task_at: null, _embedded: { contacts: [{ id: 201, is_main: true }], companies: [{ id: 301 }], tags: [{ name: 'сайт' }] } },
  { id: 102, name: 'Лендинг', price: 40000, pipeline_id: 10, status_id: 142, responsible_user_id: 7, created_at: now - 15 * day, updated_at: now - 2 * day, closed_at: now - 5 * day, _embedded: {} },
  { id: 103, name: 'CRM-интеграция', price: 150000, pipeline_id: 10, status_id: 143, responsible_user_id: 8, created_at: now - 10 * day, updated_at: now - 1 * day, closed_at: now - 1 * day, _embedded: {} },
  { id: 104, name: 'Бот', price: 30000, pipeline_id: 10, status_id: 1, responsible_user_id: 8, created_at: now - 3 * day, updated_at: now - 1 * day, closest_task_at: now + day, _embedded: {} },
];
const contacts = [{ id: 201, name: 'Иван Петров', responsible_user_id: 7, created_at: now - 20 * day,
  custom_fields_values: [{ field_code: 'PHONE', field_name: 'Телефон', values: [{ value: '+79001234567' }] }, { field_code: 'EMAIL', field_name: 'Email', values: [{ value: 'ivan@cafe.ru' }] }, { field_id: 5, field_name: 'Должность', values: [{ value: 'Директор' }] }],
  _embedded: { leads: [{ id: 101 }] } }];
const tasks = [
  { id: 401, text: 'Перезвонить', complete_till: now - day, responsible_user_id: 7, entity_type: 'leads', entity_id: 101, is_completed: false },
  { id: 402, text: 'Отправить КП', complete_till: now + 3 * day, responsible_user_id: 8, entity_type: 'leads', entity_id: 104, is_completed: false },
];
const log = [];

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const url = decodeURIComponent(req.url);
    log.push({ method: req.method, url, body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization });
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/hal+json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    const p = url.split('?')[0];
    const page = Number((url.match(/page=(\d+)/) || [])[1] || 1);
    const pageOf = (key, items) => page > 1 ? send(204) : send(200, { _embedded: { [key]: items }, _links: {} });
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { title: 'Unauthorized' });
    if (p === '/api/v4/account') return send(200, { id: 1, name: 'Студия', subdomain: 'studio', currency: 'RUB', country: 'RU' });
    if (p === '/api/v4/users') return pageOf('users', users);
    if (p === '/api/v4/leads/pipelines') return send(200, { _embedded: { pipelines } });
    if (p === '/api/v4/leads' && req.method === 'GET') {
      let xs = leads;
      const q = (url.match(/query=([^&]*)/) || [])[1];
      if (q) xs = xs.filter(l => l.name.toLowerCase().includes(q.toLowerCase()));
      const st = [...url.matchAll(/filter\[statuses\]\[\d+\]\[status_id\]=(\d+)/g)].map(m => Number(m[1]));
      if (st.length) xs = xs.filter(l => st.includes(l.status_id));
      return xs.length ? pageOf('leads', xs) : send(204);
    }
    if (p === '/api/v4/leads/101') return send(200, leads[0]);
    if (p === '/api/v4/leads/999') return send(204);
    if (p === '/api/v4/leads/101/notes') return pageOf('notes', [{ id: 501, note_type: 'common', params: { text: 'Клиент просил скидку' }, created_by: 7, created_at: now - day }]);
    if (p === '/api/v4/contacts') return pageOf('contacts', contacts);
    if (p === '/api/v4/companies/301') return send(200, { id: 301, name: 'ООО Кафе' });
    if (p === '/api/v4/tasks' && req.method === 'GET') {
      let xs = tasks;
      const to = (url.match(/filter\[complete_till\]\[to\]=(\d+)/) || [])[1];
      if (to) xs = xs.filter(t => t.complete_till <= Number(to));
      const eid = (url.match(/filter\[entity_id\]\[\]=(\d+)/) || [])[1];
      if (eid) xs = xs.filter(t => t.entity_id === Number(eid));
      return pageOf('tasks', xs);
    }
    if (p === '/api/v4/leads/complex') return send(200, [{ id: 105, contact_id: 202, company_id: 302, merged: false }]);
    if (p === '/api/v4/leads/notes' || p === '/api/v4/contacts/notes') return send(200, { _embedded: { notes: [{ id: 502 }] } });
    if (p === '/api/v4/leads/101' && req.method === 'PATCH') return send(200, { id: 101 });
    if (p === '/api/v4/tasks' && req.method === 'POST') return send(200, { _embedded: { tasks: [{ id: 403 }] } });
    if (p === '/api/v4/tasks/401') return send(200, { id: 401 });
    send(404, { title: 'Not found ' + p });
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;

let failed = 0;
async function connect(env) {
  const c = new Client({ name: 'smoke', version: '0' });
  const clean = { ...process.env }; for (const k of ['AMOCRM_TOKEN', 'AMOCRM_DOMAIN', 'KOMMO_TOKEN', 'KOMMO_DOMAIN', 'AMOCRM_BASE_URL']) delete clean[k];
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ['src/index.js'], env: { ...clean, ...env } }));
  return c;
}
async function run(client, name, args, check) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || '';
  let ok;
  try { ok = check(r.isError ? null : JSON.parse(text), text, r.isError); } catch { ok = false; }
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
}
const last = (method, path) => [...log].reverse().find(l => l.method === method && l.url.startsWith('/api/v4' + path));

// Без настроек — понятная ошибка
const bare = await connect({});
const { tools } = await bare.listTools();
console.log(`tools (${tools.length}):`, tools.map(t => t.name).join(', '));
if (tools.length !== 12) { console.log(`FAIL ожидалось 12 инструментов`); failed++; }
await run(bare, 'crm_account', {}, (d, t, e) => e && t.includes('AMOCRM_TOKEN'));
await bare.close();

const c = await connect({ AMOCRM_TOKEN: 'test-token', AMOCRM_BASE_URL: base });
await run(c, 'crm_account', {}, d => d.account.currency === 'RUB' && d.users.length === 2 && d.pipelines[0].statuses.find(s => s.id === 142).type === 'won');
await run(c, 'crm_search_leads', { query: 'сайт' }, d => d.count === 1 && d.leads[0].status === 'Переговоры' && d.leads[0].responsible === 'Анна');
await run(c, 'crm_search_leads', { pipeline_id: 10, status_id: 142 }, d => d.count === 1 && d.leads[0].id === 102
  && last('GET', '/leads?').url.includes('filter[statuses][0][pipeline_id]=10'));
await run(c, 'crm_search_leads', { status_id: 142 }, (d, t, e) => e);
await run(c, 'crm_get_lead', { id: 101 }, d => d.contacts[0].phones[0] === '+79001234567' && d.contacts[0].custom_fields['Должность'] === 'Директор'
  && d.company.name === 'ООО Кафе' && d.open_tasks.length === 1 && d.open_tasks[0].overdue && d.notes[0].text.includes('скидку'));
await run(c, 'crm_get_lead', { id: 999 }, (d, t, e) => e && t.includes('не найдена'));
await run(c, 'crm_create_lead', { name: 'Новый сайт', price: 50000, contact_name: 'Ольга', phone: '+79990000000', company_name: 'ИП Ольга', note: 'С сайта' },
  d => d.lead_id === 105 && last('POST', '/leads/complex').body[0]._embedded.contacts[0].custom_fields_values[0].field_code === 'PHONE'
    && last('POST', '/leads/notes').body[0].entity_id === 105);
await run(c, 'crm_update_lead', { id: 101, status_id: 142, custom_fields: [{ field_id: 5, value: 'x' }] },
  d => d.updated && last('PATCH', '/leads/101').body.custom_fields_values[0].values[0].value === 'x');
await run(c, 'crm_update_lead', { id: 101 }, (d, t, e) => e);
await run(c, 'crm_find_contact', { query: 'Иван' }, d => d.contacts[0].emails[0] === 'ivan@cafe.ru' && d.contacts[0].lead_ids[0] === 101);
await run(c, 'crm_add_note', { entity_type: 'contacts', entity_id: 201, text: 'Звонок' }, d => d.note_id === 502);
await run(c, 'crm_tasks', { scope: 'overdue' }, d => d.count === 1 && d.tasks[0].id === 401 && d.tasks[0].responsible === 'Анна');
await run(c, 'crm_tasks', {}, d => d.count === 2);
await run(c, 'crm_create_task', { text: 'Позвонить', due: '2026-10-01', entity_id: 101 }, d => d.task_id === 403 && last('POST', '/tasks').body[0].task_type_id === 1);
await run(c, 'crm_complete_task', { id: 401, result: 'Дозвонился' }, d => d.completed && last('PATCH', '/tasks/401').body.result.text === 'Дозвонился');
await run(c, 'crm_pipeline_report', {}, d => d.leads === 4 && d.won.budget === 40000 && d.lost.count === 1 && d.win_rate_pct === 50
  && d.avg_cycle_days === 10 && d.stages.find(s => s.status_id === 2).leads === 1 && d.managers[0].manager === 'Анна');
await run(c, 'crm_stale_leads', { days: 7 }, d => d.leads[0].id === 101 && d.leads[0].reasons.length === 2 && !d.leads.some(l => l.id === 102));
await c.close();

if (log.some(l => l.auth !== 'Bearer test-token')) { console.log('FAIL запрос без токена'); failed++; }
mock.close();
console.log(failed ? `\nПровалено: ${failed}` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
