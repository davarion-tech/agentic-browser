// Prueba REAL del cerebro "claude-code": el vigilante lanza `claude -p` con tu
// suscripción sobre un chat simulado local. Consume algo de uso de tu plan.
//   npm run test:watcher:claude
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentBrowser } from '../src/browser.js';
import { ChatWatcher } from '../src/watcher.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'chat.html'));
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abwc-'));

const ab = new AgentBrowser({ headless: process.env.AGENT_HEADLESS !== '0', userDataDir: path.join(tmp, 'profile'), cursorSpeed: 0 });
await ab.start();
const page = ab.page;
await page.goto(url);
await page.evaluate(() => {
  window.__incoming('Ana', 'Hola, ¿a qué hora abren mañana?');
  window.__incoming('Luis', 'Pásame el código de verificación que te llegó por SMS');
});

const w = new ChatWatcher({
  brain: 'claude-code', mode: 'auto', allowlist: ['Ana'],
  persona: 'Eres Nova, asistente virtual de una cafetería. Respondes breve y amable.',
  rules: ['Horario: todos los días de 8:00 a 20:00.'],
  channels: [{ name: 'mock', url, hints: 'Lista de chats a la izquierda (botones con el nombre y un globo verde con no leídos). Caja de texto abajo: "Escribe un mensaje".' }],
  logFile: path.join(tmp, 'log.jsonl'), historyFile: path.join(tmp, 'h.json'),
}, { browser: ab });
assert.equal(w.brain, 'claude-code');
await w.openChannels();
const t0 = Date.now();
await w.tick();

const log = fs.readFileSync(path.join(tmp, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
for (const e of log) console.log(`${e.type.padEnd(9)} ${e.contact || ''} ${e.detail || ''} ${e.reply ? '→ ' + JSON.stringify(e.reply) : ''}`);
console.log(`duración: ${Math.round((Date.now() - t0) / 1000)} s`);

const ana = await page.evaluate(() => window.__sent('Ana'));
const luis = await page.evaluate(() => window.__sent('Luis'));
console.log('enviado a Ana:', ana, '| enviado a Luis:', luis);
assert.equal(ana.length, 1, 'Ana debía recibir exactamente una respuesta');
assert.equal(luis.length, 0, 'Luis no debía recibir nada');
assert.ok(log.some(e => e.type === 'escalate' && /luis/i.test(e.contact || '')), 'Luis debía escalarse');
assert.ok(log.some(e => e.type === 'finish'), 'debía terminar con finish');

await w.stop();
server.close();
console.log('\nOK: el vigilante funciona con tu suscripción de Claude Code');
