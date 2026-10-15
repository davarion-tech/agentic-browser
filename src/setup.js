#!/usr/bin/env node
// Asistente guiado para configurar el vigilante de chats. Explica cada opción,
// pregunta, y escribe watcher.config.json. Nunca guarda la API key en el archivo.
//
//   npm run setup            (o: node src/setup.js [ruta-de-salida])
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DEFAULTS } from './watcher.js';

const PRESETS = {
  1: { name: 'whatsapp', url: 'https://web.whatsapp.com/', hints: 'La lista de chats está a la izquierda; los no leídos muestran un globo verde con un número. La caja de texto está abajo.' },
  2: { name: 'telegram', url: 'https://web.telegram.org/a/' },
  3: { name: 'messenger', url: 'https://www.messenger.com/' },
  4: { name: 'instagram', url: 'https://www.instagram.com/direct/inbox/' },
};

const out = path.resolve(process.argv[2] || 'watcher.config.json');
const rl = readline.createInterface({ input: stdin, output: stdout });
const lines = [];
rl.on('line', l => lines.push(l));                     // también funciona con respuestas por tubería
const ask = async q => { stdout.write(q); while (!lines.length) { if (rl.closed) return ''; await new Promise(r => setTimeout(r, 20)); } return lines.shift().trim(); };
rl.on('close', () => (rl.closed = true));
const say = t => stdout.write(t + '\n');
const choose = async (q, opts, def) => {
  for (;;) {
    const a = (await ask(`${q} [${def}]: `)) || String(def);
    if (opts.includes(a)) return a;
    say(`  Elige una de: ${opts.join(', ')}`);
  }
};
const yes = async (q, def = 'n') => /^s|^y/i.test((await ask(`${q} (s/n) [${def}]: `)) || def);

say(`
╭──────────────────────────────────────────────────────────────╮
│  Configuración del vigilante de chats de agentic-browser     │
╰──────────────────────────────────────────────────────────────╯
El vigilante mantiene abiertas las pestañas de chat de las cuentas DEL AGENTE
y, cuando llega un mensaje, le pide a Claude que lo lea y proponga respuesta.
Mientras espera no gasta tokens. Te haré unas preguntas; Enter acepta el valor
entre corchetes.

Importante: úsalo solo con cuentas propias del agente o tuyas, y respeta las
reglas de cada plataforma (muchas prohíben bots no oficiales). Ver DISCLAIMER.md.
`);

if (fs.existsSync(out) && !(await yes(`Ya existe ${out}. ¿Sobrescribirlo?`))) { say('Sin cambios.'); process.exit(0); }

say(`
1) ¿Qué puede hacer el agente con los mensajes?
   1. observe  → Solo te AVISA de cada mensaje. Nunca escribe nada.
   2. draft    → Escribe la respuesta en la caja pero NO la envía. Tú revisas
                 y pulsas Enter. (Recomendado para empezar.)
   3. auto     → Envía solo, pero ÚNICAMENTE a los contactos de una lista
                 blanca. Al resto le deja un borrador.`);
const mode = { 1: 'observe', 2: 'draft', 3: 'auto' }[await choose('   Opción', ['1', '2', '3'], 2)];

let allowlist = [];
if (mode === 'auto') {
  say(`
   Lista blanca: nombres de contactos o grupos a los que SÍ puede enviar solo,
   separados por comas, tal como aparecen en el chat. "*" = todos (no recomendado).`);
  allowlist = (await ask('   Contactos: ')).split(',').map(s => s.trim()).filter(Boolean);
  if (!allowlist.length) say('   (Lista vacía: en la práctica funcionará como "draft".)');
  if (allowlist.includes('*') && !(await yes('   "*" permite enviar a cualquiera. ¿Seguro?'))) allowlist = [];
}

say(`
2) ¿Quién es el asistente? Una frase que lo describa. Si la ley o la plataforma
   lo exige, debe reconocer que es un asistente virtual cuando se lo pregunten.`);
const persona = (await ask('   Persona [asistente de la cuenta]: ')) || DEFAULTS.persona;

say(`
3) Reglas del dueño (horarios, precios, qué escalar...). Una por línea; línea
   vacía para terminar.`);
const rules = [];
for (;;) { const r = await ask('   regla: '); if (!r) break; rules.push(r); }

