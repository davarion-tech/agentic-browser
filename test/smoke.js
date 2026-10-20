// Prueba de extremo a extremo: arranca el servidor MCP como lo haría un agente
// y ejecuta las herramientas contra test/page.html.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, '..', 'src', 'mcp.js')],
  env: { ...process.env, AGENT_HEADLESS: process.env.AGENT_HEADLESS ?? '1',
    AGENT_PROFILE: fs.mkdtempSync(path.join(os.tmpdir(), 'ab-')), AGENT_CURSOR_SPEED: '40', AGENT_ALLOW_EVAL: '1' },
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const c = r.content[0];
  if (r.isError) throw new Error(`${name}: ${c.text}`);
  // El contenido de la web llega delimitado como no confiable; aquí solo interesa lo de dentro
  return c.type === 'text' ? c.text.replace(/^<page_content[^>]*>\n([\s\S]*)\n<\/page_content>$/, '$1') : c;
};
const refOf = (snap, re) => { const l = snap.split('\n').find(l => re.test(l)); assert.ok(l, `no encuentro ${re} en:\n${snap}`); return l.match(/^\[([^\]]+)\]/)[1]; };

const { tools } = await client.listTools();
console.log(`herramientas: ${tools.length}`);

let snap = await call('browser_navigate', { url: pathToFileURL(path.join(here, 'page.html')).href, snapshot: true });
console.log(snap, '\n');
console.log(`snapshot ≈ ${Math.round(snap.length / 4)} tokens`);

await call('browser_type', { ref: refOf(snap, /textbox "Buscar"/), text: 'hola agente' });
console.log(await call('browser_click', { ref: refOf(snap, /button "Buscar"/) }));
assert.match(await call('browser_read', { selector: '#out' }), /buscado: hola agente/);

console.log(await call('browser_select', { ref: refOf(snap, /select/), values: ['Azul'] }));
assert.equal(await call('browser_eval', { expression: 'document.getElementById("color").value' }), '"Azul"');

console.log(await call('browser_click', { ref: refOf(snap, /checkbox/) }));
assert.equal(await call('browser_eval', { expression: 'ok.checked' }), 'true');

console.log(await call('browser_move', { ref: refOf(snap, /pasa el ratón/) }));
assert.match(await call('browser_read', { selector: '#hov' }), /hover detectado/);

// iframe: ref con prefijo f1:
const iframeRef = refOf(snap, /Botón del iframe/);
assert.match(iframeRef, /^f\d+:/);
console.log(await call('browser_click', { ref: iframeRef }));

// Píxel -> elemento sin imagen
const at = JSON.parse(await call('browser_element_at', { x: Number(snap.match(/button "Buscar".*@(\d+),(\d+)/)[1]), y: Number(snap.match(/button "Buscar".*@(\d+),(\d+)/)[2]) }));
assert.equal(at.name, 'Buscar');
console.log('element_at:', at.path, at.clickable);
console.log('cursor:', await call('browser_cursor'));

// Elemento fuera de pantalla: find + click (hace scroll solo)
const far = await call('browser_find', { query: 'Enlace lejano' });
console.log(far);
await call('browser_click', { ref: far.match(/^\[([^\]]+)\]/)[1] });
assert.match(await call('browser_read', { selector: '#far' }), /enlace lejano pulsado/);

// Clic por coordenadas puras
await call('browser_scroll', { dy: -5000 });
snap = await call('browser_snapshot');
const [, bx, by] = snap.match(/button "Buscar".*@(\d+),(\d+)/);
console.log(await call('browser_click', { x: Number(bx), y: Number(by) }));

// Shadow DOM abierto
snap = await call('browser_snapshot');
console.log(await call('browser_click', { ref: refOf(snap, /Botón en shadow DOM/) }));
assert.equal(await call('browser_eval', { expression: 'document.querySelector("my-widget").shadowRoot.getElementById("ss").textContent' }), '"shadow pulsado"');

// Ref obsoleto tras re-render: se re-localiza por rol + nombre
const rr = refOf(snap, /button "Rerender"/);
await call('browser_click', { ref: rr });
const relo = await call('browser_click', { ref: rr });
console.log(relo);
assert.match(relo, /re-localizado/);
assert.equal(await call('browser_eval', { expression: 'window.rerenders' }), '2');

