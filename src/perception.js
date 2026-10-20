// Percepción sin capturas: estas funciones se ejecutan DENTRO de la página
// (frame.evaluate) y devuelven texto/JSON compacto con coordenadas en píxeles.
// Cada elemento recibe un "ref" estable mientras el documento viva.

// Inyectado una vez por documento junto al overlay.
export const perceptionScript = String.raw`
(() => {
  if (window.__agentPerc) return;
  const refs = new Map();          // id -> Element
  const ids = new WeakMap();       // Element -> id
  const meta = new Map();          // id -> {role,name}: para re-localizar refs obsoletos
  let next = 1;
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,details,label[for],[role=button],[role=link],' +
    '[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],' +
    '[role=textbox],[role=searchbox],[role=slider],[contenteditable=""],[contenteditable=true],[onclick],[onmousedown],[onmouseover],[onmouseenter],[tabindex]:not([tabindex="-1"])';
  const LANDMARK = 'h1,h2,h3,h4,h5,h6,img[alt],[role=heading],[role=alert],[role=dialog],[aria-live]';

  function refOf(el) {
    let id = ids.get(el);
    if (!id) { id = next++; ids.set(el, id); refs.set(id, el); }
    return id;
  }

  // querySelectorAll que también entra en shadow roots abiertos (web components)
  function deepAll(sel, root = document, out = []) {
    out.push(...root.querySelectorAll(sel));
    for (const h of root.querySelectorAll('*')) if (h.shadowRoot) deepAll(sel, h.shadowRoot, out);
    return out;
  }

  // Elemento visible en un punto atravesando shadow roots
  function deepHit(x, y) {
    let h = document.elementFromPoint(x, y);
    while (h && h.shadowRoot) { const inner = h.shadowRoot.elementFromPoint(x, y); if (!inner || inner === h) break; h = inner; }
    return h;
  }

  // ¿Algo (un modal, un banner) tapa el centro del elemento?
  function occluded(el, r) {
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return false;
    const hit = deepHit(cx, cy);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return false;
    const root = el.getRootNode();
    return !(root !== document && root.host && (root.host === hit || root.host.contains(hit)));
  }

  function visible(el, r) {
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
  }

  function clean(t, n) { t = (t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

  function name(el) {
    const a = el.getAttribute('aria-label');
    if (a) return a;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map(i => document.getElementById(i)?.innerText || '').join(' '); if (t.trim()) return t; }
    if (el.labels && el.labels[0]) return el.labels[0].innerText;
    if (el.tagName === 'IMG') return el.alt;
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(el.type)) return el.value;
    if (el.tagName === 'SELECT') return el.getAttribute('title') || el.getAttribute('name') || el.id || '';
    const t = el.innerText || el.textContent;
    if (t && t.trim()) return t;
    return el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  }

  function role(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'input') { const ty = (el.type || 'text').toLowerCase(); return ty === 'text' ? 'textbox' : ty; }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'select';
    if (/^h[1-6]$/.test(t)) return 'heading' + t[1];
    if (t === 'img') return 'img';
    if (el.isContentEditable) return 'editable';
    return t;
  }

  function state(el) {
    const out = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    if (el.checked || el.getAttribute('aria-checked') === 'true') out.push('checked');
    if (el.getAttribute('aria-expanded')) out.push('expanded=' + el.getAttribute('aria-expanded'));
    if (el.getAttribute('aria-selected') === 'true') out.push('selected');
    if (document.activeElement === el) out.push('focused');
    if (el.required) out.push('required');
    return out;
  }

  function describe(el, r, ox, oy) {
    const d = { ref: refOf(el), role: role(el), name: clean(name(el), 80),
      x: Math.round(ox + r.x + r.width / 2), y: Math.round(oy + r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height) };
    meta.set(d.ref, { role: d.role, name: d.name });
    if ('value' in el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(password|checkbox|radio)$/.test(el.type)) d.value = clean(String(el.value), 60);
    if (el.tagName === 'INPUT' && el.type === 'password') d.value = el.value ? '••••' : '';
    if (el.placeholder) d.placeholder = clean(el.placeholder, 40);
    if (el.tagName === 'A' && el.href) d.href = clean(el.getAttribute('href'), 80);
    if (el.tagName === 'SELECT') d.options = [...el.options].slice(0, 15).map(o => (o.selected ? '*' : '') + clean(o.text, 30));
    const st = state(el);
    if (occluded(el, r)) st.push('occluded');
    if (st.length) d.state = st;
    return d;
  }

  function inView(r) { return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; }

  // ---- Extracción estructurada (browser_extract) ----
  const absUrl = u => { try { return new URL(u, location.href).href; } catch { return u; } };
  const uniq = cols => { const seen = {}; return cols.map(c => (seen[c] = (seen[c] || 0) + 1) > 1 ? c + '_' + seen[c] : c); };
  const PRICE = /(?:[$€£¥₹]|USD|EUR|MXN|COP|ARS|CLP)\s?\d[\d.,]*|\d[\d.,]*\s?(?:[€£]|USD|EUR|MXN|COP|ARS|CLP)/i;

  // Rejilla real de la tabla: expande rowspan/colspan para que cada celda caiga en su columna
  function grid(rows) {
    const g = [];
    rows.forEach((r, ri) => {
      g[ri] = g[ri] || [];
      let ci = 0;
      for (const c of r.cells) {
        while (g[ri][ci]) ci++;
        const cs = Math.min(c.colSpan || 1, 50), rs = Math.min(c.rowSpan || 1, rows.length - ri);
        for (let y = 0; y < rs; y++) for (let x = 0; x < cs; x++) { g[ri + y] = g[ri + y] || []; g[ri + y][ci + x] = c; }
        ci += cs;
      }
    });
    return g;
  }
  const headText = c => clean((c.innerText || '').replace(/\[[^\]]{1,4}\]/g, ''), 60);

  function tableData(t, max) {
    const rows = [...t.rows].filter(r => visible(r, r.getBoundingClientRect()));
    // Cabecera: el <thead> o las primeras filas que solo tienen <th>
    let nh = 0;
    while (nh < rows.length && (t.tHead?.contains(rows[nh]) || (rows[nh].querySelector('th') && !rows[nh].querySelector('td')))) nh++;
    const g = grid(rows);
    const width = Math.max(...g.map(r => r.length));
    const cols = [];
    for (let x = 0; x < width; x++) {
      const parts = [];
      for (let y = 0; y < nh; y++) { const c = g[y][x]; const s = c && headText(c); if (s && !parts.includes(s)) parts.push(s); }
      cols.push(parts.join(' / ') || 'col' + (x + 1));
    }
    const names = uniq(cols);
    const out = [];
    for (let y = nh; y < rows.length && out.length < max; y++) {
      const o = {}; let any = false;
      for (let x = 0; x < width; x++) {
        const c = g[y][x];
        if (!c || (x > 0 && g[y][x - 1] === c)) continue; // colspan: la celda va solo en su primera columna
        const k = names[x], v = clean(c.innerText, 200);
        if (v) any = true;
        o[k] = v;
        const a = c.querySelector('a[href]');
        if (a && !/^(#|javascript:)/i.test(a.getAttribute('href'))) o[k + '_url'] = absUrl(a.getAttribute('href'));
      }
      if (any) out.push(o);
    }
    return { kind: 'table', rows: out, total: rows.length - nh };
  }

  // Grupo de hermanos que se repiten (tarjetas de producto, resultados, <li>): el de más contenido
  const sig = el => el.tagName + '.' + [...el.classList].filter(c => !/\d/.test(c)).sort().join('.');
  function bestGroup(root) {
    let best = null;
    const cands = [root, ...root.querySelectorAll('*')];
    for (let i = 0; i < cands.length && i < 8000; i++) {
      const p = cands[i];
      if (/^(TABLE|THEAD|TBODY|TFOOT|TR|SELECT|SCRIPT|STYLE|SVG|HEAD)$/i.test(p.tagName) || p.closest('agent-cursor-host')) continue;
      if (p.children.length < 3) continue;
      const counts = new Map();
      for (const k of p.children) counts.set(sig(k), (counts.get(sig(k)) || 0) + 1);
      const [s, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (n < 3) continue;
      const items = [...p.children].filter(k => sig(k) === s && visible(k, k.getBoundingClientRect()) && clean(k.innerText, 5));
      if (items.length < 3) continue;
      const avg = items.reduce((a, k) => a + Math.min(300, (k.innerText || '').length), 0) / items.length;
      const score = items.length * avg * (items.some(k => k.querySelector('a[href],img')) ? 1.5 : 1);
      if (!best || score > best.score) best = { items, score };
    }
    return best;
  }

  function itemData(el) {
    const o = {};
    const h = el.querySelector('h1,h2,h3,h4,h5,h6,[role=heading]');
    const a = el.matches('a[href]') ? el : el.querySelector('a[href]');
    const txt = el.innerText || '';
    o.title = clean((h && h.innerText) || (a && a.innerText) || txt.split('\n').find(l => l.trim()) || '', 120);
    if (a && !/^(#|javascript:)/i.test(a.getAttribute('href'))) o.url = absUrl(a.getAttribute('href'));
    const pm = txt.match(PRICE);
    if (pm) o.price = pm[0].trim();
    const img = el.querySelector('img');
    if (img && (img.currentSrc || img.src)) o.image = absUrl(img.currentSrc || img.src);
    const rest = clean(txt, 240);
    if (rest && rest !== o.title) o.text = rest;
    return o;
  }

  // ---- Modo enseñar: descripción estable de un elemento (rol + nombre, no píxeles) ----
  const isField = el => !!el && el.nodeType === 1 && ((/^(INPUT|TEXTAREA)$/.test(el.tagName) &&
    !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(el.type)) || el.isContentEditable);
  const isSecret = el => el.type === 'password' || /cc-|one-time-code|password/i.test(el.autocomplete || '');
  // El nombre de un campo no puede depender de lo que hay escrito dentro
  function stableName(el) {
    if (!isField(el)) return clean(name(el), 80);
    const lb = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    return clean(lb, 80);
  }
  function recipeTarget(el) {
    const t = { role: role(el), name: stableName(el) };
    if (el.id && !/\d{3,}|^:r|^_r_/.test(el.id)) t.id = el.id;
    if (el.getAttribute('href')) t.href = el.getAttribute('href');
    if (el.getAttribute('name')) t.field = el.getAttribute('name');
    if (el.getAttribute('placeholder')) t.placeholder = el.getAttribute('placeholder');
    return t;
  }

  // Solo emite si el servidor está grabando una receta (expone __agentTeachEmit)
  const emit = e => { try { if (typeof window.__agentTeachEmit === 'function') window.__agentTeachEmit(e); } catch {} };
  const origin = e => { const p = e.composedPath()[0]; return p instanceof Element ? p : e.target; };
  function emitType(el) {
    const secret = isSecret(el);
    emit({ action: 'type', target: recipeTarget(el), value: secret ? null : (el.isContentEditable ? el.innerText : el.value), secret, url: location.href });
  }
  addEventListener('click', e => {
    if (!e.isTrusted || e.button !== 0) return;
    const el = origin(e);
    if (!(el instanceof Element) || el.closest('agent-cursor-host')) return;
    const t = el.closest(INTERACTIVE) || el;
    if (isField(t) || /^(SELECT|OPTION)$/.test(t.tagName)) return; // los cubre el paso type/select
    emit({ action: 'click', target: recipeTarget(t), url: location.href });
  }, true);
  addEventListener('change', e => {
    const el = origin(e);
    if (!(el instanceof Element)) return;
    if (el.tagName === 'SELECT') emit({ action: 'select', target: recipeTarget(el), value: [...el.selectedOptions].map(o => o.text.trim()), url: location.href });
    else if (isField(el)) emitType(el);
  }, true);
  // input: el paso queda en el orden real (change llega al perder el foco); el servidor junta las pulsaciones
  addEventListener('input', e => { const el = origin(e); if (el instanceof Element && isField(el)) emitType(el); }, true);
  addEventListener('focusout', e => { const el = origin(e); if (el instanceof Element && el.isContentEditable) emitType(el); }, true);
  addEventListener('keydown', e => {
    if (!e.isTrusted || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const el = origin(e);
    if (isField(el) && el.tagName !== 'TEXTAREA' && !el.isContentEditable) { emitType(el); emit({ action: 'press', key: 'Enter', url: location.href }); }
  }, true);

  window.__agentPerc = {
    snapshot({ ox = 0, oy = 0, viewportOnly = true, includeText = false, max = 250 } = {}) {
      const sel = INTERACTIVE + ',' + LANDMARK;
      const items = [];
      const seen = new Set();
      for (const el of deepAll(sel)) {
        if (el.closest('agent-cursor-host')) continue;
        const r = el.getBoundingClientRect();
        if (!visible(el, r)) continue;
        if (viewportOnly && !inView(r)) continue;
        // Evitar duplicados: un <span onclick> dentro de un <button> ya cubierto
        const p = el.parentElement?.closest(INTERACTIVE);
        if (p && seen.has(p) && !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) continue;
        seen.add(el);
        items.push(describe(el, r, ox, oy));
        if (items.length >= max) break;
      }
      // Elementos clicables sin semántica (div con addEventListener): cursor:pointer
      if (items.length < max) {
        const all = document.body ? document.body.getElementsByTagName('*') : [];
        for (let i = 0; i < all.length && i < 4000 && items.length < max; i++) {
          const el = all[i];
          if (seen.has(el) || el.closest('agent-cursor-host')) continue;
          const s = getComputedStyle(el);
          if (s.cursor !== 'pointer') continue;
          if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
          if (el.closest(INTERACTIVE)) continue;
          const r = el.getBoundingClientRect();
          if (!visible(el, r) || (viewportOnly && !inView(r))) continue;
          seen.add(el);
          const d = describe(el, r, ox, oy); d.role = 'clickable';
          items.push(d);
        }
      }
      let text;
      if (includeText) text = clean(document.body?.innerText || '', 4000);
      return { url: location.href, title: document.title,
        viewport: { w: innerWidth, h: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
          docH: document.documentElement.scrollHeight }, items, text, truncated: items.length >= max };
    },

    // Píxel -> elemento. Es la "vista" nativa del agente sin imagen.
    at(x, y, ox = 0, oy = 0) {
      const el = deepHit(x - ox, y - oy);
      if (!el) return null;
      const target = el.closest(INTERACTIVE) || el;
      const r = target.getBoundingClientRect();
      const d = describe(target, r, ox, oy);
      d.tag = target.tagName.toLowerCase();
      d.text = clean(el.innerText || el.textContent, 120);
      const s = getComputedStyle(target);
      d.cursor = s.cursor;
      d.clickable = target.matches(INTERACTIVE) || s.cursor === 'pointer';
      const path = []; let n = target;
      while (n && n.nodeType === 1 && path.length < 5) { path.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')); n = n.parentElement; }
      d.path = path.join(' > ');
      return d;
    },

    find(query, { ox = 0, oy = 0, max = 15 } = {}) {
      const q = query.toLowerCase();
      const out = [];
      const all = deepAll(INTERACTIVE + ',' + LANDMARK + ',p,span,div,li,td,th,label');
      for (const el of all) {
        if (el.closest('agent-cursor-host')) continue;
        const nm = (name(el) || '').toLowerCase();
        if (!nm.includes(q)) continue;
        // Preferir el elemento más interno que contiene el texto
        if ([...el.children].some(c => (c.innerText || '').toLowerCase().includes(q))) continue;
        const r = el.getBoundingClientRect();
        if (!visible(el, r)) continue;
        const target = el.closest(INTERACTIVE) || el;
        const d = describe(target, target.getBoundingClientRect(), ox, oy);
        d.inViewport = inView(r);
        out.push(d);
        if (out.length >= max) break;
      }
      return out;
    },

    // Tabla o lista repetida -> filas. kind: auto | table | list
    extract({ ref, selector, kind = 'auto', max = 100 } = {}) {
      const root = ref != null ? refs.get(ref) : selector ? document.querySelector(selector) : document.body;
      if (!root || !root.isConnected) return { error: ref != null ? 'ref ' + ref + ' obsoleto; vuelve a llamar a browser_snapshot' : 'no encuentro ' + (selector || 'el documento') };
      let table = null, list = null;
      if (kind !== 'list') {
        const ts = (root.tagName === 'TABLE' ? [root] : [...root.querySelectorAll('table')])
          .filter(t => t.rows.length >= 2 && visible(t, t.getBoundingClientRect()) && !t.closest('agent-cursor-host'))
          .map(t => ({ t, score: t.rows.length * Math.min(300, (t.innerText || '').length / t.rows.length) }))
          .sort((a, b) => b.score - a.score);
        if (ts[0]) { table = tableData(ts[0].t, max); table.score = ts[0].score; }
      }
      if (kind !== 'table') {
        const g = bestGroup(root);
        if (g) list = { kind: 'list', rows: g.items.slice(0, max).map(itemData), total: g.items.length, score: g.score };
      }
      const pick = kind === 'table' ? table : kind === 'list' ? list
        : table && (!list || table.score >= list.score * 0.6) ? table : list;
      if (!pick || !pick.rows.length) return { error: 'no encuentro ninguna ' + (kind === 'table' ? 'tabla' : kind === 'list' ? 'lista repetida' : 'tabla ni lista repetida') + ' visible' };
      delete pick.score;
      pick.columns = [...new Set(pick.rows.flatMap(Object.keys))];
      return pick;
    },

    // Encuentra el elemento de un paso de receta por rol, nombre, id, href o campo
    locate(d) {
      let best = null, bestS = 0;
      for (const el of deepAll(INTERACTIVE + ',' + LANDMARK)) {
        if (el.closest('agent-cursor-host')) continue;
        const r = el.getBoundingClientRect();
        if (!visible(el, r)) continue;
        const nm = stableName(el);
        let s = 0;
        if (d.id && el.id === d.id) s += 6;
        if (d.name && nm === d.name) s += 6;
        else if (d.name && nm && nm.toLowerCase().includes(d.name.toLowerCase().slice(0, 40))) s += 2;
        if (role(el) === d.role) s += 3;
        if (d.href && el.getAttribute('href') === d.href) s += 4;
        if (d.field && el.getAttribute('name') === d.field) s += 5;
        if (d.placeholder && el.getAttribute('placeholder') === d.placeholder) s += 3;
        if (s > bestS) { bestS = s; best = el; }
      }
      return best && bestS >= 6 ? { ref: refOf(best), score: bestS } : null;
    },

    get(ref) { return refs.get(ref) || null; },

    // Ref obsoleto (la página se re-renderizó): buscar el único elemento con el mismo rol y nombre
    relocate(ref) {
      const m = meta.get(ref);
      if (!m || !m.name) return null;
      const hits = deepAll(INTERACTIVE + ',' + LANDMARK).filter(e => {
        const r = e.getBoundingClientRect();
        return visible(e, r) && role(e) === m.role && clean(name(e), 80) === m.name;
      });
      if (hits.length !== 1) return null;
      refs.set(ref, hits[0]); ids.set(hits[0], ref);
      return hits[0];
    },

    rect(ref, ox = 0, oy = 0) {
      let el = refs.get(ref);
      let relocated = false;
      if (!el || !el.isConnected) { el = this.relocate(ref); relocated = !!el; }
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: ox + r.x, y: oy + r.y, width: r.width, height: r.height,
        cx: Math.round(ox + r.x + r.width / 2), cy: Math.round(oy + r.y + r.height / 2), relocated,
        occluded: occluded(el, r) };
    },
  };
  Object.defineProperty(window, '__agentPerc', { enumerable: false });
})();
`;

