// Облачный режим: MCP по Streamable HTTP. Клиент подключается по адресу https://<хост>/mcp с заголовком
// Authorization: Bearer <ключ клиента>. Ключи, их аккаунты amoCRM и сроки подписки лежат в файле CLIENTS_FILE —
// токен amoCRM клиенту на своей стороне хранить не нужно.
//
// Формат clients.json:
// { "ключ": { "name": "ООО Ромашка", "domain": "romashka.amocrm.ru", "token": "долгосрочный токен", "paid_until": "2026-12-31" } }

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, VERSION } from './server.js';
import { withAccount } from './api.js';

// Node 18: библиотеке MCP нужен глобальный Web Crypto
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const CLIENTS_FILE = process.env.CLIENTS_FILE || 'clients.json';
const PORT = Number(process.env.MCP_HTTP_PORT || process.env.PORT || 8787);
// По умолчанию только localhost: наружу — через HTTPS-прокси (Caddy). 0.0.0.0 — если прокси на другой машине.
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';
const MAX_PER_MIN = Number(process.env.RATE_PER_MIN || 120);

// Файл перечитывается при изменении — добавить клиента или продлить подписку можно без перезапуска.
let clients = {}, mtime = 0;
function loadClients() {
  try {
    const st = fs.statSync(CLIENTS_FILE);
    if (st.mtimeMs !== mtime) { clients = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')); mtime = st.mtimeMs; }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`clients: ${e.message}`);
    clients = {}; mtime = 0;
  }
  return clients;
}

function findClient(key) {
  if (!key) return null;
  const all = loadClients();
  // Сравнение за постоянное время, чтобы ключ нельзя было подобрать по задержке
  for (const [k, v] of Object.entries(all)) {
    const a = Buffer.from(k), b = Buffer.from(key);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return v;
  }
  return null;
}

const hits = new Map();
function rateOk(key) {
  const now = Date.now(), win = hits.get(key)?.filter(t => now - t < 60e3) || [];
  win.push(now); hits.set(key, win);
  return win.length <= MAX_PER_MIN;
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
const rpcError = (res, status, message) => send(res, status, { jsonrpc: '2.0', error: { code: -32001, message }, id: null });

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 1e6) throw new Error('Слишком большой запрос'); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

export function handler() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return send(res, 200, { ok: true, version: VERSION });
    if (url.pathname !== '/mcp') return send(res, 404, { error: 'Not found. MCP endpoint: /mcp' });
    if (req.method !== 'POST') return rpcError(res, 405, 'Используйте POST /mcp (Streamable HTTP, без сессий)');

    const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const client = findClient(key);
    if (!client) return rpcError(res, 401, 'Неверный ключ доступа. Ключ выдаётся при оформлении подписки: t.me/penmadebykisss');
    if (client.paid_until && new Date(client.paid_until + 'T23:59:59Z') < new Date())
      return rpcError(res, 402, `Подписка закончилась ${client.paid_until}. Продлить: t.me/penmadebykisss`);
    if (!rateOk(key)) return rpcError(res, 429, `Не больше ${MAX_PER_MIN} запросов в минуту`);

    let body;
    try { body = await readBody(req); } catch (e) { return rpcError(res, 400, e.message); }

    // Без сессий: на каждый запрос — свой экземпляр сервера и транспорта, данные клиентов не пересекаются
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await withAccount({ domain: client.domain, token: client.token, baseUrl: client.base_url }, () => transport.handleRequest(req, res, body));
  };
}

export async function startHttp() {
  const srv = http.createServer(handler());
  await new Promise(r => srv.listen(PORT, HOST, r));
  console.error(`amocrm-kommo-mcp ${VERSION}: HTTP на порту ${PORT} (${HOST}), клиенты из ${CLIENTS_FILE} (${Object.keys(loadClients()).length})`);
  return srv;
}
