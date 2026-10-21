// Registro único de herramientas. Lo consumen el servidor MCP (stdio) y la API
// HTTP, de modo que cualquier agente —con o sin MCP— tiene exactamente las mismas
// capacidades.
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatSnapshot, diffSnapshot } from './perception.js';
import { Recorder } from './recorder.js';
import { Teacher } from './teach.js';

const TRACE = process.env.AGENT_TRACE || path.join(os.homedir(), '.agentic-browser', 'trace.jsonl');
const EXPORTS = process.env.AGENT_EXPORTS || path.join(os.homedir(), '.agentic-browser', 'exports');
const READONLY = process.env.AGENT_READONLY === '1';
// Acciones de entrada: solo los popups que abran ellas pasan a ser la pestaña activa
const INPUT = new Set(['browser_click', 'browser_type', 'browser_press', 'browser_drag', 'browser_select', 'browser_upload', 'browser_replay']);
const MUTATING = new Set(['browser_click', 'browser_type', 'browser_press', 'browser_drag', 'browser_select', 'browser_upload', 'browser_eval', 'browser_replay']);
const CORE = ['browser_navigate', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_type', 'browser_press',
  'browser_scroll', 'browser_read', 'browser_extract', 'browser_element_at', 'browser_watch', 'browser_request_human', 'browser_tabs'];
// Herramientas que "miran" la página: un agente basado en capturas haría una captura en cada una
const PERCEIVE = new Set(['browser_snapshot', 'browser_find', 'browser_read', 'browser_extract', 'browser_element_at', 'browser_cursor']);
const estTokens = s => Math.ceil(String(s).length / 4);
const AUTO_DISMISS = process.env.AGENT_AUTO_DISMISS !== '0';