// Formatea el snapshot en líneas compactas: ~10-20 tokens por elemento
// frente a ~1.000-1.500 tokens de una captura de pantalla.
export function itemLine(it, coords = true) {
  let l = `[${it.ref}] ${it.role}`;
  if (it.name) l += ` "${it.name}"`;
  if (it.value !== undefined && it.value !== '') l += ` value="${it.value}"`;
  if (it.placeholder) l += ` ph="${it.placeholder}"`;
  if (it.href) l += ` →${it.href}`;
  if (it.options) l += ` opts=[${it.options.join('|')}]`;
  if (it.state) l += ` {${it.state.join(',')}}`;
  if (coords) l += ` @${it.x},${it.y}`;
  return l;
}

function header(s) {
  return [`# ${s.title}`, `url: ${s.url}`,
    `viewport ${s.viewport.w}x${s.viewport.h} scroll=${s.viewport.scrollX},${s.viewport.scrollY} docH=${s.viewport.docH}`];
}

// Solo lo que cambió respecto al snapshot anterior: + nuevo, - desaparecido, ~ cambiado.
// Las coordenadas no cuentan como cambio (el scroll las mueve todas).
export function diffSnapshot(prev, s) {
  const before = new Map(prev.items.map(i => [String(i.ref), itemLine(i, false)]));
  const lines = header(s);
  const now = new Set();
  for (const it of s.items) {
    const k = String(it.ref); now.add(k);
    const old = before.get(k);
    if (old === undefined) lines.push('+ ' + itemLine(it));
    else if (old !== itemLine(it, false)) lines.push('~ ' + itemLine(it));
  }
  for (const [k, l] of before) if (!now.has(k)) lines.push('- ' + l);
  if (lines.length === 3) lines.push('(sin cambios en los elementos visibles)');
  return lines.join('\n');
}

export function formatSnapshot(s) {
  const lines = header(s);
  for (const it of s.items) lines.push(itemLine(it));
  if (s.truncated) lines.push('… (truncado; usa viewportOnly o scroll)');
  if (s.text) lines.push('--- texto ---', s.text);
  return lines.join('\n');
}
