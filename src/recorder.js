// Grabación de la pestaña del agente (con el cursor rojo) para clips de demo.
// CDP Page.startScreencast solo emite frames cuando la pantalla cambia; guardamos
// cada JPEG con su timestamp y al parar damos a cada frame la duración real hasta
// el siguiente, de modo que las pausas conservan su tiempo.
// Codificación: ffmpeg (MP4 H.264) si está disponible; si no, WebM con MediaRecorder
// dentro del propio Chrome (sin dependencias nativas, pero tarda lo que dura el clip).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const DIR = process.env.AGENT_RECORDINGS || path.join(os.homedir(), '.agentic-browser', 'recordings');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ffmpegPath;
export function findFfmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const cand = process.env.AGENT_FFMPEG || 'ffmpeg';
  if (cand === 'none') return (ffmpegPath = null);
  const r = spawnSync(cand, ['-version'], { stdio: 'ignore', windowsHide: true });
  return (ffmpegPath = r.status === 0 ? cand : null);
}

const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');

export class Recorder {
  constructor(ab) { this.ab = ab; this.rec = null; }

  get active() { return !!this.rec; }

  async start(page, { fps = 25, maxSeconds = 120, file, format, demo } = {}) {
    if (this.rec) throw new Error('ya hay una grabación en curso; llama a browser_record_stop');
    const ff = findFfmpeg();
    if (!format) format = ff ? 'mp4' : 'webm';
    const notes = [];
    if (format === 'mp4' && !ff) { format = 'webm'; notes.push('ffmpeg no está en el PATH: se generará WebM'); }
    fs.mkdirSync(DIR, { recursive: true });
    // Restos de grabaciones interrumpidas (servidor cerrado sin browser_record_stop)
    for (const d of fs.readdirSync(DIR)) {
      const p = path.join(DIR, d);
      try { if (d.startsWith('.frames-') && Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
    let out = file ? path.resolve(DIR, file) : path.join(DIR, `demo-${stamp()}.${format}`);
    if (path.extname(out).toLowerCase() !== '.' + format) out = out.replace(/\.[^.\\/]*$/, '') + '.' + format;
    const tmp = fs.mkdtempSync(path.join(DIR, '.frames-'));
    const cdp = await page.context().newCDPSession(page);
    const rec = { page, cdp, tmp, out, format, fps: Math.min(60, Math.max(1, fps)), frames: [], t0: Date.now() / 1000, stopped: null, notes, timer: null, speed: null };
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      if (rec.stopped) return;
      const f = path.join(tmp, `${String(rec.frames.length).padStart(6, '0')}.jpg`);
      fs.writeFileSync(f, Buffer.from(data, 'base64'));
      rec.frames.push({ file: f, ts: metadata.timestamp ?? Date.now() / 1000 });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
    // Modo demo: cursor más lento para que se lea a simple vista en el vídeo
    if (demo) { rec.speed = this.ab.opts.cursorSpeed; this.ab.opts.cursorSpeed = Math.max(rec.speed, 300); }
    rec.timer = setTimeout(() => this._halt(rec).catch(() => {}), Math.min(600, Math.max(1, maxSeconds)) * 1000);
    this.rec = rec;
    return rec;
  }

  async _halt(rec) {
    if (rec.stopped) return;
    rec.stopped = Date.now() / 1000;
    clearTimeout(rec.timer);
    if (rec.speed !== null) this.ab.opts.cursorSpeed = rec.speed;
    await rec.cdp.send('Page.stopScreencast').catch(() => {});
    await rec.cdp.detach().catch(() => {});
  }

  async stop() {
    const rec = this.rec;
    if (!rec) throw new Error('no hay ninguna grabación en curso; usa browser_record_start');
    this.rec = null;
    const autoStopped = !!rec.stopped;
    await this._halt(rec);
    try {
      if (!rec.frames.length) throw new Error('no llegó ningún frame (¿la pestaña estaba oculta o minimizada?)');
      // Duración real de cada frame = hasta el siguiente; el último, hasta el stop
      const fr = rec.frames;
      const durs = fr.map((f, i) => Math.max(0.001, (i + 1 < fr.length ? fr[i + 1].ts : rec.stopped) - f.ts));
      if (rec.format === 'mp4') await this._ffmpeg(rec, durs);
      else await this._webm(rec, durs);
      const seconds = durs.reduce((a, b) => a + b, 0);
      const { size } = fs.statSync(rec.out);
      if (autoStopped) rec.notes.push('se alcanzó maxSeconds y la grabación se detuvo sola');
      return { file: rec.out, format: rec.format, seconds: Math.round(seconds * 100) / 100, bytes: size, frames: fr.length, notes: rec.notes };
    } finally {
      fs.rmSync(rec.tmp, { recursive: true, force: true });
    }
  }

  async _ffmpeg(rec, durs) {
    // Demuxer concat: cada frame con su duración; -r convierte a fps constante rellenando
    const esc = p => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
    const lines = ['ffconcat version 1.0'];
    rec.frames.forEach((f, i) => lines.push(`file '${esc(f.file)}'`, `duration ${durs[i].toFixed(4)}`));
    lines.push(`file '${esc(rec.frames.at(-1).file)}'`); // el último se repite para que respete su duración
    const list = path.join(rec.tmp, 'list.txt');
    fs.writeFileSync(list, lines.join('\n'));
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-r', String(rec.fps), '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', rec.out];
    await new Promise((resolve, reject) => {
      const p = spawn(findFfmpeg(), args, { windowsHide: true });
      let err = '';
      p.stderr.on('data', d => { err += d; });
      p.on('error', reject);
      p.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg falló (${code}): ${err.slice(-400)}`))));
    });
  }

  async _webm(rec, durs) {
    // Reproduce los frames en un canvas de una pestaña auxiliar y lo graba con MediaRecorder.
    // El reloj es real, así que tarda lo que dura el clip; las pausas quedan tal cual.
    const ab = this.ab, prev = ab.page, nEvents = ab.events.length;
    const enc = await ab.context.newPage();
    ab.page = prev; ab.events.splice(nEvents); // no es una pestaña del agente
    try {
      await enc.evaluate(async fps => {
        const c = document.createElement('canvas');
        document.body.append(c);
        const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
        const mr = new MediaRecorder(c.captureStream(fps), { mimeType: type, videoBitsPerSecond: 6e6 });
        const chunks = [];
        mr.ondataavailable = e => e.data.size && chunks.push(e.data);
        window.__rec = { c, mr, chunks, started: false, img: null };
        // Redibuja el frame actual: así las pausas largas (y el final) no se pierden
        setInterval(() => { const r = window.__rec; if (r.img) r.c.getContext('2d').drawImage(r.img, 0, 0); }, 200);
      }, rec.fps);
      for (let i = 0; i < rec.frames.length; i++) {
        const t = Date.now();
        const b64 = fs.readFileSync(rec.frames[i].file).toString('base64');
        await enc.evaluate(async src => {
          const r = window.__rec, img = new Image();
          img.src = 'data:image/jpeg;base64,' + src;
          await img.decode();
          if (r.c.width !== img.naturalWidth) { r.c.width = img.naturalWidth; r.c.height = img.naturalHeight; }
          r.c.getContext('2d').drawImage(img, 0, 0);
          r.img = img;
          if (!r.started) { r.started = true; r.mr.start(); }
        }, b64);
        await sleep(Math.max(0, durs[i] * 1000 - (Date.now() - t)));
      }
      const b64 = await enc.evaluate(() => new Promise(res => {
        const r = window.__rec;
        r.mr.onstop = async () => {
          const buf = new Uint8Array(await new Blob(r.chunks, { type: 'video/webm' }).arrayBuffer());
          let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          res(btoa(s));
        };
        r.mr.stop();
      }));
      fs.writeFileSync(rec.out, Buffer.from(b64, 'base64'));
    } finally {
      await enc.close().catch(() => {});
      ab.page = prev;
      await prev?.bringToFront().catch(() => {});
    }
  }
}
