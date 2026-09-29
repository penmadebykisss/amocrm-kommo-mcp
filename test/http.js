// Тест облачного режима: два мок-аккаунта amoCRM, сервер в режиме --http, клиенты по ключам.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Node 18: библиотеке MCP нужен глобальный Web Crypto
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// Мини-мок amoCRM: отдаёт аккаунт с именем, по которому видно, чей токен пришёл
function mockAmo(name, token) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{"title":"Unauthorized"}'); }
    const p = req.url.split('?')[0];
    const body = p === '/api/v4/account' ? { id: 1, name, subdomain: name, currency: 'RUB' }
      : p === '/api/v4/users' ? { _embedded: { users: [{ id: 1, name: 'Анна', rights: { is_active: true } }] }, _links: {} }
      : p === '/api/v4/leads/pipelines' ? { _embedded: { pipelines: [] } } : null;
    if (!body) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

const a = await mockAmo('romashka', 'token-a');
const b = await mockAmo('vektor', 'token-b');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amo-http-'));
const clientsFile = path.join(dir, 'clients.json');
fs.writeFileSync(clientsFile, JSON.stringify({
  'key-a': { name: 'Ромашка', token: 'token-a', base_url: a.url, paid_until: '2099-01-01' },
  'key-b': { name: 'Вектор', token: 'token-b', base_url: b.url },
  'key-old': { name: 'Просрочен', token: 'token-a', base_url: a.url, paid_until: '2020-01-01' },
}));

const port = 18000 + Math.floor(Math.random() * 1000);
const env = { ...process.env, CLIENTS_FILE: clientsFile, MCP_HTTP_PORT: String(port) };
for (const k of ['AMOCRM_TOKEN', 'AMOCRM_DOMAIN', 'AMOCRM_BASE_URL']) delete env[k];
const proc = spawn(process.execPath, ['src/index.js', '--http'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise((resolve, reject) => {
  proc.stderr.on('data', d => { if (String(d).includes('HTTP на порту')) resolve(); });
  proc.on('exit', c => reject(new Error('сервер завершился: ' + c)));
  setTimeout(() => reject(new Error('сервер не запустился')), 10000);
});

let failed = 0;
const check = (ok, label, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ': ' + detail : ''}`); };

async function connect(key) {
  const c = new Client({ name: 'http-test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return c;
}
async function account(key) {
  const c = await connect(key);
  const r = await c.callTool({ name: 'crm_account', arguments: {} });
  await c.close();
  return JSON.parse(r.content[0].text);
}

const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
check(health.ok === true, 'health', JSON.stringify(health));

const ca = await connect('key-a');
const { tools } = await ca.listTools();
check(tools.length === 12, 'список инструментов по ключу', `${tools.length}`);
await ca.close();

const [ra, rb] = await Promise.all([account('key-a'), account('key-b')]);
check(ra.account.name === 'romashka' && rb.account.name === 'vektor', 'каждый ключ видит свой аккаунт', `${ra.account.name} / ${rb.account.name}`);
check(a.seen.every(h => h === 'Bearer token-a') && b.seen.every(h => h === 'Bearer token-b'), 'токены клиентов не перепутаны');

for (const [key, code, label] of [['wrong', 401, 'чужой ключ'], ['key-old', 402, 'подписка закончилась']]) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const j = await r.json();
  check(r.status === code && j.error?.message, label, `${r.status} ${j.error?.message}`);
}

// Продление подписки без перезапуска: меняем файл
const cfg = JSON.parse(fs.readFileSync(clientsFile, 'utf8'));
cfg['key-old'].paid_until = '2099-01-01';
fs.writeFileSync(clientsFile, JSON.stringify(cfg));
await new Promise(r => setTimeout(r, 50));
const renewed = await account('key-old');
check(renewed.account.name === 'romashka', 'продление подхватилось без перезапуска');

proc.kill(); a.srv.close(); b.srv.close();
console.log(failed ? `\nПровалено: ${failed}` : '\nОблачный режим: все проверки пройдены');
process.exit(failed ? 1 : 0);
