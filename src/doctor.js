#!/usr/bin/env node
// Diagnóstico rápido: ¿está todo listo para que un agente use el navegador?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.js';

const ok = (m) => console.log('  ✔ ' + m);
const bad = (m) => console.log('  ✖ ' + m);
const info = (m) => console.log('  · ' + m);

console.log('agentic-browser doctor\n');
const [maj] = process.versions.node.split('.').map(Number);
maj >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} (se necesita ≥ 18)`);

const exe = findChrome();
if (!exe) bad('Chrome no encontrado. Instálalo o define AGENT_CHROME con la ruta.');
else {
  ok(`Chrome: ${exe}`);
  try {
    const b = await chromium.launch({ executablePath: exe, headless: true, chromiumSandbox: process.env.AGENT_NO_SANDBOX !== '1' });
    ok(`Arranca en headless, versión ${b.version()}`);
    await b.close();
  } catch (e) { bad('No arranca: ' + e.message.split('\n')[0]); }
}

const profile = process.env.AGENT_PROFILE || path.join(os.homedir(), '.agentic-browser', 'profile');
info(`Perfil: ${profile}`);
const lock = ['SingletonLock', 'lockfile', 'SingletonSocket'].find(f => fs.existsSync(path.join(profile, f)));
lock ? bad(`El perfil parece en uso (${lock}). Si no hay otro agente abierto, cierra los chrome.exe huérfanos.`) : ok('Perfil libre');

if (process.env.AGENT_CDP_URL) {
  try {
    const r = await fetch(process.env.AGENT_CDP_URL.replace(/\/$/, '') + '/json/version');
    const j = await r.json();
    ok(`AGENT_CDP_URL responde: ${j.Browser}`);
  } catch (e) { bad(`AGENT_CDP_URL no responde: ${e.message}`); }
}

const env = ['AGENT_HEADLESS', 'AGENT_CURSOR_SPEED', 'AGENT_TOOLS', 'AGENT_READONLY', 'AGENT_ALLOWED_ORIGINS', 'AGENT_DIALOGS', 'AGENT_HTTP_PORT', 'AGENT_TOKEN'];
for (const k of env) if (process.env[k] !== undefined) info(`${k}=${k === 'AGENT_TOKEN' ? '***' : process.env[k]}`);
console.log('\nRegistro en Claude Code:\n  claude mcp add agentic-browser -- node ' + path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'mcp.js'));
