// Núcleo: lanza (o se conecta a) Chrome real y lo controla por CDP vía
// playwright-core. Gestiona pestañas, frames, el cursor visual y la percepción.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { overlayScript } from './overlay.js';
import { perceptionScript } from './perception.js';

const CHROME_CANDIDATES = [
  process.env.AGENT_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  // Otros navegadores Chromium (mismo protocolo CDP): Edge viene con Windows
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser',
].filter(Boolean);

export function findChrome() {
  return CHROME_CANDIDATES.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// AGENT_SPEED: ritmo del cursor y de las pausas. fast = trabajo diario; demo = para grabar vídeos
const SPEEDS = {
  fast: { cursor: 35, minMove: 30, maxMove: 250, typeDelay: 0, settle: 100, scrollWait: 120 },
  normal: { cursor: 120, minMove: 80, maxMove: 900, typeDelay: 15, settle: 120, scrollWait: 250 },
  demo: { cursor: 220, minMove: 150, maxMove: 1400, typeDelay: 35, settle: 200, scrollWait: 400 },
};
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class AgentBrowser {
  constructor(opts = {}) {
    this.opts = {
      headless: process.env.AGENT_HEADLESS === '1',
      cdpUrl: process.env.AGENT_CDP_URL || null,
      userDataDir: process.env.AGENT_PROFILE || path.join(os.homedir(), '.agentic-browser', 'profile'),
      downloadsDir: process.env.AGENT_DOWNLOADS || path.join(os.homedir(), '.agentic-browser', 'downloads'),
      // ms por cada 100 px de recorrido del cursor; 0 = teletransporte
      cursorSpeed: null,
      dialogs: process.env.AGENT_DIALOGS || 'accept',
      viewport: null,
      ...opts,
    };
    // Con ventana, la página ocupa el tamaño real de la ventana (maximizada): una
    // fija de 1280x800 no cabe en pantallas con escalado (1280x805 útiles a 150 %).
    // AGENT_VIEWPORT=1280x800 la fija; sin ventana (headless) se fija siempre.
    if (!opts.viewport) {
      const m = String(process.env.AGENT_VIEWPORT || '').match(/^(\d+)x(\d+)$/);
      this.opts.viewport = m ? { width: +m[1], height: +m[2] } : this.opts.headless ? { width: 1280, height: 800 } : null;
    }
    this.lastViewport = this.opts.viewport;
    this.speed = SPEEDS[process.env.AGENT_SPEED] || SPEEDS.normal;
    if (this.opts.cursorSpeed == null) this.opts.cursorSpeed = Number(process.env.AGENT_CURSOR_SPEED ?? this.speed.cursor);
    this.context = null;
    this.page = null;
    this.cursor = new WeakMap();     // page -> {x,y}
    this.consoleLog = new WeakMap(); // page -> [{type,text}]
    this.events = [];                // diálogos, descargas, popups
    this.frameIds = new WeakMap();
    this.nextFrameId = 1;
    this.starting = null;
    this.lastSnap = new WeakMap();   // page -> último snapshot (para diff)
    this.lastAgentAction = 0;        // ms de la última acción de entrada del agente (clic, tecla...)
    this.prevPages = [];             // pila de pestañas activas anteriores (para volver al cerrar)
    this.openers = new WeakMap();    // page -> page que la abrió
    this.ownPending = 0;             // pestañas que está creando el propio agente (browser_tabs new)
    this.hud = { on: process.env.AGENT_HUD === '1', stats: null }; // contador de tokens en pantalla
    const allow = process.env.AGENT_ALLOWED_ORIGINS;
    this.allowed = allow ? allow.split(',').map(h => h.trim().toLowerCase()).filter(Boolean) : null;
  }

  // Lista blanca de dominios (AGENT_ALLOWED_ORIGINS=ejemplo.com,wikipedia.org). Subdominios incluidos.
  originAllowed(url) {
    if (!this.allowed) return true;
    let u; try { u = new URL(url); } catch { return false; }
    if (u.protocol === 'about:') return true;
    const h = u.hostname.toLowerCase();
    return this.allowed.some(a => h === a || h.endsWith('.' + a));
  }

  async start() {
    if (this.context) return;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => (this.starting = null));
    return this.starting;
  }

  async _start() {
    if (this.opts.cdpUrl) {
      // Modo "adjuntar": controla un Chrome ya abierto con --remote-debugging-port
      this.browser = await chromium.connectOverCDP(this.opts.cdpUrl);
      this.context = this.browser.contexts()[0] || await this.browser.newContext();
    } else {
      const executablePath = findChrome();
      if (!executablePath) throw new Error('No encuentro chrome.exe. Define AGENT_CHROME con la ruta.');
      fs.mkdirSync(this.opts.userDataDir, { recursive: true });
      fs.mkdirSync(this.opts.downloadsDir, { recursive: true });
      try {
        this.context = await chromium.launchPersistentContext(this.opts.userDataDir, {
          executablePath,
          headless: this.opts.headless,
          viewport: this.opts.viewport,
          acceptDownloads: true,
          downloadsPath: this.opts.downloadsDir,
          args: ['--no-first-run', '--no-default-browser-check', ...(this.opts.viewport ? [] : ['--start-maximized'])],
        });
      } catch (e) {
        if (/ProcessSingleton|already in use|SingletonLock|lock/i.test(e.message)) {
          throw new Error(`El perfil ${this.opts.userDataDir} ya está en uso por otro Chrome/agente. ` +
            'Cierra esa ventana, usa otro AGENT_PROFILE, o comparte el navegador con AGENT_CDP_URL / la API HTTP.');
        }
        throw e;
      }
    }
    await this.context.addInitScript(overlayScript);
    await this.context.addInitScript(perceptionScript);
    this.context.on('page', p => this._onPage(p));
    this.context.on('close', () => { this.context = null; this.page = null; });
    for (const p of this.context.pages()) this._wire(p);
    this.page = this.context.pages()[0] || await this.newTab();
  }

  // Marca una acción de entrada del agente: solo los popups que provoque pasan a ser la pestaña activa
  markAction() { this.lastAgentAction = Date.now(); }

  // Pestaña creada explícitamente por el agente: siempre pasa a ser la activa
  async newTab() {
    this.ownPending++;
    try { const p = await this.context.newPage(); this.setActive(p); return p; } finally { this.ownPending = Math.max(0, this.ownPending - 1); }
  }

  setActive(p) {
    if (!p || p === this.page) return;
    if (this.page && !this.page.isClosed()) {
      this.prevPages = this.prevPages.filter(x => x !== this.page && !x.isClosed());
      this.prevPages.push(this.page);
      if (this.prevPages.length > 10) this.prevPages.shift();
    }
    this.page = p;
  }

  // Una pestaña nueva solo se activa si la abrió la pestaña activa justo tras una acción del agente.
  // Los popups que abren las webs solas (One Tap de Google, anuncios) quedan en segundo plano.
  async _onPage(p) {
    this._wire(p);
    if (this.ownPending > 0) return; // la gestiona newTab()
    const t = Date.now(), active = this.page;
    const opener = await p.opener().catch(() => null);
    if (opener) this.openers.set(p, opener);
    const index = this.context?.pages().indexOf(p) ?? -1;
    if (opener && opener === active && t - this.lastAgentAction < 2000) {
      this.events.push({ type: 'new-tab', index, url: p.url(), note: 'ahora es la pestaña activa' });
      this.setActive(p);
    } else this.events.push({ type: 'background-tab', index, url: p.url(), note: 'la abrió la página, no se activa' });
  }

  // Al cerrar la activa: su opener, si no la anterior de la pila, si no la última
  _fallback(closed) {
    const alive = x => x && x !== closed && !x.isClosed() && this.context?.pages().includes(x);
    const o = this.openers.get(closed);
    if (alive(o)) return o;
    this.prevPages = this.prevPages.filter(alive);
    return this.prevPages.pop() || this.context?.pages().filter(x => x !== closed).at(-1) || null;
  }

  _wire(page) {
    if (this.consoleLog.has(page)) return;
    this.consoleLog.set(page, []);
    page.on('console', m => { const l = this.consoleLog.get(page); l.push({ type: m.type(), text: m.text().slice(0, 500) }); if (l.length > 200) l.shift(); });
    page.on('pageerror', e => this.consoleLog.get(page).push({ type: 'pageerror', text: String(e).slice(0, 500) }));
    page.on('dialog', async d => {
      this.events.push({ type: 'dialog', kind: d.type(), message: d.message(), action: this.opts.dialogs });
      try { this.opts.dialogs === 'dismiss' ? await d.dismiss() : await d.accept(); } catch {}
    });
    page.on('download', async dl => {
      const file = path.join(this.opts.downloadsDir, dl.suggestedFilename());
      try { await dl.saveAs(file); this.events.push({ type: 'download', file }); } catch (e) { this.events.push({ type: 'download-error', error: String(e) }); }
    });
    // Tras cada navegación, devolver el cursor a donde estaba (y el contador de tokens)
    page.on('load', () => {
      const c = this.cursor.get(page);
      if (c) page.evaluate(([x, y]) => window.__agentCursor?.move(x, y), [c.x, c.y]).catch(() => {});
      if (this.hud.on && this.hud.stats) this.showHud(page).catch(() => {});
    });
    page.on('close', () => { if (this.page === page) this.page = this._fallback(page); });
  }

  async active() {
    await this.start();
    if (!this.page || this.page.isClosed()) this.page = (this.page && this._fallback(this.page)) || this.context.pages().at(-1) || await this.newTab();
    return this.page;
  }

  // Asegura los scripts en documentos que existían antes del addInitScript
  async ensure(frame) {
    const ok = await frame.evaluate(() => !!window.__agentPerc).catch(() => false);
    if (!ok) {
      await frame.evaluate(perceptionScript).catch(() => {});
      if (frame === frame.page().mainFrame()) await frame.evaluate(overlayScript).catch(() => {});
    }
  }

  frameId(frame) {
    if (frame === frame.page().mainFrame()) return 0;
    let id = this.frameIds.get(frame);
    if (!id) { id = this.nextFrameId++; this.frameIds.set(frame, id); }
    return id;
  }

  // Frames visibles con su desplazamiento (en píxeles CSS del viewport principal)
  async frames(page) {
    const out = [];
    for (const f of page.frames()) {
      if (f.isDetached()) continue;
      if (f === page.mainFrame()) { out.push({ frame: f, id: 0, ox: 0, oy: 0 }); continue; }
      const el = await f.frameElement().catch(() => null);
      const box = el && await el.boundingBox().catch(() => null);
      if (!box || box.width < 2 || box.height < 2) continue;
      out.push({ frame: f, id: this.frameId(f), ox: box.x, oy: box.y });
    }
    return out;
  }

  parseRef(ref) {
    const m = String(ref).match(/^(?:f(\d+):)?(\d+)$/);
    if (!m) throw new Error(`ref inválido: ${ref}`);
    return { fid: m[1] ? Number(m[1]) : 0, id: Number(m[2]) };
  }

  async snapshot({ viewportOnly = true, includeText = false, max = 250 } = {}) {
    const page = await this.active();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const frames = await this.frames(page);
    let main;
    for (const fr of frames) {
      await this.ensure(fr.frame);
      const s = await fr.frame.evaluate(o => window.__agentPerc.snapshot(o),
        { ox: fr.ox, oy: fr.oy, viewportOnly, includeText: includeText && fr.id === 0, max }).catch(() => null);
      if (!s) continue;
      if (!fr.id) this.lastViewport = { width: s.viewport.w, height: s.viewport.h };
      if (fr.id) s.items.forEach(i => (i.ref = `f${fr.id}:${i.ref}`));
      if (!main) main = s; else main.items.push(...s.items);
    }
    return main;
  }

  // Devuelve [anterior, actual] y recuerda el actual para el próximo diff
  async snapshotWithPrev(opts) {
    const page = await this.active();
    const s = await this.snapshot(opts);
    const prev = this.lastSnap.get(page);
    if (s) this.lastSnap.set(page, s);
    return [prev && prev.url === s?.url ? prev : null, s];
  }

  // Traspaso al humano: banner con botones en la página. Sobrevive a navegaciones
  // (login, redirecciones de 2FA) volviendo a mostrarse en el documento nuevo.
  async requestHuman(reason, timeout = 600000) {
    if (this.opts.headless) throw new Error('No hay ventana visible (AGENT_HEADLESS=1): ningún humano puede ayudar.');
    const page = await this.active();
    await page.bringToFront().catch(() => {});
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await this.ensure(page.mainFrame());
      const left = deadline - Date.now();
      const r = await Promise.race([
        page.evaluate(t => window.__agentCursor ? window.__agentCursor.ask(t) : 'no-overlay', reason),
        new Promise(res => setTimeout(() => res('timeout'), left)),
      ]).catch(() => 'navigated');
      if (r === 'navigated') { await page.waitForLoadState('domcontentloaded').catch(() => {}); continue; }
      return r;
    }
    return 'timeout';
  }

  async resolve({ ref, x, y }) {
    const page = await this.active();
    if (ref !== undefined && ref !== null && ref !== '') {
      const { fid, id } = this.parseRef(ref);
      const fr = (await this.frames(page)).find(f => f.id === fid);
      if (!fr) throw new Error(`frame f${fid} ya no existe; vuelve a llamar a snapshot`);
      await this.ensure(fr.frame);
      // rect() hace scrollIntoView; re-medir offset del frame después
      const r = await fr.frame.evaluate(([i, ox, oy]) => window.__agentPerc.rect(i, ox, oy), [id, fr.ox, fr.oy]);
      if (!r) throw new Error(`ref ${ref} obsoleto (la página cambió). Llama a browser_snapshot otra vez.`);
      if (fid) {
        const again = (await this.frames(page)).find(f => f.id === fid);
        if (again) { const dx = again.ox - fr.ox, dy = again.oy - fr.oy; r.x += dx; r.y += dy; r.cx += dx; r.cy += dy; }
      }
      return { page, x: r.cx, y: r.cy, rect: r };
    }
    if (typeof x === 'number' && typeof y === 'number') return { page, x, y, rect: null };
    throw new Error('Indica ref o coordenadas x,y');
  }

  // Movimiento visible y continuo: genera mousemove reales a lo largo de una curva
  async moveTo(page, x, y) {
    const from = this.cursor.get(page) || { x: Math.round(this.opts.viewport?.width / 2 || 400), y: 40 };
    const dist = Math.hypot(x - from.x, y - from.y);
    const total = this.opts.cursorSpeed > 0 ? Math.min(this.speed.maxMove * Math.max(1, this.opts.cursorSpeed / this.speed.cursor), Math.max(this.speed.minMove, (dist / 100) * this.opts.cursorSpeed)) : 0;
    const steps = total ? Math.max(4, Math.round(total / 16)) : 1;
    // Ligera curva (control perpendicular) para que el trayecto se lea a simple vista
    const mx = (from.x + x) / 2 + (y - from.y) * 0.12, my = (from.y + y) / 2 - (x - from.x) * 0.12;
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps), u = 1 - t;
      const px = u * u * from.x + 2 * u * t * mx + t * t * x;
      const py = u * u * from.y + 2 * u * t * my + t * t * y;
      await page.mouse.move(px, py);
      if (total) await sleep(total / steps);
    }
    this.cursor.set(page, { x, y });
    // Los mousemove sobre iframes no llegan al frame principal: fijar posición explícitamente
    await page.evaluate(([x, y]) => window.__agentCursor?.move(x, y), [x, y]).catch(() => {});
  }

  async ripple(page, x, y, right) {
    await page.evaluate(([x, y, r]) => window.__agentCursor?.ripple(x, y, r ? 'right' : ''), [x, y, right]).catch(() => {});
  }

  async annotate(page, text, rect) {
    await page.evaluate(([t, r]) => { const c = window.__agentCursor; if (!c) return; if (t) c.say(t); if (r) c.highlight(r); }, [text, rect]).catch(() => {});
  }

  async showHud(page) {
    const s = this.hud.on ? this.hud.stats || { ratio: 0, used: 0, shots: 0, calls: 0 } : null;
    await page.evaluate(v => window.__agentCursor?.hud(v), s).catch(() => {});
  }

  async elementAt(x, y) {
    const page = await this.active();
    const frames = await this.frames(page);
    // El frame más interno cuyo rectángulo contiene el punto
    let best = frames[0];
    for (const fr of frames.slice(1)) {
      const el = await fr.frame.frameElement().catch(() => null);
      const b = el && await el.boundingBox().catch(() => null);
      if (b && x >= b.x && y >= b.y && x <= b.x + b.width && y <= b.y + b.height) best = fr;
    }
    await this.ensure(best.frame);
    const d = await best.frame.evaluate(([x, y, ox, oy]) => window.__agentPerc.at(x, y, ox, oy), [x, y, best.ox, best.oy]);
    if (d && best.id) d.ref = `f${best.id}:${d.ref}`;
    return d;
  }

  async find(query, max) {
    const page = await this.active();
    const out = [];
    for (const fr of await this.frames(page)) {
      await this.ensure(fr.frame);
      const r = await fr.frame.evaluate(([q, o]) => window.__agentPerc.find(q, o), [query, { ox: fr.ox, oy: fr.oy, max }]).catch(() => []);
      if (fr.id) r.forEach(i => (i.ref = `f${fr.id}:${i.ref}`));
      out.push(...r);
    }
    return out.slice(0, max);
  }

  // Espera un cambio en la página SIN consumir tokens: MutationObserver dentro de la
  // página + sondeo del título. Devuelve qué cambió (texto añadido, título nuevo).
  async watch(page, { selector, text, titleChange = true, timeout = 300000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const left = Math.min(deadline - Date.now(), 60000); // trozos de 60 s: sobrevive a recargas
      const r = await page.evaluate(([sel, txt, tc, ms]) => new Promise(resolve => {
        const root = (sel && document.querySelector(sel)) || document.body;
        const re = txt ? new RegExp(txt, 'i') : null;
        const t0 = document.title;
        const added = [];
        let debounce;
        const finish = reason => { obs.disconnect(); clearInterval(iv); clearTimeout(to); resolve({ reason, added: added.slice(-20), title: document.title }); };
        const obs = new MutationObserver(muts => {
          for (const m of muts) {
            const nodes = m.type === 'characterData' ? [m.target] : [...m.addedNodes];
            for (const n of nodes) {
              if (n.nodeType === 1 && n.localName === 'agent-cursor-host') continue;
              const s = (n.innerText ?? n.textContent ?? '').replace(/\s+/g, ' ').trim();
              if (s) added.push(s.slice(0, 300));
            }
          }
          if (!added.length) return;
          if (re && !added.some(a => re.test(a))) return;
          clearTimeout(debounce);
          debounce = setTimeout(() => finish('mutation'), 400); // agrupar ráfagas
        });
        obs.observe(root, { childList: true, subtree: true, characterData: true });
        const iv = setInterval(() => { if (tc && document.title !== t0) finish('title'); }, 500);
        const to = setTimeout(() => finish('timeout'), ms);
      }), [selector || null, text || null, titleChange, left]).catch(e => ({ reason: 'navigation', error: String(e).slice(0, 120) }));
      if (r.reason !== 'timeout') return r;
    }
    return { reason: 'timeout' };
  }

  drainEvents() { const e = this.events; this.events = []; return e; }

  async close() { await this.context?.close().catch(() => {}); await this.browser?.close().catch(() => {}); this.context = null; }
}