// CSV seguro para Excel: comillas escapadas y sin fórmulas inyectadas desde la web
function toCsv(cols, rows) {
  const cell = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(cell).join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
}

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
  const recorder = new Recorder(ab);
  const teacher = new Teacher(ab);
  // Contador de tokens: lo que devolvemos frente a lo que costaría una captura por cada percepción.
  // Captura = ancho × alto / 750 tokens (la fórmula de imágenes de Claude): 1280×800 ≈ 1.365.
  const meter = { calls: 0, used: 0, shots: 0, perceptions: 0 };
  let replaySteps = 0;
  let wrappedRef = []; // herramientas envueltas, para browser_batch
  let dismissArm = null; // tras navegar, una revisión más de popups antes de la siguiente percepción

  async function settle(page, before) {
    await sleep(ab.speed.settle);
    // Una pestaña nueva que aún se está clasificando: esperar su evento para informarlo ya
    for (let i = 0; i < 20 && ab.pagesPending > 0; i++) await sleep(50);
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

  // Cierra popups que tapan la página con clics visibles. Solo botones de cerrar o rechazar.
  async function dismissPopups(page) {
    const closed = [];
    for (let round = 0; round < 3; round++) {
      const cands = [];
      for (const fr of await ab.frames(page)) {
        await ab.ensure(fr.frame);
        // Un iframe flotante (posición fija) es un popup entero, p. ej. "Inicia sesión con Google"
        const whole = fr.id ? await fr.frame.frameElement().then(h => h.evaluate(e => {
          for (let n = e; n && n.nodeType === 1; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return true;
          return false;
        })).catch(() => false) : false;
        const r = await fr.frame.evaluate(o => window.__agentPerc.dismissables(o), { ox: fr.ox, oy: fr.oy, whole }).catch(() => []);
        cands.push(...r);
      }
      if (!cands.length) break;
      const c = cands[0];
      await ab.annotate(page, `cerrar popup “${c.name}”`, null);
      await ab.moveTo(page, c.x, c.y);
      await ab.ripple(page, c.x, c.y);
      await page.mouse.click(c.x, c.y, { delay: 30 });
      closed.push(`“${c.name}”${c.box ? ` en «${c.box.slice(0, 40)}»` : ''}`);
      await sleep(ab.speed.settle * 3);
    }
    return closed;
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
        let msg = `ok: "${await page.title()}"`;
        if (AUTO_DISMISS) {
          await sleep(ab.speed.settle * 5);
          const c = await dismissPopups(page);
          if (c.length) msg += `\n🧹 cerré popups: ${c.join('; ')}`;
          // Segunda oportunidad para los que tardan en salir (cookies): en la próxima percepción
          dismissArm = { page, url: page.url(), until: Date.now() + 10000 };
        }
        return after(page, page.url(), msg, snapshot);
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
        ab.markAction();
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
        delay: z.number().optional().describe('ms entre teclas (15; 0 con AGENT_SPEED=fast)'),
        snapshot: snap,
      },
      async run({ text, clear, submit, delay, snapshot, ...t }) {
        const page = await ab.active(); const u = page.url();
        let where = 'elemento enfocado';
        if (t.ref !== undefined || (t.x !== undefined && t.y !== undefined)) {
          const r = await pointerAt(t, 'escribir en');
          await ab.ripple(page, r.x, r.y);
          ab.markAction();
          await page.mouse.click(r.x, r.y, { delay: 30 });
          where = brief(r.target);
        }
        if (clear) { await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A'); await page.keyboard.press('Backspace'); }
        ab.markAction();
        // Quien mira debe ver lo que se escribe: el campo enfocado entra en pantalla antes y después
        const follow = () => page.evaluate(() => { const a = document.activeElement;
          if (a && a !== document.body && a.tagName !== 'IFRAME') a.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }).catch(() => {});
        await follow();
        await page.keyboard.type(text, { delay: delay ?? ab.speed.typeDelay });
        await follow();
        if (submit) { ab.markAction(); await page.keyboard.press('Enter'); }
        return after(page, u, `ok escrito ${text.length} chars en ${where}${submit ? ' + Enter' : ''}`, snapshot);
      },
    },
    {
      name: 'browser_press',
      description: 'Pulsa teclas o combinaciones: "Enter", "Escape", "Control+L", "Tab", "ArrowDown"... Varias separadas por espacio.',
      schema: { keys: z.string(), snapshot: snap },
      async run({ keys, snapshot }) {
        const page = await ab.active(); const u = page.url();
        for (const k of keys.split(/\s+/).filter(Boolean)) { ab.markAction(); await page.keyboard.press(k); }
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
        const vp = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const px = t.x ?? ab.cursor.get(page)?.x ?? vp.width / 2, py = t.y ?? ab.cursor.get(page)?.y ?? vp.height / 2;
        await ab.moveTo(page, px, py);
        await page.mouse.wheel(dx, dy);
        await sleep(ab.speed.scrollWait);
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
        ab.markAction();
        await a.page.mouse.down();
        const b = await ab.resolve(to);
        await ab.moveTo(a.page, b.x, b.y);
        ab.markAction();
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
        ab.markAction();
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
      name: 'browser_extract',
      description: 'Datos estructurados en UNA llamada: convierte la tabla o la lista repetida más relevante (productos, resultados, contactos) en filas JSON o CSV, con título, enlace, precio e imagen. Limítalo con ref o selector. Con file lo guarda en disco y solo devuelve un resumen.',
      schema: {
        ref, selector: z.string().optional().describe('Contenedor CSS donde buscar'),
        kind: z.enum(['auto', 'table', 'list']).optional().describe('auto (por defecto) elige la tabla o lista con más contenido'),
        format: z.enum(['json', 'csv']).optional(),
        max: z.number().optional().describe('Máximo de filas (100)'),
        file: z.string().optional().describe('Guardar en este archivo (relativo a ~/.agentic-browser/exports)'),
      },
      async run({ ref: r, selector, kind = 'auto', format = 'json', max = 100, file }) {
        const page = await ab.active();
        let frame = page.mainFrame(), id;
        if (r !== undefined && r !== '') {
          const p = ab.parseRef(r);
          const fr = (await ab.frames(page)).find(f => f.id === p.fid);
          if (!fr) throw new Error(`frame f${p.fid} ya no existe; vuelve a llamar a snapshot`);
          frame = fr.frame; id = p.id;
        }
        await ab.ensure(frame);
        const d = await frame.evaluate(o => window.__agentPerc.extract(o), { ref: id, selector, kind, max });
        if (d.error) throw new Error(d.error);
        const body = format === 'csv' ? toCsv(d.columns, d.rows) : '[\n' + d.rows.map(x => JSON.stringify(x)).join(',\n') + '\n]';
        const head = `${d.kind === 'table' ? 'tabla' : 'lista'}: ${d.rows.length} filas${d.total > d.rows.length ? ` de ${d.total}` : ''} · columnas: ${d.columns.join(', ')}`;
        if (file) {
          const out = path.resolve(EXPORTS, file);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, body);
          return `${head}\nguardado en ${out}`;
        }
        // Delimitado: el contenido de la web son datos de terceros, no instrucciones
        return `${head}\n<page_data url="${page.url()}" trust="untrusted">\n${body}\n</page_data>`;
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
        if (action === 'new') { const p = await ab.newTab(); if (url) await p.goto(url, { waitUntil: 'domcontentloaded' }); }
        if (action === 'select') { if (!pages[index]) throw new Error(`no existe la pestaña ${index}`); ab.setActive(pages[index]); await ab.page.bringToFront(); }
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
      description: 'Muestra/oculta el cursor visual, su estela o el contador de tokens en vivo (hud) en la esquina de la página.',
      schema: {
        visible: z.boolean().optional(), trail: z.boolean().optional(),
        hud: z.boolean().optional().describe('Contador de tokens frente a capturas, visible para quien mira'),
        teachButton: z.boolean().optional().describe('Botón flotante "Enseñar una tarea" en el borde izquierdo'),
      },
      async run({ visible, trail, hud, teachButton }) {
        const page = await ab.active();
        await page.evaluate(([v, t, b]) => { const c = window.__agentCursor; if (!c) return; if (v === true) c.show(); if (v === false) c.hide();
          if (t !== undefined && t !== null) c.trail(t); if (b !== undefined && b !== null) c.teachButton(b); }, [visible, trail, teachButton]);
        if (hud !== undefined) { ab.hud.on = hud; await ab.showHud(page); }
        return 'ok';
      },
    },
    {
      name: 'browser_dismiss',
      description: 'Cierra popups que tapan la página (idioma, newsletter, cookies, "inicia sesión con Google"), con clics visibles. Solo pulsa botones de cerrar o rechazar, nunca aceptar, suscribirse ni iniciar sesión. Ya se hace solo tras browser_navigate (AGENT_AUTO_DISMISS=0 lo apaga).',
      schema: {},
      async run() {
        const page = await ab.active();
        const c = await dismissPopups(page);
        return c.length ? `cerré ${c.length} popup(s): ${c.join('; ')}` : 'no encontré popups que cerrar';
      },
    },
    {
      name: 'browser_stats',
      description: 'Tokens que ha devuelto agentic-browser en esta sesión frente a lo que habrían costado las capturas de pantalla (una por cada percepción, ancho×alto/750).',
      schema: { reset: z.boolean().optional() },
      async run({ reset }) {
        const s = stats();
        if (reset) { Object.assign(meter, { calls: 0, used: 0, shots: 0, perceptions: 0 }); ab.hud.stats = null; }
        return JSON.stringify({ ...s, method: 'tokens ≈ caracteres/4; captura ≈ ancho×alto/750 por cada percepción (snapshot, find, read, extract, element_at, cursor, snapshot:true y cada paso de una receta)' });
      },
    },
    {
      name: 'browser_teach_start',
      description: 'MODO ENSEÑAR. Empieza a grabar una receta: la persona hace la tarea una vez en el Chrome del agente (clics, textos, selecciones, Enter) y pulsa "Terminar" en el banner. Se guarda por rol y nombre de cada elemento, no por píxeles. Las contraseñas nunca se graban. Después llama a browser_teach_stop.',
      schema: { name: z.string().describe('Nombre corto de la receta, ej. "buscar-factura"'), url: z.string().optional().describe('Página donde empieza la tarea') },
      async run({ name, url }) {
        const page = await ab.active();
        if (url) await tools.find(t => t.name === 'browser_navigate').run({ url });
        await page.bringToFront().catch(() => {});
        await teacher.start(name, await ab.active());
        return `grabando la receta "${name}" en ${page.url()}. Pide a la persona que haga la tarea en el navegador y pulse "Terminar" en el banner; luego llama a browser_teach_stop (espera a que termine).`;
      },
    },
    {
      name: 'browser_teach_stop',
      description: 'Termina la grabación de browser_teach_start. Por defecto espera a que la persona pulse "Terminar" (o "Cancelar"). Guarda la receta y devuelve sus pasos y parámetros.',
      schema: { wait: z.boolean().optional().describe('Esperar al botón Terminar (true); false corta ya'), timeout: z.number().optional().describe('ms (600000)') },
      async run({ wait, timeout }) {
        const r = await teacher.stop({ wait, timeout });
        if (r.cancelled) return 'la persona canceló: no se guardó nada';
        if (r.empty) return `no se grabó ningún paso${r.how === 'timeout' ? ' (se agotó el tiempo)' : ''}`;
        return `${teacher.summary(r.recipe)}\nguardada en ${r.file}${r.how === 'timeout' ? ' (se agotó el tiempo; se guardó lo grabado)' : ''}\nRepítela con browser_replay {name: "${r.recipe.name}", params: {...}}`;
      },
    },
    {
      name: 'browser_recipes',
      description: 'Lista las recetas grabadas o, con name, muestra sus pasos y parámetros.',
      schema: { name: z.string().optional() },
      async run({ name }) {
        if (name) return teacher.summary(teacher.load(name));
        const all = teacher.list();
        return all.length ? all.map(r => `${r.name} — ${r.steps.length} pasos, params: ${Object.keys(r.params).join(', ') || 'ninguno'} · ${r.startUrl}`).join('\n') : '(sin recetas; graba una con browser_teach_start)';
      },
    },
    {
      name: 'browser_replay',
      description: 'Repite una receta grabada. Localiza cada elemento por rol y nombre y ejecuta los pasos sin percibir la página: casi no gasta tokens. params cambia los textos escritos, ej. {"buscar": "facturas octubre"}. Los campos secretos (contraseñas) siempre los escribe la persona.',
      schema: { name: z.string(), params: z.record(z.string(), z.string()).optional(), snapshot: snap },
      async run({ name, params = {}, snapshot }) {
        const recipe = teacher.load(name);
        const run = n => args => tools.find(t => t.name === n).run(args);
        const unknown = Object.keys(params).filter(k => !(k in recipe.params));
        const values = { ...recipe.params, ...params };
        const log = [];
        replaySteps = 0;
        let page = await ab.active();
        if (/^(https?|file):/.test(recipe.startUrl) && page.url() !== recipe.startUrl) await run('browser_navigate')({ url: recipe.startUrl });
        for (const [i, st] of recipe.steps.entries()) {
          const tag = `${i + 1}/${recipe.steps.length}`;
          try {
            page = await ab.active();
            if (st.action === 'goto') await run('browser_navigate')({ url: st.url });
            else if (st.action === 'press') await run('browser_press')({ keys: st.key });
            else {
              const ref = await teacher.locate(page, st.target);
              if (!ref) throw new Error(`no encuentro ${st.target.role} "${st.target.name}" en ${page.url()}`);
              if (st.action === 'click') await run('browser_click')({ ref });
              else if (st.action === 'select') await run('browser_select')({ ref, values: st.value });
              else if (st.secret) {
                await run('browser_click')({ ref });
                const h = await ab.requestHuman(`Escribe ${st.target.name || 'el dato secreto'} en el campo marcado y pulsa “Listo”`);
                if (h !== 'done') throw new Error(`la persona no completó el campo (${h})`);
              } else await run('browser_type')({ ref, text: String(values[st.param] ?? ''), clear: true });
            }
            replaySteps++;
            log.push(`✓ ${tag} ${teacher.describe(st, values)}`);
          } catch (e) {
            log.push(`✗ ${tag} ${teacher.describe(st, values)} — ${e.message}`, 'Se detuvo aquí. Mira la página con browser_snapshot y sigue a mano, o vuelve a grabar la receta.');
            break;
          }
        }
        page = await ab.active();
        if (unknown.length) log.push(`⚠ params desconocidos ignorados: ${unknown.join(', ')} (la receta usa: ${Object.keys(recipe.params).join(', ') || 'ninguno'})`);
        log.unshift(`receta "${recipe.name}": ${replaySteps}/${recipe.steps.length} pasos`);
        return after(page, page.url(), log.join('\n') + `\n→ "${await page.title()}" ${page.url()}`, snapshot);
      },
    },
    {
      name: 'browser_record_start',
      description: 'Empieza a grabar en vídeo la pestaña activa (con el cursor rojo visible) para clips de demostración. Sigue usando las demás herramientas y termina con browser_record_stop. Las pausas sin cambios conservan su duración real. MP4 (H.264) si hay ffmpeg en el PATH; si no, WebM.',
      schema: {
        fps: z.number().optional().describe('Fotogramas por segundo del vídeo final (25)'),
        maxSeconds: z.number().optional().describe('Se detiene sola tras estos segundos (120, máx. 600)'),
        file: z.string().optional().describe('Nombre o ruta del archivo; relativo a ~/.agentic-browser/recordings'),
        format: z.enum(['mp4', 'webm']).optional().describe('mp4 requiere ffmpeg; webm no tiene dependencias pero tarda lo que dura el clip al parar'),
        demo: z.boolean().optional().describe('Ralentiza el cursor mientras se graba para que se lea mejor'),
      },
      async run(a) {
        const page = await ab.active();
        const r = await recorder.start(page, a);
        return `grabando → ${r.out} (${r.format}, ${r.fps} fps${a.demo ? ', cursor lento' : ''})${r.notes.length ? '\n' + r.notes.join('\n') : ''}`;
      },
    },
    {
      name: 'browser_record_stop',
      description: 'Detiene la grabación de browser_record_start y codifica el vídeo. Devuelve ruta, duración (s), tamaño y formato.',
      schema: {},
      async run() { return JSON.stringify(await recorder.stop()); },
    },
    {
      name: 'browser_batch',
      description: 'Varias acciones en UNA llamada (ahorra un turno del agente por acción): [{tool:"browser_click", args:{ref:12}}, {tool:"browser_type", args:{ref:14, text:"hola", submit:true}}]. Se ejecutan en orden y se detiene en el primer error. Úsala cuando ya sabes los pasos siguientes; con snapshot:true devuelve el estado final.',
      schema: {
        actions: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional() })).min(1).max(30),
        snapshot: snap,
      },
      async run({ actions, snapshot }) {
        const lines = [];
        let done = 0;
        for (const [i, a] of actions.entries()) {
          const name = a.tool.startsWith('browser_') ? a.tool : 'browser_' + a.tool;
          const t = wrappedRef.find(w => w.name === name);
          if (!t || /^browser_(batch|teach_|request_human|record_|screenshot)/.test(name)) {
            lines.push(`✗ ${i + 1} ${name}: no se puede usar dentro de browser_batch`); break;
          }
          try {
            const out = String(await t.run(a.args || {}));
            done++;
            lines.push(`✓ ${i + 1} ${name}: ${out.split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
          } catch (e) { lines.push(`✗ ${i + 1} ${name}: ${e.message}`, 'Se detuvo aquí.'); break; }
        }
        lines.unshift(`batch: ${done}/${actions.length} acciones`);
        if (snapshot) { const [, s] = await ab.snapshotWithPrev(); lines.push('', formatSnapshot(s)); }
        return lines.join('\n');
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

  function shotTokens() {
    const vp = (ab.page && !ab.page.isClosed() && ab.page.viewportSize()) || ab.lastViewport || { width: 1280, height: 800 };
    return Math.round((vp.width * vp.height) / 750);
  }
  function stats() {
    return { calls: meter.calls, tokensUsed: meter.used, screenshotEquivalent: meter.shots,
      ratio: meter.used ? +(meter.shots / meter.used).toFixed(2) : 0, perceptions: meter.perceptions, tokensPerScreenshot: shotTokens() };
  }
  function count(name, args, out) {
    if (name === 'browser_stats' || name === 'browser_batch') return; // las acciones del lote ya cuentan una a una
    const shot = shotTokens();
    const used = out?.image ? shot : typeof out === 'string' ? estTokens(out) : 0;
    let perceptions = PERCEIVE.has(name) || args.snapshot ? 1 : 0;
    if (name === 'browser_replay') perceptions += replaySteps;
    meter.calls++;
    meter.used += used;
    meter.perceptions += perceptions;
    // Con capturas: la misma respuesta de acción (sin el snapshot) + una imagen por cada percepción
    meter.shots += out?.image ? shot : perceptions ? perceptions * shot + (args.snapshot ? 20 : 0) : used;
  }

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
      let ok = true, out, pre = '';
      try {
        // Popups que salen tarde tras navegar: se cierran antes de la siguiente percepción,
        // nunca después de que el agente haya interactuado (podría ser una ventana que él abrió)
        if (INPUT.has(t.name) || t.name === 'browser_navigate') dismissArm = null;
        else if (dismissArm && PERCEIVE.has(t.name)) {
          const a = dismissArm; dismissArm = null;
          if (a.page === ab.page && !a.page.isClosed() && a.page.url() === a.url && Date.now() < a.until) {
            const c = await dismissPopups(a.page);
            if (c.length) pre = `🧹 cerré popups: ${c.join('; ')}\n`;
          }
        }
        out = await t.run(args);
        if (pre && typeof out === 'string') out = pre + out;
        if (repeats >= 3 && typeof out === 'string') out += `\n⚠ Has repetido esta misma acción ${repeats} veces. Si la página no cambia, prueba otra estrategia o usa browser_request_human.`;
        return out;
      } catch (e) { ok = false; out = e.message; throw e; }
      finally {
        if (INPUT.has(t.name)) ab.markAction();
        count(t.name, args, out);
        if (ab.hud.on && ab.page && !ab.page.isClosed()) {
          const s = stats();
          ab.hud.stats = { ratio: s.ratio, used: s.tokensUsed, shots: s.screenshotEquivalent, calls: s.calls };
          await ab.showHud(ab.page);
        }
        const rec = { at: new Date().toISOString(), tool: t.name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, shorten(v)])),
          ms: Date.now() - t0, url: ab.page && !ab.page.isClosed() ? ab.page.url() : null, ok,
          result: typeof out === 'string' ? out.slice(0, 200) : out?.image ? '[imagen]' : null };
        try { fs.mkdirSync(path.dirname(TRACE), { recursive: true }); fs.appendFileSync(TRACE, JSON.stringify(rec) + '\n'); } catch {}
      }
    },
  }));
  wrappedRef = wrapped;
  const only = process.env.AGENT_TOOLS;
  if (!only || only === 'all') return wrapped;
  const names = only === 'core' ? CORE : only.split(',').map(s => s.trim());
  return wrapped.filter(t => names.includes(t.name));
}
