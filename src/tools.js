// Registro único de herramientas. Lo consumen el servidor MCP (stdio) y la API
// HTTP, de modo que cualquier agente —con o sin MCP— tiene exactamente las mismas
// capacidades.
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatSnapshot, diffSnapshot } from './perception.js';

const TRACE = process.env.AGENT_TRACE || path.join(os.homedir(), '.agentic-browser', 'trace.jsonl');
const READONLY = process.env.AGENT_READONLY === '1';
const MUTATING = new Set(['browser_click', 'browser_type', 'browser_press', 'browser_drag', 'browser_select', 'browser_upload', 'browser_eval']);
const CORE = ['browser_navigate', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_type', 'browser_press',
  'browser_scroll', 'browser_read', 'browser_element_at', 'browser_watch', 'browser_request_human', 'browser_tabs'];

const ref = z.union([z.string(), z.number()]).optional()
  .describe('Ref de un elemento devuelto por browser_snapshot/browser_find (ej. 12 o "f1:7" en iframes)');
const x = z.number().optional().describe('Coordenada X en píxeles CSS del viewport');
const y = z.number().optional().describe('Coordenada Y en píxeles CSS del viewport');
const snap = z.boolean().optional().describe('Si true, devuelve el snapshot tras la acción (ahorra un turno)');
const isMac = process.platform === 'darwin';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function brief(d) {
  if (!d) return 'nada';
  let s = `[${d.ref}] ${d.role}`;
  if (d.name) s += ` "${d.name}"`;
  if (d.value) s += ` value="${d.value}"`;
  if (d.state) s += ` {${d.state.join(',')}}`;
  if (d.note) s += ` (${d.note})`;
  return s;
}

