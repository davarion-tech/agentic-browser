// Guardar y extraer contenido de la página (1.4.0): artículo limpio en Markdown,
// PDF/MHTML, todo el multimedia ordenado en carpetas y vídeos (directos, HLS y DASH).
// Todo lo descargado se trata como datos de terceros: se guarda, nunca se ejecuta.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { findFfmpeg } from './recorder.js';

export const EXPORTS = process.env.AGENT_EXPORTS || path.join(os.homedir(), '.agentic-browser', 'exports');
const MAX_MB = Number(process.env.AGENT_MEDIA_MAX_MB || 500);   // por archivo
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const host = u => { try { return new URL(u).hostname.replace(/^www\./, '') || 'local'; } catch { return 'local'; } };
export const slug = (s, n = 60) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n) || 'archivo';

// Carpeta de salida dentro de EXPORTS (nunca fuera: un nombre con ../ no escapa)
export function outPath(rel, fallback) {
  const base = path.resolve(EXPORTS);
  const p = path.resolve(base, rel || fallback);
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`la ruta debe quedar dentro de ${base}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

// ---------- browser_article: modo lectura → Markdown (se ejecuta en la página) ----------
export function articleInPage({ selector, maxChars }) {
  const meta = n => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content?.trim() || '';
  const abs = u => { try { return new URL(u, location.href).href; } catch { return u; } };
  const NOISE = /(^|[\s_-])(nav|menu|footer|header|sidebar|aside|share|social|cookie|banner|advert|ads?|promo|related|comments?|newsletter|subscribe|breadcrumb|popup|modal)([\s_-]|$)/i;
  const textLen = el => (el.innerText || '').trim().length;
  const linkLen = el => [...el.querySelectorAll('a')].reduce((a, x) => a + (x.innerText || '').length, 0);
  let root = selector ? document.querySelector(selector) : null;
  if (!root) root = document.querySelector('article') || document.querySelector('[role=main], main');
  if (!root) {
    // El bloque con más texto en párrafos y menos enlaces
    let best = null, score = 0;
    for (const el of document.querySelectorAll('div, section')) {
      const ps = el.querySelectorAll(':scope > p, :scope > div > p').length;
      if (!ps) continue;
      const t = textLen(el), s = ps * 50 + t * (1 - Math.min(0.9, linkLen(el) / (t || 1)));
      if (s > score) { score = s; best = el; }
    }
    root = best || document.body;
  }
  const out = [];
  const inline = node => {
    let s = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { s += c.textContent.replace(/\s+/g, ' '); continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'svg', 'button', 'iframe'].includes(tag)) continue;
      const inner = inline(c).trim();
      if (tag === 'a' && c.getAttribute('href') && inner) s += `[${inner}](${abs(c.getAttribute('href'))})`;
      else if (tag === 'strong' || tag === 'b') s += inner ? `**${inner}**` : '';
      else if (tag === 'em' || tag === 'i') s += inner ? `*${inner}*` : '';
      else if (tag === 'code') s += inner ? '`' + inner + '`' : '';
      else if (tag === 'br') s += '\n';
      else if (tag === 'img') { const src = c.currentSrc || c.src; if (src && !src.startsWith('data:')) s += `![${c.alt || ''}](${abs(src)})`; }
      else s += inline(c);
    }
    return s;
  };
  const walk = el => {
    for (const c of el.children) {
      const tag = c.tagName.toLowerCase();
      const cls = `${c.id} ${c.className && c.className.baseVal === undefined ? c.className : ''} ${c.getAttribute('role') || ''}`;
      if (['script', 'style', 'noscript', 'nav', 'footer', 'aside', 'form', 'svg', 'iframe', 'button', 'header'].includes(tag) && c !== root) continue;
      if (c.getAttribute('aria-hidden') === 'true' || c.hidden) continue;
      if (NOISE.test(cls) && textLen(c) < 2000) continue;
      if (/^h[1-6]$/.test(tag)) { const t = inline(c).trim(); if (t) out.push(`${'#'.repeat(+tag[1])} ${t}`); }
      else if (tag === 'p') { const t = inline(c).trim(); if (t) out.push(t); }
      else if (tag === 'blockquote') { const t = inline(c).trim(); if (t) out.push(t.split('\n').map(l => '> ' + l).join('\n')); }
      else if (tag === 'pre') out.push('```\n' + c.innerText.replace(/\n+$/, '') + '\n```');
      else if (tag === 'ul' || tag === 'ol') {
        let i = 1;
        const items = [...c.children].filter(li => li.tagName === 'LI').map(li => `${tag === 'ol' ? (i++) + '.' : '-'} ${inline(li).trim()}`).filter(l => l.length > 2);
        if (items.length) out.push(items.join('\n'));
      } else if (tag === 'table') {
        const rows = [...c.querySelectorAll('tr')].map(tr => [...tr.children].map(td => inline(td).trim().replace(/\|/g, '\\|')));
        if (rows.length) { const w = Math.max(...rows.map(r => r.length)); const pad = r => [...r, ...Array(w - r.length).fill('')];
          out.push([`| ${pad(rows[0]).join(' | ')} |`, `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(r => `| ${pad(r).join(' | ')} |`)].join('\n')); }
      } else if (tag === 'img' || tag === 'figure' || tag === 'picture') {
        const img = tag === 'img' ? c : c.querySelector('img');
        const src = img && (img.currentSrc || img.src);
        if (src && !src.startsWith('data:')) out.push(`![${img.alt || c.querySelector('figcaption')?.innerText?.trim() || ''}](${abs(src)})`);
      } else if (tag === 'hr') out.push('---');
      else walk(c);
    }
  };
  walk(root);
  let md = out.join('\n\n').replace(/\n{3,}/g, '\n\n');
  const words = (root.innerText || '').trim().split(/\s+/).filter(Boolean).length;
  const truncated = md.length > maxChars;
  if (truncated) md = md.slice(0, maxChars) + '\n\n…';
  const date = meta('article:published_time') || document.querySelector('time[datetime]')?.getAttribute('datetime') || '';
  return {
    title: meta('og:title') || document.querySelector('h1')?.innerText?.trim() || document.title,
    byline: meta('author') || document.querySelector('[rel=author], .author, .byline')?.innerText?.trim() || '',
    date, site: meta('og:site_name') || location.hostname, lang: document.documentElement.lang || '',
    description: meta('description') || meta('og:description'), url: location.href,
    canonical: document.querySelector('link[rel=canonical]')?.href || '',
    words, minutes: Math.max(1, Math.round(words / 230)), truncated, markdown: md,
  };
}

