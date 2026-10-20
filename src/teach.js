// Modo enseñar: la persona hace una tarea una vez en el Chrome del agente y queda
// guardada como receta (rol + nombre de cada elemento, no píxeles). browser_replay la
// repite sin percibir la página en cada paso, así que casi no gasta tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.AGENT_RECIPES || path.join(os.homedir(), '.agentic-browser', 'recipes');
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const label = t => `${t.role}${t.name ? ` "${t.name}"` : ''}`;

export class Teacher {
  constructor(ab) {
    this.ab = ab;
    this.session = null;
    // El navegador expone __agentTeachEmit en todas las páginas y nos pasa sus eventos
    ab.onTeach = (page, e) => this.onEvent(page, e);
  }

  file(name) {
    const n = slug(name);
    if (!n) throw new Error('nombre de receta inválido');
    return path.join(DIR, n + '.json');
  }

  // user: la persona empezó con el botón flotante; al pulsar Terminar se guarda sola
  async start(name, page, { user = false } = {}) {
    if (this.session) throw new Error(`ya se está grabando "${this.session.label}"; termina con browser_teach_stop`);
    this.file(name);
    let finish;
    const done = new Promise(r => (finish = r));
    const s = { name: slug(name), label: name, page, user, startUrl: page.url(), events: [], lastAt: Date.now(), lastUrl: page.url(), done, finish };
    // Navegación sin un clic o Enter reciente: la persona escribió una URL
    s.onNav = f => {
      if (f !== page.mainFrame()) return;
      const u = f.url();
      if (u === s.lastUrl) return;
      if (Date.now() - s.lastAt > 3000) s.events.push({ action: 'goto', url: u });
      s.lastUrl = u;
    };
    s.onLoad = () => this.bar(page, name);
    page.on('framenavigated', s.onNav);
    page.on('load', s.onLoad);
    this.session = s;
    await this.bar(page, name);
    return s;
  }

