// Máscara de privacidad: difumina contactos, avatares y números para grabar o compartir
// pantalla. Solo cambia lo que ve una persona; el agente sigue leyendo la página por el DOM.
// Los preajustes solo se aplican en su dominio; los selectores sueltos, en todas las páginas.
export const PRIVACY_PRESETS = {
  whatsapp: {
    hosts: ['web.whatsapp.com'],
    // Lista de chats y resultados de búsqueda, cabecera del chat abierto (nombre y foto),
    // tu foto en la barra lateral y cualquier foto de perfil
    selectors: ['#pane-side', '[aria-label="Chat list"]', '[aria-label="Lista de chats"]', '#main header', 'header img', 'img[src*="whatsapp.net"]'],
  },
  telegram: {
    hosts: ['web.telegram.org'],
    selectors: ['.chatlist', '.chat-list', '.peer-title', '.avatar-element', '.Avatar', '.ChatInfo', '.chat-info'],
  },
  gmail: {
    hosts: ['mail.google.com'],
    // Remitentes en la bandeja, remitente y dirección del correo abierto, avatares
    selectors: ['tr.zA .yX', 'span[email]', '.gD', '.go', 'img.ajn'],
  },
};

// "whatsapp", "whatsapp,gmail", ["telegram", ".mi-selector"], "off" -> [{ hosts, sel }]
export function privacyRules(spec) {
  if (spec == null || spec === false) return [];
  // Algunos clientes MCP mandan la lista como texto JSON
  if (typeof spec === 'string' && spec.trim().startsWith('[')) { try { spec = JSON.parse(spec); } catch {} }
  const items = (Array.isArray(spec) ? spec : String(spec).split(',')).map(s => String(s).trim()).filter(Boolean);
  const rules = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (['off', 'none', '0', 'false'].includes(key)) continue;
    const p = PRIVACY_PRESETS[key];
    if (p) for (const sel of p.selectors) rules.push({ hosts: p.hosts, sel });
    else rules.push({ hosts: null, sel: it });
  }
  return rules;
}