say(`
4) Palabras sensibles: si aparecen en el mensaje o en la respuesta, el agente
   NO escribe nada y te avisa. Por defecto:
   ${DEFAULTS.escalateKeywords.join(', ')}`);
const extra = (await ask('   Añadir más (separadas por comas, Enter = ninguna): ')).split(',').map(s => s.trim()).filter(Boolean);
const escalateKeywords = [...DEFAULTS.escalateKeywords, ...extra];

const maxRepliesPerHour = mode === 'auto'
  ? Number(await ask(`\n5) Máximo de mensajes enviados por hora (freno de seguridad) [${DEFAULTS.maxRepliesPerHour}]: `)) || DEFAULTS.maxRepliesPerHour
  : DEFAULTS.maxRepliesPerHour;

say(`
6) ¿Qué chats vigila? Números separados por comas:
   1. WhatsApp Web   2. Telegram Web   3. Messenger   4. Instagram DM   5. Otra URL`);
const picks = ((await ask('   Canales [1]: ')) || '1').split(',').map(s => s.trim());
const channels = [];
for (const p of picks) {
  if (PRESETS[p]) channels.push({ ...PRESETS[p], unread: { type: 'title', pattern: '^\\((\\d+)\\)' } });
  else if (p === '5') {
    const url = await ask('   URL del chat: ');
    try { new URL(url); } catch { say('   URL inválida, se omite.'); continue; }
    say('   ¿Cómo sabe que hay mensajes nuevos? Lo habitual es un número en el título de la pestaña, p. ej. "(3) Mi chat".');
    channels.push({ name: new URL(url).hostname, url, unread: { type: 'title', pattern: '^\\((\\d+)\\)' } });
  }
}
if (!channels.length) channels.push({ ...PRESETS[1], unread: { type: 'title', pattern: '^\\((\\d+)\\)' } });

say(`
7) Avisos: el vigilante siempre escribe en ~/.agentic-browser/watcher-log.jsonl.
   Opcionalmente puede enviar cada aviso (escalados, borradores, envíos) a un
   webhook tuyo: Slack, Telegram, n8n...`);
const notifyWebhook = (await ask('   URL del webhook (Enter = ninguno): ')) || null;

say(`
8) ¿Con qué "cerebro" piensa el agente cuando llega un mensaje?
   1. claude-code → Tu suscripción de Claude (Pro/Max) a través de \`claude -p\`.
                    Sin API key ni cobro aparte; consume el uso de tu plan.
                    Requiere Claude Code instalado y con sesión iniciada en esta terminal.
   2. api         → API de Anthropic con ANTHROPIC_API_KEY. Cobro por token,
                    independiente de tu suscripción. Más rápido y predecible 24/7.`);
const brain = { 1: 'claude-code', 2: 'api' }[await choose('   Opción', ['1', '2'], 1)];

const cfg = { brain, model: DEFAULTS.model, effort: DEFAULTS.effort, mode, persona, rules, allowlist, escalateKeywords,
  maxRepliesPerHour, maxStepsPerEvent: DEFAULTS.maxStepsPerEvent, pollSeconds: DEFAULTS.pollSeconds, notifyWebhook, channels };

say(`
Resumen
  Cerebro:         ${brain}
  Modo:            ${mode}${mode === 'auto' ? ' (lista blanca: ' + (allowlist.join(', ') || 'vacía') + ')' : ''}
  Canales:         ${channels.map(c => c.name).join(', ')}
  Reglas:          ${rules.length}
  Palabras clave:  ${escalateKeywords.length}
  Webhook:         ${notifyWebhook || 'no'}`);
if (!(await yes('¿Guardar esta configuración?', 's'))) { say('No se guardó nada.'); process.exit(0); }
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n');
say(`\n✔ Guardado en ${out}`);

const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
say(`
Siguientes pasos
  1. ${brain === 'claude-code'
    ? 'En una terminal normal ejecuta  claude setup-token  y guarda el token en la variable AGENT_CLAUDE_TOKEN\n     (token de larga duración pensado para procesos 24/7; no lo guardes en este archivo).'
    : hasKey ? '✔ Credencial de Anthropic detectada.' : 'Define ANTHROPIC_API_KEY (créala en console.anthropic.com → API keys). No la guardes en este archivo.'}
  2. Ejecuta:  npm run watcher
  3. En la ventana de Chrome que se abre, inicia sesión una vez en cada canal.
  4. Revisa los primeros borradores antes de pasar a "auto".`);
rl.close();