  onEvent(page, e) {
    if (!e) return;
    if (e.ctrl === 'start') {
      if (this.session) return;
      const d = new Date(), p = n => String(n).padStart(2, '0');
      const name = `tarea-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
      this.start(name, page, { user: true }).catch(() => {});
      return;
    }
    const s = this.session;
    if (!s) return;
    if (e.ctrl) {
      if (e.name && slug(e.name)) { s.label = String(e.name).slice(0, 60); s.name = slug(e.name); }
      s.finish(e.ctrl);
      if (s.user) this.finishUser(e.ctrl);
      return;
    }
    s.lastAt = Date.now();
    s.events.push(e);
  }

  // Grabación empezada con el botón: nadie llama a browser_teach_stop, así que se cierra aquí
  async finishUser(ctrl) {
    const s = this.session;
    const r = await this.stop({ how: ctrl }).catch(e => ({ error: e.message }));
    const msg = r.recipe ? `✓ Receta “${r.recipe.label}” guardada (${r.recipe.steps.length} pasos). Pídele a tu agente: “repite ${r.recipe.label}”.`
      : r.cancelled ? 'Grabación cancelada: no se guardó nada.' : 'No se grabó ningún paso.';
    await s.page.evaluate(t => window.__agentCursor?.toast(t), msg).catch(() => {});
    if (r.recipe) this.ab.events.push({ type: 'recipe-saved', name: r.recipe.name, steps: r.recipe.steps.length, params: Object.keys(r.recipe.params), note: 'la persona grabó esta receta con el botón Enseñar; repítela con browser_replay' });
  }

  async bar(page, text) {
    await this.ab.ensure(page.mainFrame());
    await page.evaluate(t => window.__agentCursor?.teach(t), text || null).catch(() => {});
  }

  async stop({ wait = true, timeout = 600000, how: forced } = {}) {
    const s = this.session;
    if (!s) throw new Error('no hay ninguna grabación en curso; empieza con browser_teach_start');
    let how = forced || 'stopped';
    if (!forced && wait) how = await Promise.race([s.done, sleep(timeout).then(() => 'timeout')]);
    s.page.off('framenavigated', s.onNav);
    s.page.off('load', s.onLoad);
    this.session = null;
    await this.bar(s.page, null);
    if (how === 'cancel') return { cancelled: true };
    const recipe = this.build(s);
    if (!recipe.steps.length) return { empty: true, how };
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(this.file(s.name), JSON.stringify(recipe, null, 2));
    return { recipe, file: this.file(s.name), how };
  }

  build(s) {
    const steps = [];
    for (const e of s.events) {
      const st = { action: e.action };
      if (e.target) st.target = e.target;
      if (e.action === 'type') {
        // Enter dispara type y luego change con el mismo valor; varias pulsaciones del mismo campo = la última
        if (steps.slice(-3).some(p => p.action === 'type' && same(p.target, e.target) && (e.secret ? p.secret : p.value === e.value))) continue;
        const prev = steps.at(-1);
        if (prev && prev.action === 'type' && same(prev.target, e.target)) steps.pop();
        if (e.secret) st.secret = true;
        else if (!e.value) continue;
        else st.value = e.value;
      }
      if (e.action === 'select') st.value = e.value;
      if (e.action === 'press') st.key = e.key;
      if (e.action === 'goto') st.url = e.url;
      steps.push(st);
    }
    // Cada texto escrito pasa a ser un parámetro con su valor grabado por defecto
    const params = {};
    for (const st of steps) {
      if (st.action !== 'type' || st.secret) continue;
      const base = slug(st.target.name || st.target.placeholder || st.target.field) || 'campo';
      let k = base, i = 2;
      while (k in params) k = `${base}_${i++}`;
      params[k] = st.value;
      st.param = k;
      delete st.value;
    }
    return { name: s.name, label: s.label, version: 1, createdAt: new Date().toISOString(), startUrl: s.startUrl, params, steps };
  }

  load(name) {
    const f = this.file(name);
    if (!fs.existsSync(f)) throw new Error(`no existe la receta "${name}". Mira las disponibles con browser_recipes`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  list() {
    let files = [];
    try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.json')); } catch {}
    return files.map(f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean);
  }

  describe(st, params = {}) {
    if (st.action === 'goto') return `ir a ${st.url}`;
    if (st.action === 'press') return `tecla ${st.key}`;
    if (st.action === 'click') return `clic en ${label(st.target)}`;
    if (st.action === 'select') return `elegir ${JSON.stringify(st.value)} en ${label(st.target)}`;
    if (st.secret) return `dato secreto en ${label(st.target)} (lo escribe la persona)`;
    const v = params[st.param];
    return `escribir {{${st.param}}}${v !== undefined ? `="${v}"` : ''} en ${label(st.target)}`;
  }

  summary(r) {
    const lines = [`receta "${r.name}" — ${r.steps.length} pasos, empieza en ${r.startUrl}`];
    if (Object.keys(r.params).length) lines.push(`params (valor grabado): ${JSON.stringify(r.params)}`);
    r.steps.forEach((st, i) => lines.push(`${i + 1}. ${this.describe(st)}`));
    return lines.join('\n');
  }

  // Ref del elemento de un paso, buscando en todos los frames; reintenta mientras carga la página
  async locate(page, target, timeout = 8000) {
    const end = Date.now() + timeout;
    for (;;) {
      let best = null;
      for (const fr of await this.ab.frames(page)) {
        await this.ab.ensure(fr.frame);
        const r = await fr.frame.evaluate(d => window.__agentPerc.locate(d), target).catch(() => null);
        if (r && (!best || r.score > best.score)) best = { score: r.score, ref: fr.id ? `f${fr.id}:${r.ref}` : r.ref };
      }
      if (best) return best.ref;
      if (Date.now() > end) return null;
      await sleep(300);
    }
  }
}