// ---------- browser_pdf ----------
async function scrollThrough(page) {
  // Fuerza la carga de imágenes "lazy" antes de imprimir y vuelve arriba
  await page.evaluate(async () => {
    const step = innerHeight * 0.9;
    for (let y = 0; y < document.documentElement.scrollHeight && y < 40000; y += step) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
    scrollTo(0, 0);
  }).catch(() => {});
}

const PAPER = { A4: [8.27, 11.69], Letter: [8.5, 11], Legal: [8.5, 14] };
export async function savePdf(ab, page, { file, format = 'pdf', paper = 'A4', landscape = false, background = true, media = 'screen', lazy = true }) {
  const ext = format === 'mhtml' ? 'mhtml' : 'pdf';
  const title = await page.title().catch(() => '');
  const out = outPath(file && (path.extname(file) ? file : `${file}.${ext}`), path.join(host(page.url()), `${slug(title)}-${stamp()}.${ext}`));
  if (lazy) await scrollThrough(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    if (format === 'mhtml') {
      const { data } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
      fs.writeFileSync(out, data);
    } else {
      const [w, h] = PAPER[paper] || PAPER.A4;
      const opts = { printBackground: background, landscape, paperWidth: w, paperHeight: h, marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4 };
      let data;
      if (media === 'screen') await page.emulateMedia({ media: 'screen' }).catch(() => {});
      try { ({ data } = await cdp.send('Page.printToPDF', opts)); }
      catch (e) {
        // Algunas versiones de Chrome con ventana no imprimen: se repite en un Chrome invisible con las mismas cookies
        data = await printHeadless(ab, page, opts, media, e);
      } finally { if (media === 'screen') await page.emulateMedia({ media: null }).catch(() => {}); }
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
    }
  } finally { await cdp.detach().catch(() => {}); }
  return { file: out, bytes: fs.statSync(out).size, format: ext };
}