// Modal que tapa la página: snapshot marca {occluded}; luego diff tras cerrarlo
await call('browser_click', { ref: refOf(snap, /Abrir modal/) });
snap = await call('browser_snapshot');
assert.match(snap, /occluded/);
await call('browser_click', { ref: refOf(snap, /Cerrar modal/) });
const diff = await call('browser_snapshot', { diff: true });
console.log(diff);
assert.match(diff, /^[-~] /m);

// browser_watch: despierta cuando aparece texto nuevo (sin tokens mientras espera)
await call('browser_eval', { expression: 'setTimeout(() => { const p = document.createElement("p"); p.textContent = "Mensaje nuevo de Ana"; document.body.append(p); }, 800), 1' });
const w = JSON.parse(await call('browser_watch', { text: 'Ana', timeout: 10000 }));
console.log('watch:', w);
assert.equal(w.reason, 'mutation');

// Detector de bucles y traza
await call('browser_cursor'); await call('browser_cursor');
assert.match(await call('browser_cursor'), /repetido esta misma acción 3 veces/);
assert.match(await call('browser_trace', { limit: 3 }), /browser_cursor/);

// Grabación: unos segundos con movimiento y una pausa sin cambios (debe conservar su duración)
const hasFfmpeg = spawnSync(process.env.AGENT_FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const probe = file => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.trim()) : null;
};
for (const format of hasFfmpeg ? ['mp4', 'webm'] : ['webm']) {
  console.log(await call('browser_record_start', { file: `smoke-demo.${format}`, format, demo: true }));
  snap = await call('browser_snapshot');
  await call('browser_move', { ref: refOf(snap, /button "Abrir modal"/) });
  await call('browser_move', { ref: refOf(snap, /button "Buscar"/) });
  await call('browser_wait', { ms: 1200 });
  const rec = JSON.parse(await call('browser_record_stop'));
  console.log('record:', rec);
  assert.ok(fs.existsSync(rec.file) && fs.statSync(rec.file).size > 1000, `no existe ${rec.file}`);
  assert.equal(rec.format, format);
  assert.ok(rec.seconds > 1, `duración ${rec.seconds}s`);
  const d = format === 'mp4' ? probe(rec.file) : null;
  if (d !== null) { console.log(`ffprobe: ${d}s`); assert.ok(d > 1, `ffprobe dice ${d}s`); }
}
await assert.rejects(call('browser_record_stop'), /no hay ninguna grabación/);

// Popups: los que abre la página sola quedan en segundo plano; los que provoca el agente se activan
const activeTab = async () => (await call('browser_tabs', { action: 'list' })).split('\n').find(l => l.startsWith('*'));
await call('browser_eval', { expression: 'setTimeout(() => window.open("about:blank"), 2500), 1' });
await call('browser_wait', { ms: 3500 });
const bg = JSON.parse(await call('browser_events'));
console.log('popup solo:', bg);
assert.ok(bg.some(e => e.type === 'background-tab'), 'falta el evento background-tab');
assert.match(await activeTab(), /^\*0 Banco de pruebas/);
assert.match(await call('browser_read', { selector: 'h1' }), /Banco de pruebas/);
for (const q of ['Pestaña nueva', 'Abrir popup']) {
  const r = await call('browser_click', { ref: (await call('browser_find', { query: q })).match(/^\[([^\]]+)\]/)[1] });
  console.log(r);
  assert.match(r, /"new-tab"/);
  assert.match(await activeTab(), /^\*2 /);
  // Al cerrarla, vuelve a la que la abrió (no a la última)
  await call('browser_tabs', { action: 'close' });
  assert.match(await activeTab(), /^\*0 Banco de pruebas/);
}
await call('browser_tabs', { action: 'close', index: 1 });
assert.match(await activeTab(), /^\*0 Banco de pruebas/);
const nt = await call('browser_tabs', { action: 'new', url: 'about:blank' });
assert.match(nt.split('\n').find(l => l.startsWith('*')), /^\*1 /);
await call('browser_tabs', { action: 'close' });
assert.match(await activeTab(), /^\*0 Banco de pruebas/);
assert.doesNotMatch(await call('browser_events'), /background-tab/);

console.log(await call('browser_tabs', { action: 'list' }));
const shot = await call('browser_screenshot', {});
fs.writeFileSync(path.join(here, 'last-screenshot.jpg'), Buffer.from(shot.data, 'base64'));
console.log(`screenshot ${Math.round(shot.data.length * 0.75 / 1024)} KB (test/last-screenshot.jpg)`);

console.log('\nOK: todas las comprobaciones pasaron');
await client.close();
