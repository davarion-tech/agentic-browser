// Pruebas de seguridad (v1.1.0): contraseñas, eval, subidas, texto no confiable,
// diálogos, manipulación de la percepción y blindaje de la API HTTP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sec-'));
const allowed = path.join(tmp, 'permitidos'), outside = path.join(tmp, 'fuera');
fs.mkdirSync(allowed); fs.mkdirSync(outside);
fs.writeFileSync(path.join(allowed, 'factura.txt'), 'factura');
fs.writeFileSync(path.join(outside, 'secreto.txt'), 'secreto');
// Antes de importar tools.js: lee estas variables al cargar
Object.assign(process.env, { AGENT_TRACE: path.join(tmp, 'trace.jsonl'), AGENT_UPLOAD_DIRS: allowed, AGENT_CURSOR_SPEED: '0' });
delete process.env.AGENT_ALLOW_EVAL; delete process.env.AGENT_DIALOGS;

const { AgentBrowser } = await import('../src/browser.js');
const { createTools } = await import('../src/tools.js');
const ab = new AgentBrowser({ headless: process.env.AGENT_HEADLESS !== '0', userDataDir: path.join(tmp, 'profile') });
const tools = new Map(createTools(ab).map(t => [t.name, t]));
const call = (name, args = {}) => tools.get(name).run(args);
const refOf = (text, re) => { const l = text.split('\n').find(l => re.test(l)); assert.ok(l, `no encuentro ${re} en:\n${text}`); return l.match(/\[([^\]]+)\]/)[1]; };

try {
  // 1. Todo lo que viene de la web llega delimitado como no confiable
  const snap = await call('browser_navigate', { url: pathToFileURL(path.join(here, 'security.html')).href, snapshot: true });
  assert.match(snap, /<page_content url="file:[^"]*" trust="untrusted">/);
  const s = await call('browser_snapshot');
  assert.match(s, /^<page_content [^>]*trust="untrusted">\n/);
  assert.match(s, /\n<\/page_content>$/);
  const read = await call('browser_read', { selector: '#evil' });
  assert.equal(read.match(/<\/page_content>/g).length, 1, 'la página no debe poder cerrar el delimitador');
  assert.match(read, /&lt;\/page_content>/);
  console.log('✔ texto de la web delimitado y sin poder escaparse');

  // 2. La página no puede sustituir la percepción ni el aviso para la persona
  const page = await ab.active();
  assert.equal(await page.evaluate(() => window.tamper), 'bloqueado');
  assert.ok(await page.evaluate(() => window.__agentPerc.snapshot({}).items.length > 3), 'el snapshot falso de la página ganó');
  assert.equal(await page.evaluate(() => typeof window.__agentCursor.highlight), 'function', 'el overlay falso de la página ganó');
  assert.match(s, /textbox "Nombre"/);
  console.log('✔ percepción y overlay a prueba de sustitución');

  // 3. Campos sensibles: marcados y bloqueados
  for (const re of [/] password "Password"/, /ph="123456"/, /ph="Account"/]) assert.match(s.split('\n').find(l => re.test(l)), /sensitive/);
  assert.equal(await call('browser_type', { ref: refOf(s, /textbox "Nombre"/), text: 'Oscar' }).then(() => 'ok'), 'ok');
  assert.equal(await page.inputValue('#name'), 'Oscar');
  for (const [re, sel] of [[/] password "Password"/, '#pw'], [/ph="123456"/, '#otp'], [/ph="Account"/, '#acct']]) {
    await assert.rejects(call('browser_type', { ref: refOf(s, re), text: 'hola-secreto-123' }), /campo sensible/);
    assert.equal(await page.inputValue(sel), '', `se escribió en ${sel}`);
  }
  await call('browser_click', { ref: refOf(s, /] password "Password"/) });
  await assert.rejects(call('browser_press', { keys: 'a' }), /campo sensible/);
  await assert.rejects(call('browser_press', { keys: 'Control+V' }), /campo sensible/);
  await call('browser_press', { keys: 'Tab' });
  await call('browser_click', { ref: refOf(s, /textbox "Nombre"/) });
  await assert.rejects(call('browser_type', { text: 'x\tsecreto' }), /tabuladores/);
  const trace = fs.readFileSync(process.env.AGENT_TRACE, 'utf8');
  assert.ok(!trace.includes('hola-secreto') && !trace.includes('"text":"Oscar"'), 'la traza guarda texto escrito en claro');
  assert.match(trace, /\[16 chars\]/);
  console.log('✔ nunca escribe en contraseñas, 2FA ni cuentas; la traza no guarda lo escrito');

  // 4. browser_eval apagado por defecto
  await assert.rejects(call('browser_eval', { expression: 'document.cookie' }), /desactivada/);
  console.log('✔ browser_eval desactivada por defecto');

  // 5. Subidas solo desde las carpetas permitidas
  const fileRef = refOf(s, /"Adjuntar"/);
  await assert.rejects(call('browser_upload', { ref: fileRef, files: [path.join(outside, 'secreto.txt')] }), /fuera de las carpetas permitidas/);
  await assert.rejects(call('browser_upload', { ref: fileRef, files: [path.join(allowed, '..', 'fuera', 'secreto.txt')] }), /fuera de las carpetas permitidas/);
  await assert.rejects(call('browser_upload', { ref: fileRef, files: [path.join(allowed, 'no-existe.txt')] }), /no existe/);
  await call('browser_upload', { ref: fileRef, files: [path.join(allowed, 'factura.txt')] });
  assert.equal(await page.evaluate(() => document.getElementById('file').files[0]?.name), 'factura.txt');
  console.log('✔ subidas limitadas a AGENT_UPLOAD_DIRS');

  // 6. Diálogos: se cancelan por defecto y el texto llega como no confiable
  const r = await call('browser_click', { ref: refOf(s, /button "Borrar todo"/) });
  assert.match(r, /eventos: <page_content [^>]*>\n.*"kind":"confirm".*"action":"dismiss"/);
  assert.equal(await page.title(), 'confirm:false');
  console.log('✔ confirm() cancelado por defecto');

  // 7. El agente no puede pulsar el aviso para la persona
  await page.evaluate(() => { window.__agentCursor.ask('prueba'); });
  await page.waitForTimeout(100);
  const bar = await ab.elementAt(640, 32);
  assert.equal(bar?.role, 'agent-cursor-host', `en el banner hay ${JSON.stringify(bar)}`);
  await assert.rejects(call('browser_click', { x: 640, y: 32 }), /aviso para la persona/);
  console.log('✔ el agente no puede responder al banner de request_human');
} finally {
  await ab.close();
}

