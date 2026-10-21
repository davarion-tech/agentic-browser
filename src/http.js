#!/usr/bin/env node
// API HTTP/JSON para agentes que no hablan MCP (Python, LangChain, n8n, curl...).
//   GET  /tools              -> lista de herramientas con su JSON Schema
//   POST /tools/<nombre>     -> ejecuta; cuerpo = argumentos JSON
// Solo escucha en 127.0.0.1 y siempre exige "Authorization: Bearer <token>":
// AGENT_TOKEN, o si no existe, el token que se genera en ~/.agentic-browser/http-token.
// Además rechaza peticiones que vengan de un navegador (cabecera Origin / Sec-Fetch-Site),
// con un Host ajeno (DNS rebinding) o que no sean JSON: así ninguna web puede manejar el
// navegador del agente aunque esté abierta en el mismo ordenador.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentBrowser } from './browser.js';
import { createTools } from './tools.js';

const PORT = Number(process.env.AGENT_HTTP_PORT || 8787);
const TOKEN_FILE = process.env.AGENT_TOKEN_FILE || path.join(os.homedir(), '.agentic-browser', 'http-token');
const MAX_BODY = 1024 * 1024;

// Token: el de AGENT_TOKEN o uno aleatorio guardado en un archivo que solo lee el usuario
function loadToken() {
  if (process.env.AGENT_TOKEN) return { token: process.env.AGENT_TOKEN, from: 'AGENT_TOKEN' };
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 32) return { token: t, from: TOKEN_FILE };
  } catch {}
  const t = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return { token: t, from: `${TOKEN_FILE} (nuevo)` };
}

const { token: TOKEN, from: TOKEN_FROM } = loadToken();
const ab = new AgentBrowser();
const tools = new Map(createTools(ab).map(t => [t.name, t]));
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const sameToken = h => {
  const m = /^Bearer (.+)$/.exec(h || '');
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Motivo de rechazo, o null si la petición es aceptable
function rejectReason(req) {
  if (!HOSTS.has(String(req.headers.host || '').toLowerCase())) return [403, 'Host no permitido'];
  if (req.headers.origin !== undefined) return [403, 'las peticiones desde páginas web no están permitidas'];
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'none') return [403, 'las peticiones desde páginas web no están permitidas'];
  if (!sameToken(req.headers.authorization)) return [401, `falta el token: Authorization: Bearer <contenido de ${TOKEN_FILE} o AGENT_TOKEN>`];
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return [415, 'usa Content-Type: application/json'];
  return null;
}

// Una acción a la vez: el ratón y el teclado son recursos únicos.
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

http.createServer((req, res) => {
  const bad = rejectReason(req);
  if (bad) { req.resume(); return send(res, bad[0], { error: bad[1] }); }
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
  let body = '', size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { send(res, 413, { error: 'cuerpo demasiado grande' }); req.destroy(); return; }
    body += c;
  });
  req.on('end', () => serial(async () => {
    if (res.writableEnded) return;
    try {
      const args = z.object(t.schema).parse(body ? JSON.parse(body) : {});
      const r = await t.run(args);
      send(res, 200, r && r.image ? r : { result: String(r) });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  }));
}).listen(PORT, '127.0.0.1', () => console.error(`[agentic-browser] HTTP en http://127.0.0.1:${PORT} · token: ${TOKEN_FROM}`));

const shutdown = async () => { await ab.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
