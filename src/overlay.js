// Cursor visual del agente. Se inyecta en cada documento (addInitScript) y dibuja
// un puntero que sigue los eventos de ratón REALES que llegan por CDP
// (Input.dispatchMouseEvent). No intercepta clics (pointer-events:none) y vive en
// un shadow root cerrado para no contaminar el DOM ni los snapshots.
export const overlayScript = String.raw`
(() => {
  if (window.top !== window) return;            // solo en el frame principal
  if (window.__agentCursor) return;
  const COLOR = '#ff3b6b';
  let host, root, cursor, label, trailCanvas, ctx;
  let pos = { x: -100, y: -100 };
  const trail = [];
  const enabled = { trail: true };

  function mount() {
    if (host && host.isConnected) return;
    host = document.createElement('agent-cursor-host');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>' +
      ':host{all:initial}' +
      '.c{position:fixed;left:0;top:0;width:26px;height:26px;transform:translate(-100px,-100px);' +
      '  transition:transform 60ms linear;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));will-change:transform}' +
      '.l{position:fixed;left:0;top:0;transform:translate(-100px,-100px);font:600 11px/1.2 system-ui,sans-serif;' +
      '  color:#fff;background:' + COLOR + ';padding:3px 7px;border-radius:9px;white-space:nowrap;' +
      '  transition:transform 60ms linear,opacity .3s;opacity:0;max-width:320px;overflow:hidden;text-overflow:ellipsis}' +
      '.r{position:fixed;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid ' + COLOR + ';' +
      '  animation:rp .55s ease-out forwards}' +
      '.r.right{border-color:#3b82f6}' +
      '.dot{position:fixed;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:' + COLOR + '}' +
      '.box{position:fixed;border:2px dashed ' + COLOR + ';border-radius:4px;animation:fd 1.2s ease-out forwards}' +
      '@keyframes rp{from{transform:scale(1);opacity:1}to{transform:scale(4.5);opacity:0}}' +
      '@keyframes fd{0%{opacity:1}70%{opacity:1}100%{opacity:0}}' +
      'canvas{position:fixed;inset:0}' +
      '</style>' +
      '<canvas></canvas>' +
      '<svg class="c" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.5 16 L12 24 L15.5 22.5 L12 15 L19.5 15 Z" ' +
      'fill="' + COLOR + '" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
      '<div class="l"></div>';
    cursor = root.querySelector('.c');
    label = root.querySelector('.l');
    trailCanvas = root.querySelector('canvas');
    ctx = trailCanvas.getContext('2d');
    resize();
    (document.documentElement || document).appendChild(host);
    place();
  }

  function resize() {
    if (!trailCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    trailCanvas.width = innerWidth * dpr; trailCanvas.height = innerHeight * dpr;
    trailCanvas.style.width = innerWidth + 'px'; trailCanvas.style.height = innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function place() {
    if (!cursor) return;
    cursor.style.transform = 'translate(' + (pos.x - 3) + 'px,' + (pos.y - 2) + 'px)';
    label.style.transform = 'translate(' + (pos.x + 18) + 'px,' + (pos.y + 20) + 'px)';
  }

  function drawTrail() {
    if (!ctx) return requestAnimationFrame(drawTrail);
    const now = performance.now();
    while (trail.length && now - trail[0].t > 700) trail.shift();
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (enabled.trail && trail.length > 1) {
      for (let i = 1; i < trail.length; i++) {
        const a = 1 - (now - trail[i].t) / 700;
        ctx.strokeStyle = 'rgba(255,59,107,' + (a * 0.55).toFixed(3) + ')';
        ctx.lineWidth = 3 * a + 0.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
        ctx.lineTo(trail[i].x, trail[i].y);
        ctx.stroke();
      }
    }
    requestAnimationFrame(drawTrail);
  }

  function move(x, y) {
    mount();
    pos = { x, y };
    trail.push({ x, y, t: performance.now() });
    place();
  }

  let lastRipple = { x: 0, y: 0, t: 0 };
  function ripple(x, y, cls) {
    // El servidor también lo invoca (clics dentro de iframes no llegan aquí): deduplicar
    const now = performance.now();
    if (now - lastRipple.t < 200 && Math.abs(x - lastRipple.x) < 3 && Math.abs(y - lastRipple.y) < 3) return;
    lastRipple = { x, y, t: now };
    mount();
    const r = document.createElement('div');
    r.className = 'r' + (cls ? ' ' + cls : '');
    r.style.left = x + 'px'; r.style.top = y + 'px';
    root.appendChild(r);
    setTimeout(() => r.remove(), 600);
  }

  let labelTimer;
  function say(text, ms) {
    mount();
    label.textContent = text;
    label.style.opacity = text ? '1' : '0';
    clearTimeout(labelTimer);
    if (text) labelTimer = setTimeout(() => (label.style.opacity = '0'), ms || 1800);
  }

  function highlight(rect) {
    mount();
    const b = document.createElement('div');
    b.className = 'box';
    b.style.cssText = 'left:' + (rect.x - 3) + 'px;top:' + (rect.y - 3) + 'px;width:' + (rect.width + 2) + 'px;height:' + (rect.height + 2) + 'px';
    root.appendChild(b);
    setTimeout(() => b.remove(), 1300);
  }

  // Los eventos sintetizados por CDP son isTrusted=true y pasan por aquí.
  addEventListener('mousemove', e => move(e.clientX, e.clientY), true);
  addEventListener('mousedown', e => { move(e.clientX, e.clientY); ripple(e.clientX, e.clientY, e.button === 2 ? 'right' : ''); }, true);
  addEventListener('resize', resize);
  document.addEventListener('DOMContentLoaded', mount);
  // Algunos frameworks reemplazan <html>/<body>: re-montar si nos quitan.
  setInterval(() => { if (host && !host.isConnected) { host = null; mount(); } }, 1000);
  requestAnimationFrame(drawTrail);

  // Traspaso al humano: banner clicable (el resto del overlay sigue sin capturar clics)
  let pendingAsk = null;
  function ask(text) {
    mount();
    if (pendingAsk) return pendingAsk.promise;
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);pointer-events:auto;z-index:1;' +
      'display:flex;gap:10px;align-items:center;max-width:min(680px,92vw);padding:10px 12px 10px 16px;border-radius:12px;' +
      'background:#111827;color:#fff;font:500 14px/1.35 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);border:2px solid ' + COLOR;
    const msg = document.createElement('div');
    msg.style.cssText = 'flex:1';
    msg.textContent = '🤖 El agente necesita tu ayuda: ' + text;
    const mk = (label, bg) => { const b = document.createElement('button'); b.textContent = label;
      b.style.cssText = 'all:unset;cursor:pointer;padding:7px 12px;border-radius:8px;font-weight:600;background:' + bg; return b; };
    const ok = mk('Listo, continúa', COLOR), no = mk('Cancelar', '#374151');
    bar.append(msg, ok, no);
    root.appendChild(bar);
    let resolve; const promise = new Promise(r => (resolve = r));
    const done = v => { bar.remove(); pendingAsk = null; resolve(v); };
    ok.onclick = () => done('done'); no.onclick = () => done('cancel');
    pendingAsk = { promise };
    return promise;
  }

  window.__agentCursor = {
    move, ripple, say, highlight, ask,
    get: () => ({ ...pos }),
    trail: on => (enabled.trail = !!on),
    hide: () => host && (host.style.display = 'none'),
    show: () => host && (host.style.display = ''),
  };
  Object.defineProperty(window, '__agentCursor', { enumerable: false });
})();
`;