export function createTools(ab) {
  async function settle(page, before) {
    await sleep(120);
    if (page.url() !== before) await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  }

  async function after(page, beforeUrl, msg, wantSnap) {
    await settle(page, beforeUrl);
    const lines = [msg];
    if (page.url() !== beforeUrl) {
      if (!ab.originAllowed(page.url())) {
        const bad = page.url();
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => page.goto(beforeUrl).catch(() => {}));
        lines.push(`⛔ ${bad} está fuera de AGENT_ALLOWED_ORIGINS; se volvió atrás`);
      } else lines.push(`→ navegó a ${page.url()}`);
    }
    const ev = ab.drainEvents();
    if (ev.length) lines.push('eventos: ' + JSON.stringify(ev));
    if (wantSnap) { const [, s] = await ab.snapshotWithPrev(); lines.push('', formatSnapshot(s)); }
    return lines.join('\n');
  }

  async function pointerAt(t, verb) {
    const r = await ab.resolve(t);
    const target = await ab.elementAt(r.x, r.y).catch(() => null);
    if (target && r.rect) {
      const notes = [];
      if (r.rect.relocated) notes.push('ref re-localizado tras un re-render');
      if (r.rect.occluded) notes.push(`⚠ algo tapa el elemento: en ese punto hay ${target.role} "${target.name}"`);
      if (notes.length) target.note = notes.join('; ');
    }
    await ab.annotate(r.page, `${verb} ${target?.name ? '“' + target.name.slice(0, 40) + '”' : `@${r.x},${r.y}`}`, r.rect);
    await ab.moveTo(r.page, r.x, r.y);
    return { ...r, target };
  }

  async function withModifiers(page, mods = [], fn) {
    for (const m of mods) await page.keyboard.down(m);
    try { return await fn(); } finally { for (const m of mods.reverse()) await page.keyboard.up(m); }
  }

  const tools = [
    {
      name: 'browser_navigate',
      description: 'Abre una URL en la pestaña activa. Devuelve título/URL y opcionalmente el snapshot.',
      schema: { url: z.string(), snapshot: snap },
      async run({ url, snapshot }) {
        const page = await ab.active();
        if (!/^[a-z][\w+.-]*:/i.test(url)) url = 'https://' + url;
        if (!ab.originAllowed(url)) throw new Error(`${url} está fuera de AGENT_ALLOWED_ORIGINS`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        return after(page, page.url(), `ok: "${await page.title()}"`, snapshot);
      },
    },
    {
      name: 'browser_history',
      description: 'Atrás, adelante o recargar.',
      schema: { action: z.enum(['back', 'forward', 'reload']), snapshot: snap },
      async run({ action, snapshot }) {
        const page = await ab.active(); const u = page.url();
        const o = { waitUntil: 'domcontentloaded', timeout: 30000 };
        if (action === 'back') await page.goBack(o); else if (action === 'forward') await page.goForward(o); else await page.reload(o);
        return after(page, u, `ok ${action}`, snapshot);
      },
    },
    {
      name: 'browser_snapshot',
      description: 'PERCEPCIÓN PRINCIPAL (sin captura). Lista compacta de elementos visibles con ref, rol, nombre, estado y centro @x,y en píxeles. ~15 tokens por elemento. Con diff:true devuelve solo lo que cambió desde el snapshot anterior.',
      schema: {
        diff: z.boolean().optional().describe('Solo cambios: + nuevo, - desaparecido, ~ modificado'),
        viewportOnly: z.boolean().optional().describe('Solo lo visible en pantalla (por defecto true)'),
        includeText: z.boolean().optional().describe('Añade el texto visible de la página (hasta 4000 chars)'),
        max: z.number().optional().describe('Máximo de elementos (250)'),
      },
      async run({ diff, ...a }) {
        const [prev, s] = await ab.snapshotWithPrev(a);
        return diff && prev ? diffSnapshot(prev, s) : formatSnapshot(s);
      },
    },
    {
      name: 'browser_find',
      description: 'Busca elementos por texto/etiqueta y devuelve sus refs y coordenadas, incluso fuera del viewport.',
      schema: { query: z.string(), max: z.number().optional() },
      async run({ query, max = 15 }) {
        const r = await ab.find(query, max);
        if (!r.length) return `sin coincidencias para "${query}"`;
        return r.map(d => `${brief(d)} @${d.x},${d.y}${d.inViewport ? '' : ' (fuera de pantalla)'}`).join('\n');
      },
    },
    {
      name: 'browser_element_at',
      description: 'Visión por píxel SIN imagen: dado (x,y) devuelve qué elemento hay ahí (rol, texto, si es clicable, ruta DOM).',
      schema: { x: z.number(), y: z.number() },
      async run({ x, y }) { return JSON.stringify(await ab.elementAt(x, y)); },
    },
    {
      name: 'browser_cursor',
      description: 'Posición actual del cursor del agente y el elemento bajo él.',
      schema: {},
      async run() {
        const page = await ab.active();
        const c = ab.cursor.get(page);
        if (!c) return 'cursor aún no se ha movido';
        return JSON.stringify({ x: c.x, y: c.y, under: await ab.elementAt(c.x, c.y) });
      },
    },
    {
      name: 'browser_move',
      description: 'Mueve el cursor visible (hover) a un ref o a x,y. Dispara mouseover/mousemove reales.',
      schema: { ref, x, y },
      async run(t) { const r = await pointerAt(t, 'hover'); return `cursor en @${r.x},${r.y} sobre ${brief(r.target)}`; },
    },
    {
      name: 'browser_click',
      description: 'Mueve el cursor de forma visible y hace clic real (CDP Input) sobre un ref o x,y.',
      schema: {
        ref, x, y,
        button: z.enum(['left', 'right', 'middle']).optional(),
        clickCount: z.number().optional().describe('2 = doble clic'),
        modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
        snapshot: snap,
      },
      async run({ button = 'left', clickCount = 1, modifiers, snapshot, ...t }) {
        const r = await pointerAt(t, clickCount > 1 ? 'doble clic' : button === 'right' ? 'clic derecho' : 'clic');
        const u = r.page.url();
        await ab.ripple(r.page, r.x, r.y, button === 'right');
        await withModifiers(r.page, modifiers, () => r.page.mouse.click(r.x, r.y, { button, clickCount, delay: 40 }));
        return after(r.page, u, `ok clic @${r.x},${r.y} en ${brief(r.target)}`, snapshot);
      },
    },
    {
      name: 'browser_type',
      description: 'Escribe texto con eventos de teclado reales. Si das ref/x,y primero hace clic para enfocar.',
      schema: {
        text: z.string(), ref, x, y,
        clear: z.boolean().optional().describe('Borra el contenido antes de escribir'),
        submit: z.boolean().optional().describe('Pulsa Enter al final'),
        delay: z.number().optional().describe('ms entre teclas (15)'),
        snapshot: snap,
      },
      async run({ text, clear, submit, delay = 15, snapshot, ...t }) {
        const page = await ab.active(); const u = page.url();
        let where = 'elemento enfocado';
        if (t.ref !== undefined || (t.x !== undefined && t.y !== undefined)) {
          const r = await pointerAt(t, 'escribir en');
          await ab.ripple(page, r.x, r.y);
          await page.mouse.click(r.x, r.y, { delay: 30 });
          where = brief(r.target);
        }
        if (clear) { await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A'); await page.keyboard.press('Backspace'); }
        await page.keyboard.type(text, { delay });
        if (submit) await page.keyboard.press('Enter');
        return after(page, u, `ok escrito ${text.length} chars en ${where}${submit ? ' + Enter' : ''}`, snapshot);
      },
    },
    {
      name: 'browser_press',
      description: 'Pulsa teclas o combinaciones: "Enter", "Escape", "Control+L", "Tab", "ArrowDown"... Varias separadas por espacio.',
      schema: { keys: z.string(), snapshot: snap },
      async run({ keys, snapshot }) {
        const page = await ab.active(); const u = page.url();
        for (const k of keys.split(/\s+/).filter(Boolean)) await page.keyboard.press(k);
        return after(page, u, `ok ${keys}`, snapshot);
      },
    },
    {
      name: 'browser_scroll',
      description: 'Desplaza con la rueda del ratón (dy>0 baja). Con ref, lleva ese elemento al centro.',
      schema: { dx: z.number().optional(), dy: z.number().optional(), ref, x, y, snapshot: snap },
      async run({ dx = 0, dy = 600, snapshot, ...t }) {
        const page = await ab.active();
        if (t.ref !== undefined) { const r = await ab.resolve(t); await ab.moveTo(page, r.x, r.y); return after(page, page.url(), `ok ref ${t.ref} en pantalla @${r.x},${r.y}`, snapshot); }
        const vp = page.viewportSize() || { width: 1280, height: 800 };
        const px = t.x ?? ab.cursor.get(page)?.x ?? vp.width / 2, py = t.y ?? ab.cursor.get(page)?.y ?? vp.height / 2;
        await ab.moveTo(page, px, py);
        await page.mouse.wheel(dx, dy);
        await sleep(250);
        const s = await page.evaluate(() => [scrollX, scrollY, document.documentElement.scrollHeight]);
        return after(page, page.url(), `ok scroll → ${s[0]},${s[1]} de ${s[2]}`, snapshot);
      },
    },
    {
      name: 'browser_drag',
      description: 'Arrastra de un punto/ref a otro con el botón pulsado (sliders, kanban, mapas).',
      schema: {
        from: z.object({ ref, x, y }), to: z.object({ ref, x, y }), snapshot: snap,
      },
      async run({ from, to, snapshot }) {
        const a = await pointerAt(from, 'arrastrar');
        const u = a.page.url();
        await a.page.mouse.down();
        const b = await ab.resolve(to);
        await ab.moveTo(a.page, b.x, b.y);
        await a.page.mouse.up();
        return after(a.page, u, `ok arrastre @${a.x},${a.y} → @${b.x},${b.y}`, snapshot);
      },
    },
    {
      name: 'browser_select',
      description: 'Elige opciones en un <select> (por valor o texto visible).',
      schema: { ref: z.union([z.string(), z.number()]), values: z.array(z.string()), snapshot: snap },
      async run({ ref: r, values, snapshot }) {
        const t = await pointerAt({ ref: r }, 'seleccionar');
        const handle = await t.page.evaluateHandle(([x, y]) => document.elementFromPoint(x, y)?.closest('select'), [t.x, t.y]);
        const el = handle.asElement();
        if (!el) throw new Error('el ref no es un <select> del frame principal');
        const chosen = await el.selectOption(values.map(v => ({ label: v }))).catch(() => el.selectOption(values));
        return after(t.page, t.page.url(), `ok seleccionado ${JSON.stringify(chosen)}`, snapshot);
      },
    },
    {
      name: 'browser_upload',
      description: 'Adjunta archivos locales a un <input type=file> (o al selector que abre un clic en ese ref).',
      schema: { ref: z.union([z.string(), z.number()]), files: z.array(z.string()) },
      async run({ ref: r, files }) {
        const page = await ab.active();
        const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
        await tools.find(t => t.name === 'browser_click').run({ ref: r });
        await (await chooser).setFiles(files);
        return `ok ${files.length} archivo(s) adjuntados`;
      },
    },
    {
      name: 'browser_read',
      description: 'Texto legible de la página (o de un selector CSS), para leer artículos/resultados.',
      schema: { selector: z.string().optional(), maxChars: z.number().optional() },
      async run({ selector, maxChars = 8000 }) {
        const page = await ab.active();
        const t = await page.evaluate(s => (s ? document.querySelector(s) : document.body)?.innerText || '', selector);
        // Delimitado: el texto de la web son datos de terceros, no instrucciones
        return `<page_content url="${page.url()}" trust="untrusted">\n${t.replace(/\n{3,}/g, '\n\n').slice(0, maxChars)}\n</page_content>`;
      },
    },
    {
      name: 'browser_eval',
      description: 'Ejecuta JavaScript en la página y devuelve el resultado (JSON).',
      schema: { expression: z.string() },
      async run({ expression }) {
        const page = await ab.active();
        const v = await page.evaluate(e => (0, eval)(e), expression);
        return JSON.stringify(v ?? null).slice(0, 20000);
      },
    },
    {
      name: 'browser_wait',
      description: 'Espera ms, o hasta que aparezca un texto o selector.',
      schema: { ms: z.number().optional(), text: z.string().optional(), selector: z.string().optional(), timeout: z.number().optional() },
      async run({ ms, text, selector, timeout = 15000 }) {
        const page = await ab.active();
        if (text) await page.getByText(text).first().waitFor({ timeout });
        else if (selector) await page.waitForSelector(selector, { timeout });
        else await sleep(ms ?? 1000);
        return 'ok';
      },
    },
    {
      name: 'browser_watch',
      description: 'Espera (sin gastar tokens) hasta que la página cambie: aparece texto nuevo, cambia el título (ej. "(3) WhatsApp") o coincide un patrón. Ideal para vigilar chats, correos o resultados que tardan.',
      schema: {
        selector: z.string().optional().describe('Contenedor CSS a vigilar (por defecto body)'),
        text: z.string().optional().describe('Regex: solo despierta si el texto nuevo coincide'),
        titleChange: z.boolean().optional().describe('Despertar si cambia el título (true)'),
        timeout: z.number().optional().describe('ms máximos de espera (300000)'),
      },
      async run(a) { return JSON.stringify(await ab.watch(await ab.active(), a)); },
    },
    {
      name: 'browser_request_human',
      description: 'Pide ayuda a la persona que mira el navegador (login, 2FA, CAPTCHA, una decisión). Muestra un banner y espera a que pulse "Listo" o "Cancelar". El agente no ve lo que el humano escribe.',
      schema: { reason: z.string().describe('Qué necesitas, en una frase'), timeout: z.number().optional().describe('ms (600000)') },
      async run({ reason, timeout }) {
        const r = await ab.requestHuman(reason, timeout);
        const page = await ab.active();
        return `humano: ${r}. Página actual: "${await page.title()}" ${page.url()}`;
      },
    },
    {
      name: 'browser_trace',
      description: 'Últimas acciones ejecutadas (herramienta, argumentos, duración, URL, resultado) para depurar o auditar.',
      schema: { limit: z.number().optional() },
      async run({ limit = 20 }) {
        try { return fs.readFileSync(TRACE, 'utf8').trim().split('\n').slice(-limit).join('\n'); } catch { return '(sin traza)'; }
      },
    },
    {
      name: 'browser_tabs',
      description: 'Gestiona pestañas: list, new (con url), select (index), close (index).',
      schema: { action: z.enum(['list', 'new', 'select', 'close']), index: z.number().optional(), url: z.string().optional() },
      async run({ action, index, url }) {
        await ab.start();
        let pages = ab.context.pages();
        if (action === 'new') { const p = await ab.context.newPage(); ab.page = p; if (url) await p.goto(url, { waitUntil: 'domcontentloaded' }); }
        if (action === 'select') { ab.page = pages[index]; await ab.page.bringToFront(); }
        if (action === 'close') { await (pages[index ?? pages.indexOf(ab.page)]).close(); }
        pages = ab.context.pages();
        const rows = await Promise.all(pages.map(async (p, i) => `${p === ab.page ? '*' : ' '}${i} ${await p.title().catch(() => '')} — ${p.url()}`));
        return rows.join('\n');
      },
    },
    {
      name: 'browser_console',
      description: 'Últimos mensajes de consola y errores JS de la pestaña activa.',
      schema: { limit: z.number().optional() },
      async run({ limit = 30 }) {
        const page = await ab.active();
        return (ab.consoleLog.get(page) || []).slice(-limit).map(m => `[${m.type}] ${m.text}`).join('\n') || '(vacío)';
      },
    },
    {
      name: 'browser_events',
      description: 'Diálogos aceptados, descargas guardadas y popups abiertos desde la última consulta.',
      schema: {},
      async run() { return JSON.stringify(ab.drainEvents()); },
    },
    {
      name: 'browser_cursor_style',
      description: 'Muestra/oculta el cursor visual o su estela.',
      schema: { visible: z.boolean().optional(), trail: z.boolean().optional() },
      async run({ visible, trail }) {
        const page = await ab.active();
        await page.evaluate(([v, t]) => { const c = window.__agentCursor; if (!c) return; if (v === true) c.show(); if (v === false) c.hide(); if (t !== undefined && t !== null) c.trail(t); }, [visible, trail]);
        return 'ok';
      },
    },
    {
      name: 'browser_screenshot',
      description: 'ÚLTIMO RECURSO (gasta tokens): imagen JPEG de la página o de un ref, para contenido puramente visual (canvas, gráficos, captchas no).',
      schema: { ref, fullPage: z.boolean().optional(), quality: z.number().optional() },
      async run({ ref: r, fullPage, quality = 55 }) {
        const page = await ab.active();
        const o = { type: 'jpeg', quality, fullPage: !!fullPage, scale: 'css' };
        if (r !== undefined) { const t = await ab.resolve({ ref: r }); const { x, y, width, height } = t.rect; o.clip = { x, y, width, height }; }
        const buf = await page.screenshot(o);
        return { image: buf.toString('base64'), mimeType: 'image/jpeg' };
      },
    },
  ];

  // Envoltorio común: modo solo-lectura, detector de bucles y traza de auditoría
  let lastSig = '', repeats = 0;
  const shorten = v => (typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v);
  const wrapped = tools.map(t => ({
    ...t,
    async run(args = {}) {
      if (READONLY && MUTATING.has(t.name)) throw new Error('AGENT_READONLY=1: esta herramienta está desactivada');
      const sig = t.name + JSON.stringify(args);
      repeats = sig === lastSig ? repeats + 1 : 1;
      lastSig = sig;
      const t0 = Date.now();
      let ok = true, out;
      try {
        out = await t.run(args);
        if (repeats >= 3 && typeof out === 'string') out += `\n⚠ Has repetido esta misma acción ${repeats} veces. Si la página no cambia, prueba otra estrategia o usa browser_request_human.`;
        return out;
      } catch (e) { ok = false; out = e.message; throw e; }
      finally {
        const rec = { at: new Date().toISOString(), tool: t.name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, shorten(v)])),
          ms: Date.now() - t0, url: ab.page && !ab.page.isClosed() ? ab.page.url() : null, ok,
          result: typeof out === 'string' ? out.slice(0, 200) : out?.image ? '[imagen]' : null };
        try { fs.mkdirSync(path.dirname(TRACE), { recursive: true }); fs.appendFileSync(TRACE, JSON.stringify(rec) + '\n'); } catch {}
      }
    },
  }));
  const only = process.env.AGENT_TOOLS;
  if (!only || only === 'all') return wrapped;
  const names = only === 'core' ? CORE : only.split(',').map(s => s.trim());
  return wrapped.filter(t => names.includes(t.name));
}