// 8. API HTTP blindada
const PORT = 20000 + Math.floor(Math.random() * 20000);
const tokenFile = path.join(tmp, 'http-token');
const srv = spawn(process.execPath, [path.join(here, '..', 'src', 'http.js')], {
  env: { ...process.env, AGENT_HTTP_PORT: String(PORT), AGENT_TOKEN_FILE: tokenFile, AGENT_TOKEN: '', AGENT_HEADLESS: '1', AGENT_PROFILE: path.join(tmp, 'profile-http') },
  stdio: ['ignore', 'ignore', 'pipe'],
});
try {
  await new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error('el servidor HTTP no arrancó')), 15000);
    srv.stderr.on('data', d => { if (/HTTP en/.test(d)) { clearTimeout(t); ok(); } });
  });
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.ok(token.length >= 64, 'token generado demasiado corto');
  const req = (method, p, headers = {}, body) => new Promise((ok, ko) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => ok({ code: res.statusCode, body: b }));
    });
    r.on('error', ko); if (body) r.write(body); r.end();
  });
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await req('GET', '/tools')).code, 401, 'sin token debe fallar');
  assert.equal((await req('GET', '/tools', { authorization: 'Bearer otro' })).code, 401);
  const ok = await req('GET', '/tools', auth);
  assert.equal(ok.code, 200);
  assert.ok(JSON.parse(ok.body).some(t => t.name === 'browser_snapshot'));
  assert.equal((await req('GET', '/tools', { ...auth, origin: 'https://evil.test' })).code, 403, 'Origin de una web');
  assert.equal((await req('GET', '/tools', { ...auth, 'sec-fetch-site': 'cross-site' })).code, 403, 'Sec-Fetch-Site');
  assert.equal((await req('GET', '/tools', { ...auth, host: `evil.test:${PORT}` })).code, 403, 'DNS rebinding');
  assert.equal((await req('POST', '/tools/browser_trace', { ...auth, 'content-type': 'text/plain' }, '{}')).code, 415, 'text/plain');
  const tr = await req('POST', '/tools/browser_trace', { ...auth, 'content-type': 'application/json' }, '{"limit":1}');
  assert.equal(tr.code, 200);
  console.log('✔ API HTTP: token obligatorio, sin peticiones desde webs, sin DNS rebinding, solo JSON');
} finally {
  srv.kill();
}

console.log('\nOK: pruebas de seguridad pasadas');
process.exit(0);
