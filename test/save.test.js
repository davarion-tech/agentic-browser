// Pruebas de 1.4.0: browser_article, browser_pdf, browser_media y browser_video contra un
// servidor local (artículo con ruido, imágenes, documento, vídeo directo, stream HLS y DRM).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-save-'));
const exportsDir = path.join(tmp, 'exports');
Object.assign(process.env, { AGENT_EXPORTS: exportsDir, AGENT_TRACE: path.join(tmp, 'trace.jsonl'), AGENT_CURSOR_SPEED: '0', AGENT_AUTO_DISMISS: '0' });
const { AgentBrowser } = await import('../src/browser.js');
const { createTools } = await import('../src/tools.js');
const { findFfmpeg } = await import('../src/recorder.js');

// ---- Archivos del sitio de prueba ----
const rnd = n => crypto.randomBytes(n);
const photo = rnd(6000);
const files = {
  '/img/photo.png': ['image/png', photo], '/img/photo-copy.png': ['image/png', photo], '/img/bg.png': ['image/png', rnd(4000)],
  '/img/pixel.png': ['image/png', rnd(60)], '/files/report.pdf': ['application/pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), rnd(3000)])],
  '/media/clip.mp4': ['video/mp4', rnd(8000)],
  '/drm/index.m3u8': ['application/vnd.apple.mpegurl', Buffer.from('#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:2,\nseg0.ts\n#EXT-X-ENDLIST\n')],
};
const ARTICLE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Artículo de prueba</title>
<meta name="author" content="Ana Pérez"><meta property="article:published_time" content="2026-10-20T10:00:00Z"><meta property="og:image" content="/img/photo.png"></head><body>
<nav class="menu">MENU-NAV-SECRET <a href="/a">Inicio</a> <a href="/b">Blog</a></nav>
<header>Cabecera del sitio</header>
<aside class="ads">PUBLICIDAD compra ya</aside>
<article><h1>Cómo los agentes leen la web</h1>
<p>Los agentes de IA pueden leer una página como <strong>texto</strong> en lugar de capturas, lo que ahorra <a href="/tokens">muchos tokens</a>.</p>
<h2>Ventajas</h2><ul><li>Más barato</li><li>Más preciso</li></ul>
<table><tr><th>Método</th><th>Tokens</th></tr><tr><td>Captura</td><td>1365</td></tr><tr><td>Texto</td><td>150</td></tr></table>
<figure><img src="/img/photo.png" alt="Foto del equipo" width="400"><figcaption>El equipo</figcaption></figure>
<img src="/img/photo-copy.png" alt="copia"><img src="/img/pixel.png" alt="">
<p>Descarga el <a href="/files/report.pdf">informe en PDF</a>.</p>
<div style="width:200px;height:100px;background-image:url('/img/bg.png')"></div>
<video src="/media/clip.mp4" controls></video>
</article><footer>Pie de página © 2026</footer></body></html>`;
const player = m3u8 => `<!doctype html><title>Reproductor</title><video id="v" controls></video><script>fetch('${m3u8}').then(r=>r.text()).then(t=>document.title='cargado')</script>`;

const hlsDir = path.join(tmp, 'hls');
const ff = findFfmpeg();
let hlsReady = false;
if (ff) {
  // Tres segmentos MPEG-TS de 1 s y una lista .m3u8 escrita a mano (no exige el muxer hls de ffmpeg)
  fs.mkdirSync(hlsDir);
  // Fuente: el generador lavfi de ffmpeg o, si esta build no lo trae, un MP4 de muestra (AGENT_TEST_VIDEO)
  const sources = [['-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10'],
    ...(process.env.AGENT_TEST_VIDEO ? [i => ['-ss', String(i), '-t', '1', '-i', process.env.AGENT_TEST_VIDEO, '-an']] : [])];
  for (const src of sources) {
    let ok = true;
    for (let i = 0; i < 3 && ok; i++) {
      const input = typeof src === 'function' ? src(i) : src;
      ok = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-output_ts_offset', String(i),
        '-f', 'mpegts', path.join(hlsDir, `seg${i}.ts`)], { windowsHide: true }).status === 0;
    }
    if (ok) { hlsReady = true; break; }
  }
  fs.writeFileSync(path.join(hlsDir, 'index.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n' +
    [0, 1, 2].map(i => `#EXTINF:1.0,\nseg${i}.ts`).join('\n') + '\n#EXT-X-ENDLIST\n');
}

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const send = (ct, body) => { res.writeHead(200, { 'content-type': ct, 'content-length': body.length }); res.end(body); };
  if (u === '/article') return send('text/html; charset=utf-8', Buffer.from(ARTICLE));
  if (u === '/hls-page') return send('text/html; charset=utf-8', Buffer.from(player('/hls/index.m3u8')));
  if (u === '/drm-page') return send('text/html; charset=utf-8', Buffer.from(player('/drm/index.m3u8')));
  if (files[u]) return send(...files[u]);
  if (u.startsWith('/hls/') && ff) {
    const f = path.join(hlsDir, path.basename(u));
    if (fs.existsSync(f)) return send(u.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', fs.readFileSync(f));
  }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const ab = new AgentBrowser({ headless: true, userDataDir: path.join(tmp, 'profile'), cursorSpeed: 0 });
const tools = new Map(createTools(ab).map(t => [t.name, t]));
const call = (n, a = {}) => tools.get(n).run(a);

try {
  await call('browser_navigate', { url: `${base}/article` });

  // 1. Artículo limpio en Markdown, sin menús, cabecera, publicidad ni pie
  const art = await call('browser_article');
  assert.match(art, /# Cómo los agentes leen la web/);
  assert.match(art, /por Ana Pérez · 2026-10-20/);
  assert.match(art, /\*\*texto\*\*/);
  assert.match(art, /\[muchos tokens\]\(http:\/\/127\.0\.0\.1:\d+\/tokens\)/);
  assert.match(art, /- Más barato\n- Más preciso/);
  assert.match(art, /\| Captura \| 1365 \|/);
  assert.match(art, /!\[Foto del equipo\]\(http/);
  assert.doesNotMatch(art, /MENU-NAV-SECRET|PUBLICIDAD|Pie de página|Cabecera del sitio/);
  assert.match(art, /<page_content/, 'el artículo debe ir marcado como contenido no confiable');
  const saved = await call('browser_article', { file: 'articulos/prueba' });
  const md = fs.readFileSync(path.join(exportsDir, 'articulos', 'prueba.md'), 'utf8');
  assert.match(md, /^---\ntitle: "Cómo los agentes leen la web"/);
  console.log('article OK');

  // 2. PDF y MHTML
  const pdf = await call('browser_pdf', { file: 'docs/articulo' });
  const pdfFile = pdf.match(/en (.+\.pdf)/)[1];
  assert.equal(fs.readFileSync(pdfFile).subarray(0, 5).toString(), '%PDF-');
  const mh = await call('browser_pdf', { format: 'mhtml' });
  const mhFile = mh.match(/en (.+\.mhtml)/)[1];
  assert.match(fs.readFileSync(mhFile, 'utf8').slice(0, 2000), /MIME-Version/i);
  await assert.rejects(call('browser_pdf', { file: '../../fuera' }), /dentro de/);
  console.log('pdf OK:', pdf, '|', mh);

  // 3. Multimedia: listar y descargar ordenado, sin duplicados ni píxeles
  const list = await call('browser_media', { download: false });
  assert.match(list, /image/); assert.match(list, /doc/); assert.match(list, /video/);
  const media = await call('browser_media');
  const dir = media.match(/en (.+?): /)[1];
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const names = man.items.map(i => i.file.replace(/\\/g, '/'));
  console.log('media:', names.join(', '), '| omitidos:', man.skipped.map(s => s.why).join('; '));
  assert.ok(names.includes('images/photo.png'), 'falta la foto');
  assert.ok(names.includes('images/bg.png'), 'falta la imagen de fondo CSS');
  assert.ok(names.includes('docs/report.pdf'), 'falta el PDF');
  assert.ok(names.includes('videos/clip.mp4'), 'falta el vídeo');
  assert.ok(!names.some(n => n.includes('photo-copy')), 'la copia idéntica debía omitirse');
  assert.ok(man.skipped.some(s => s.why === 'duplicado') && man.skipped.some(s => /menos de/.test(s.why)));
  assert.equal(man.items.find(i => i.file.endsWith('photo.png')).alt, 'Foto del equipo');
  console.log('media OK');

  // 4. Vídeo directo
  assert.match(await call('browser_video', { list: true }), /0\. file .*clip\.mp4/);
  const v1 = await call('browser_video', { file: 'videos/directo' });
  assert.ok(fs.statSync(path.join(exportsDir, 'videos', 'directo.mp4')).size === 8000, v1);
  console.log('video directo OK');

  // 5. Stream HLS juntado con ffmpeg
  if (hlsReady) {
    await call('browser_navigate', { url: `${base}/hls-page` });
    for (let i = 0; i < 20 && !(await ab.page.title()).includes('cargado'); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(await call('browser_video', { list: true }), /0\. hls .*index\.m3u8/);
    const v2 = await call('browser_video', { file: 'videos/stream' });
    const out = path.join(exportsDir, 'videos', 'stream.mp4');
    const probe = spawnSync(ff, ['-hide_banner', '-i', out], { encoding: 'utf8', windowsHide: true }).stderr;
    assert.match(probe, /Duration: 00:00:0[23]/, 'el MP4 debía durar unos 3 s');
    console.log('video HLS OK:', v2);
  } else console.log(ff ? 'video HLS omitido (este ffmpeg no puede generar vídeo de prueba; usa AGENT_TEST_VIDEO=muestra.mp4)' : 'video HLS omitido (no hay ffmpeg)');

  // 6. DRM: se niega
  await call('browser_navigate', { url: `${base}/drm-page` });
  for (let i = 0; i < 20 && !(await ab.page.title()).includes('cargado'); i++) await new Promise(r => setTimeout(r, 100));
  await assert.rejects(call('browser_video'), /DRM/);
  console.log('DRM OK');

  console.log('\nOK: article, pdf, media y video');
} finally {
  await ab.close();
  server.close();
}