async function printHeadless(ab, page, opts, media, why) {
  const exe = ab.executablePath?.();
  if (!exe) throw why;
  const state = await page.context().storageState().catch(() => undefined);
  const b = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const ctx = await b.newContext({ storageState: state, viewport: page.viewportSize() || { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(page.url(), { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    if (media === 'screen') await p.emulateMedia({ media: 'screen' });
    await scrollThrough(p);
    const cdp = await ctx.newCDPSession(p);
    const { data } = await cdp.send('Page.printToPDF', opts);
    return data;
  } finally { await b.close().catch(() => {}); }
}

// ---------- Multimedia: lo que hay en la página ----------
export function mediaInPage({ scanBackgrounds }) {
  const abs = u => { try { return new URL(u, location.href).href; } catch { return null; } };
  const seen = new Map();
  const add = (type, url, extra = {}) => {
    const u = abs(url); if (!u || u.startsWith('blob:') || u.startsWith('javascript:')) return;
    if (!seen.has(u)) seen.set(u, { type, url: u, ...extra });
  };
  const bestSrcset = el => {
    const s = el.getAttribute('srcset'); if (!s) return null;
    return s.split(',').map(x => x.trim().split(/\s+/)).map(([u, d]) => [u, parseFloat(d) || 1]).sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  for (const img of document.images) {
    const src = bestSrcset(img) || img.currentSrc || img.src;
    if (src) add('image', src, { alt: img.alt || '', width: img.naturalWidth, height: img.naturalHeight });
  }
  for (const s of document.querySelectorAll('picture source[srcset]')) add('image', bestSrcset(s));
  const videos = [];
  for (const v of document.querySelectorAll('video')) {
    const src = v.currentSrc || v.src;
    videos.push({ src, blob: !!src && src.startsWith('blob:'), drm: !!v.mediaKeys, duration: isFinite(v.duration) ? v.duration : null, width: v.videoWidth, height: v.videoHeight, poster: v.poster });
    if (src) add('video', src, { duration: isFinite(v.duration) ? v.duration : null });
    for (const s of v.querySelectorAll('source[src]')) add('video', s.getAttribute('src'));
    if (v.poster) add('image', v.poster, { alt: 'poster' });
  }
  for (const a of document.querySelectorAll('audio')) { if (a.currentSrc || a.src) add('audio', a.currentSrc || a.src); for (const s of a.querySelectorAll('source[src]')) add('audio', s.getAttribute('src')); }
  for (const n of ['og:image', 'twitter:image', 'og:video', 'og:audio']) {
    const c = document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content;
    if (c) add(n.endsWith('video') ? 'video' : n.endsWith('audio') ? 'audio' : 'image', c);
  }
  const EXT = { image: /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)(\?|#|$)/i, video: /\.(mp4|webm|mov|m4v|mkv|m3u8|mpd)(\?|#|$)/i, audio: /\.(mp3|wav|ogg|m4a|aac|flac|opus)(\?|#|$)/i,
    doc: /\.(pdf|docx?|xlsx?|pptx?|csv|txt|zip|rar|7z|epub|odt|ods|rtf)(\?|#|$)/i };
  for (const a of document.querySelectorAll('a[href]')) {
    const h = a.getAttribute('href');
    for (const [t, re] of Object.entries(EXT)) if (re.test(h)) { add(t, h, { alt: (a.innerText || '').trim().slice(0, 120) }); break; }
  }
  if (scanBackgrounds) {
    let n = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (++n > 4000) break;
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) if (!m[1].startsWith('data:')) add('image', m[1], { alt: 'background' });
    }
  }
  return { items: [...seen.values()], videos, title: document.title };
}

// Tipo por content-type o extensión
const TYPE_BY_CT = [[/^image\//, 'image'], [/mpegurl|dash\+xml/, 'video'], [/^video\//, 'video'], [/^audio\//, 'audio'],
  [/pdf|msword|officedocument|spreadsheet|presentation|zip|rar|7z|epub|csv|rtf|opendocument/, 'doc']];
export function classify(ct = '', url = '') {
  for (const [re, t] of TYPE_BY_CT) if (re.test(ct)) return t;
  if (/\.(m3u8|mpd|mp4|webm|mov|m4v)(\?|$)/i.test(url)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)(\?|$)/i.test(url)) return 'audio';
  if (/\.(jpe?g|png|gif|webp|avif|svg)(\?|$)/i.test(url)) return 'image';
  if (/\.(pdf|docx?|xlsx?|pptx?|zip|csv|epub)(\?|$)/i.test(url)) return 'doc';
  return null;
}
const EXT_BY_CT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'text/csv': 'csv' };
const FOLDER = { image: 'images', video: 'videos', audio: 'audio', doc: 'docs' };

async function fetchBytes(page, url) {
  // Con las cookies de la sesión del agente y el Referer de la página, como lo haría el navegador
  const r = await page.context().request.get(url, { headers: { referer: page.url() }, timeout: 120000, maxRedirects: 5 });
  if (!r.ok()) throw new Error(`HTTP ${r.status()}`);
  const len = Number(r.headers()['content-length'] || 0);
  if (len > MAX_MB * 1e6) throw new Error(`pasa de ${MAX_MB} MB (AGENT_MEDIA_MAX_MB)`);
  const body = await r.body();
  if (body.length > MAX_MB * 1e6) throw new Error(`pasa de ${MAX_MB} MB (AGENT_MEDIA_MAX_MB)`);
  return { body, ct: (r.headers()['content-type'] || '').split(';')[0].trim().toLowerCase() };
}

// ---------- browser_media ----------
export async function collectMedia(ab, page, { types = ['image', 'video', 'audio', 'doc'], download = true, max = 200, minBytes = 2000, minWidth = 0, backgrounds = true, folder }) {
  const dom = await page.evaluate(mediaInPage, { scanBackgrounds: backgrounds });
  const net = ab.mediaLog(page).map(e => ({ type: classify(e.ct, e.url), url: e.url, ct: e.ct, bytes: e.bytes, source: 'network' }));
  const all = new Map();
  for (const it of dom.items) all.set(it.url, { ...it, source: 'page' });
  for (const it of net) if (it.type && !all.has(it.url)) all.set(it.url, it);
  let list = [...all.values()].filter(it => types.includes(it.type))
    // Los fragmentos de un stream (.ts, .m4s) no son archivos útiles por separado: los junta browser_video
    .filter(it => !/\.(ts|m4s|m4f)(\?|$)/i.test(it.url) && !/mp2t|iso.segment/.test(it.ct || ''))
    .filter(it => !(it.type === 'image' && minWidth && it.width && it.width < minWidth))
    .filter(it => ab.originAllowed(it.url));
  const manifests = list.filter(it => /\.(m3u8|mpd)(\?|$)/i.test(it.url) || /mpegurl|dash\+xml/.test(it.ct || ''));
  list = list.filter(it => !manifests.includes(it));
  const counts = {}; for (const it of list) counts[it.type] = (counts[it.type] || 0) + 1;
  if (!download) return { listed: list.slice(0, max), counts, streams: manifests.map(m => m.url), videosInPage: dom.videos };

  const dir = outPath(folder, path.join('media', host(page.url()), stamp()));
  const saved = [], skipped = [], hashes = new Set(), used = new Set();
  for (const it of list.slice(0, max)) {
    try {
      const { body, ct } = await fetchBytes(page, it.url);
      if (body.length < minBytes) { skipped.push({ url: it.url, why: `menos de ${minBytes} bytes` }); continue; }
      const sha1 = crypto.createHash('sha1').update(body).digest('hex');
      if (hashes.has(sha1)) { skipped.push({ url: it.url, why: 'duplicado' }); continue; }
      hashes.add(sha1);
      const type = classify(ct, it.url) || it.type;
      let base = slug(decodeURIComponent(new URL(it.url).pathname.split('/').pop() || '').replace(/\.[^.]+$/, ''), 50) || type;
      const ext = EXT_BY_CT[ct] || (new URL(it.url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase()) || 'bin';
      let name = `${base}.${ext}`, k = 1;
      while (used.has(`${type}/${name}`)) name = `${base}-${++k}.${ext}`;
      used.add(`${type}/${name}`);
      const sub = path.join(dir, FOLDER[type] || 'other');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, name), body);
      saved.push({ type, file: path.join(FOLDER[type] || 'other', name), url: it.url, bytes: body.length, sha1, contentType: ct, alt: it.alt || undefined, width: it.width || undefined, height: it.height || undefined, source: it.source });
    } catch (e) { skipped.push({ url: it.url, why: e.message }); }
  }
  const manifest = { page: page.url(), title: dom.title, savedAt: new Date().toISOString(), items: saved, skipped, streams: manifests.map(m => m.url) };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir, saved, skipped, streams: manifest.streams, counts };
}

// ---------- browser_video ----------
const DRM_IN_MANIFEST = /SAMPLE-AES|com\.widevine|com\.microsoft\.playready|com\.apple\.fps|urn:uuid:edef8ba9|cenc:default_KID|ContentProtection/i;

export async function videoCandidates(ab, page) {
  const dom = await page.evaluate(mediaInPage, { scanBackgrounds: false });
  const out = [];
  const add = c => { if (c.url && !out.some(o => o.url === c.url) && ab.originAllowed(c.url)) out.push(c); };
  for (const e of ab.mediaLog(page)) {
    if (/mpegurl/.test(e.ct) || /\.m3u8(\?|$)/i.test(e.url)) add({ kind: 'hls', url: e.url, bytes: e.bytes });
    else if (/dash\+xml/.test(e.ct) || /\.mpd(\?|$)/i.test(e.url)) add({ kind: 'dash', url: e.url, bytes: e.bytes });
    else if (/^video\/(mp4|webm|quicktime)/.test(e.ct) && !/\.(m4s|ts)(\?|$)/i.test(e.url)) add({ kind: 'file', url: e.url, bytes: e.bytes });
  }
  for (const it of dom.items.filter(i => i.type === 'video')) {
    if (/\.m3u8(\?|$)/i.test(it.url)) add({ kind: 'hls', url: it.url });
    else if (/\.mpd(\?|$)/i.test(it.url)) add({ kind: 'dash', url: it.url });
    else add({ kind: 'file', url: it.url, duration: it.duration });
  }
  // HLS maestro antes que sus variantes: ffmpeg elige la mejor calidad desde el maestro
  out.sort((a, b) => (b.kind !== 'file') - (a.kind !== 'file') || (b.bytes || 0) - (a.bytes || 0));
  return { candidates: out, drm: dom.videos.some(v => v.drm), blobOnly: dom.videos.some(v => v.blob), title: dom.title };
}

export async function downloadVideo(ab, page, { index, file, list }) {
  const v = await videoCandidates(ab, page);
  if (list) return { list: v.candidates, drm: v.drm, title: v.title };
  if (v.drm) throw new Error('este vídeo está protegido con DRM (EME/Widevine/PlayReady): no se puede ni se debe descargar');
  if (!v.candidates.length) throw new Error(v.blobOnly
    ? 'el reproductor usa un blob: y la red no mostró un manifiesto (.m3u8/.mpd) ni un archivo de vídeo; reproduce el vídeo unos segundos y vuelve a intentarlo'
    : 'no encontré vídeos en esta página (si se cargan al reproducir, dale play y vuelve a intentarlo)');
  const c = v.candidates[index ?? 0];
  if (!c) throw new Error(`no hay vídeo con índice ${index}; usa list:true para verlos`);
  const ext = c.kind === 'file' ? (c.url.match(/\.(webm|mov|m4v)(\?|$)/i)?.[1]?.toLowerCase() || 'mp4') : 'mp4';
  const out = outPath(file && (path.extname(file) ? file : `${file}.${ext}`), path.join('videos', host(page.url()), `${slug(v.title)}-${stamp()}.${ext}`));
  if (c.kind === 'file') {
    const { body } = await fetchBytes(page, c.url);
    fs.writeFileSync(out, body);
    return { file: out, bytes: body.length, kind: c.kind, url: c.url };
  }
  // Manifiesto HLS/DASH: comprobar DRM antes de nada y juntar los fragmentos con ffmpeg
  const r = await page.context().request.get(c.url, { headers: { referer: page.url() } });
  const text = await r.text();
  if (DRM_IN_MANIFEST.test(text)) throw new Error('el stream está cifrado con DRM (SAMPLE-AES/Widevine/PlayReady/FairPlay): no se puede ni se debe descargar');
  const ff = findFfmpeg();
  if (!ff) throw new Error(`es un stream ${c.kind.toUpperCase()} y hace falta ffmpeg en el PATH (o AGENT_FFMPEG) para juntar los fragmentos`);
  const cookies = await page.context().cookies(c.url).catch(() => []);
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => 'Mozilla/5.0');
  const headers = `Referer: ${page.url()}\r\nUser-Agent: ${ua}\r\n` + (cookies.length ? `Cookie: ${cookies.map(k => `${k.name}=${k.value}`).join('; ')}\r\n` : '');
  await new Promise((resolve, reject) => {
    const p = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-headers', headers, '-i', c.url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', out], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => (err += d));
    const t = setTimeout(() => { p.kill(); reject(new Error('ffmpeg superó 30 minutos')); }, 30 * 60e3);
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg terminó con código ${code}: ${err.slice(-400)}`)); });
    p.on('error', reject);
  });
  const bytes = fs.statSync(out).size;
  if (bytes > MAX_MB * 1e6) { fs.rmSync(out, { force: true }); throw new Error(`el vídeo pasa de ${MAX_MB} MB (AGENT_MEDIA_MAX_MB)`); }
  return { file: out, bytes, kind: c.kind, url: c.url };
}
