#!/usr/bin/env node
// API HTTP/JSON para agentes que no hablan MCP (Python, LangChain, n8n, curl...).
//   GET  /tools              -> lista de herramientas con su JSON Schema
//   POST /tools/<nombre>     -> ejecuta; cuerpo = argumentos JSON
// Solo escucha en 127.0.0.1. Opcional: AGENT_TOKEN exige "Authorization: Bearer <token>".
import http from 'node:http';
import { z } from 'zod';
import { AgentBrowser } from './browser.js';
import { createTools } from './tools.js';

const PORT = Number(process.env.AGENT_HTTP_PORT || 8787);
const TOKEN = process.env.AGENT_TOKEN || '';
const ab = new AgentBrowser();
const tools = new Map(createTools(ab).map(t => [t.name, t]));

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

// Una acción a la vez: el ratón y el teclado son recursos únicos.
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

http.createServer((req, res) => {
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/tools') {
    return send(res, 200, [...tools.values()].map(t => ({
      name: t.name, description: t.description, input_schema: z.toJSONSchema(z.object(t.schema)),
    })));
  }
  const m = url.pathname.match(/^\/tools\/([\w-]+)$/);
  if (req.method !== 'POST' || !m) return send(res, 404, { error: 'usa GET /tools o POST /tools/<nombre>' });
  const t = tools.get(m[1]);
  if (!t) return send(res, 404, { error: `herramienta desconocida: ${m[1]}` });
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => serial(async () => {
    try {
      const args = z.object(t.schema).parse(body ? JSON.parse(body) : {});
      const r = await t.run(args);
      send(res, 200, r && r.image ? r : { result: String(r) });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  }));
}).listen(PORT, '127.0.0.1', () => console.error(`[agentic-browser] HTTP en http://127.0.0.1:${PORT}`));

const shutdown = async () => { await ab.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
