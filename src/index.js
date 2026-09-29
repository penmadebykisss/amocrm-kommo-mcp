#!/usr/bin/env node
// Точка входа: локальный режим (stdio, доступ из AMOCRM_DOMAIN / AMOCRM_TOKEN) или облачный (--http, ключи клиентов).

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

if (process.argv.includes('--http') || process.env.MCP_HTTP_PORT) {
  const { startHttp } = await import('./http.js');
  await startHttp();
} else {
  await createServer().connect(new StdioServerTransport());
}
