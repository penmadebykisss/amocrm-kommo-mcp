#!/usr/bin/env node
// Выдать клиенту ключ облачного доступа или продлить подписку.
// Новый:    node scripts/add-client.js "ООО Ромашка" romashka.amocrm.ru <токен amoCRM> 2026-11-30
// Продлить: node scripts/add-client.js --renew <ключ> 2026-12-31
import fs from 'node:fs';
import crypto from 'node:crypto';

const FILE = process.env.CLIENTS_FILE || 'clients.json';
const clients = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const [a, b, c, d] = process.argv.slice(2);

if (a === '--renew') {
  if (!clients[b] || !/^\d{4}-\d{2}-\d{2}$/.test(c || '')) { console.error('Использование: --renew <ключ> ГГГГ-ММ-ДД'); process.exit(1); }
  clients[b].paid_until = c;
  fs.writeFileSync(FILE, JSON.stringify(clients, null, 2));
  console.log(`${clients[b].name}: подписка до ${c}`);
} else {
  if (!a || !b || !c || !/^\d{4}-\d{2}-\d{2}$/.test(d || '')) {
    console.error('Использование: node scripts/add-client.js "Название" домен.amocrm.ru <токен> ГГГГ-ММ-ДД'); process.exit(1);
  }
  const key = 'amo_' + crypto.randomBytes(24).toString('base64url');
  clients[key] = { name: a, domain: b, token: c, paid_until: d, created: new Date().toISOString().slice(0, 10) };
  fs.writeFileSync(FILE, JSON.stringify(clients, null, 2), { mode: 0o600 });
  console.log(`Клиент: ${a}\nКлюч:   ${key}\nДо:     ${d}\n\nОтправьте клиенту адрес https://<ваш домен>/mcp и ключ.`);
}
