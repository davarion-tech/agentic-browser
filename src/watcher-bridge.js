#!/usr/bin/env node
// Puente MCP (stdio) entre `claude -p` y el proceso del vigilante.
// El vigilante lo lanza indirectamente: arranca `claude -p --mcp-config ...` y ese
// Claude Code ejecuta este script, que reenvía cada llamada a la API local del
// vigilante. Así Claude Code solo ve las herramientas restringidas del vigilante y
// toda la política (borrador, lista blanca, palabras sensibles, dominio) sigue
// aplicándose en el proceso del vigilante.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const URL_ = process.env.WATCHER_BRIDGE_URL;
const TOKEN = process.env.WATCHER_BRIDGE_TOKEN;
if (!URL_ || !TOKEN) { console.error('Falta WATCHER_BRIDGE_URL / WATCHER_BRIDGE_TOKEN'); process.exit(1); }

const req = async (p, body) => {
  const r = await fetch(URL_ + p, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};

const server = new Server({ name: 'watcher', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await req('/tools') }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const r = await req('/exec', { name: params.name, args: params.arguments || {} });
  return { content: [{ type: 'text', text: String(r.result ?? r.error) }], isError: !!r.error };
});
await server.connect(new StdioServerTransport());
