// Клиент amoCRM / Kommo API v4: долгосрочный токен, лимит запросов, постраничная выборка, кэш справочников.

const TOKEN = process.env.AMOCRM_TOKEN || process.env.KOMMO_TOKEN;
const DOMAIN = (process.env.AMOCRM_DOMAIN || process.env.KOMMO_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
// AMOCRM_BASE_URL — только для тестов (локальный мок-сервер)
const BASE = process.env.AMOCRM_BASE_URL || (DOMAIN ? `https://${DOMAIN.includes('.') ? DOMAIN : DOMAIN + '.amocrm.ru'}` : '');

export function assertConfigured() {
  if (!TOKEN || !BASE) {
    throw new Error('Не настроено подключение. Задайте AMOCRM_DOMAIN (например mycompany.amocrm.ru или mycompany.kommo.com) ' +
      'и AMOCRM_TOKEN (долгосрочный токен: amoCRM → amoМаркет → ⋯ → Создать интеграцию → Ключи и доступы). ' +
      'Not configured: set AMOCRM_DOMAIN and AMOCRM_TOKEN (long-lived token of a private integration).');
  }
}

// amoCRM разрешает не больше 7 запросов в секунду — держим очередь с интервалом.
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 150;
  if (wait) await new Promise(r => setTimeout(r, wait));
}

function qs(params = {}) {
  const out = [];
  const add = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === 'object' ? Object.entries(x).forEach(([kk, vv]) => add(`${k}[${i}][${kk}]`, vv)) : add(`${k}[]`, x));
    else if (typeof v === 'object') Object.entries(v).forEach(([kk, vv]) => add(`${k}[${kk}]`, vv));
    else out.push(`${encodeURIComponent(k).replace(/%5B/g, '[').replace(/%5D/g, ']')}=${encodeURIComponent(v)}`);
  };
  Object.entries(params).forEach(([k, v]) => add(k, v));
  return out.length ? '?' + out.join('&') : '';
}

export async function api(path, { method = 'GET', query, body, retries = 2 } = {}) {
  assertConfigured();
  const url = BASE + '/api/v4' + path + qs(query);
  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      detail = [j.title, j.detail, j['validation-errors'] && JSON.stringify(j['validation-errors'])].filter(Boolean).join(': ') || detail;
    } catch {}
    if (res.status === 401) detail = 'токен недействителен или истёк (401). ' + detail;
    if (res.status === 402) detail = 'аккаунт amoCRM не оплачен (402). ' + detail;
    throw new Error(`amoCRM ${method} ${path}: HTTP ${res.status} — ${detail}`);
  }
}

/** Постранично собирает сущности (limit 250 — максимум API). */
export async function list(path, embeddedKey, query = {}, max = 1000) {
  const items = [];
  for (let page = 1; items.length < max; page++) {
    const r = await api(path, { query: { ...query, limit: Math.min(250, max), page } });
    const chunk = r?._embedded?.[embeddedKey] || [];
    items.push(...chunk);
    if (!r?._links?.next || !chunk.length) break;
  }
  return items.slice(0, max);
}

// Справочники меняются редко — кэшируем на 10 минут.
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, until: Date.now() + 600e3 });
  return value;
}

export const getAccount = () => cached('account', () => api('/account'));
export const getUsers = () => cached('users', () => list('/users', 'users', {}, 500));
export const getPipelines = () => cached('pipelines', async () => (await api('/leads/pipelines'))?._embedded?.pipelines || []);

export const WON = 142, LOST = 143;

/** Карты id → имя для пользователей, воронок и этапов. */
export async function dictionaries() {
  const [users, pipelines] = await Promise.all([getUsers(), getPipelines()]);
  const userName = new Map(users.map(u => [u.id, u.name]));
  const pipelineName = new Map(pipelines.map(p => [p.id, p.name]));
  const statusName = new Map();
  for (const p of pipelines) for (const s of p._embedded?.statuses || []) statusName.set(`${p.id}:${s.id}`, s.name);
  return {
    users, pipelines,
    user: id => userName.get(id) || (id ? `#${id}` : null),
    pipeline: id => pipelineName.get(id) || (id ? `#${id}` : null),
    status: (pid, sid) => sid === WON ? 'Успешно реализовано' : sid === LOST ? 'Закрыто и не реализовано' : statusName.get(`${pid}:${sid}`) || `#${sid}`,
  };
}

export const ts = iso => iso ? Math.floor(Date.parse(iso) / 1000) : undefined;
export const date = sec => sec ? new Date(sec * 1000).toISOString().replace('.000Z', 'Z') : null;

/** Телефоны и e-mail из custom_fields_values контакта. */
export function contactChannels(c) {
  const pick = code => (c.custom_fields_values || []).filter(f => f.field_code === code).flatMap(f => f.values.map(v => v.value));
  return { phones: pick('PHONE'), emails: pick('EMAIL') };
}

export function customFields(e) {
  const cf = (e.custom_fields_values || []).filter(f => !['PHONE', 'EMAIL'].includes(f.field_code));
  return cf.length ? Object.fromEntries(cf.map(f => [f.field_name, f.values.map(v => v.value).join(', ')])) : undefined;
}
