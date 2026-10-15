// Mensaje breve al terminar `npm install`: cómo conectarlo y que el vigilante es opcional.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mcp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.js').replace(/\\/g, '/');
console.log(`
  ✔ agentic-browser instalado

  Conéctalo a tu agente (ejemplo Claude Code):
    claude mcp add agentic-browser -- node ${mcp}
  Otros clientes MCP: examples/mcp-config.json · Sin MCP: npm run http

  Opcional: vigilante de chats (viene APAGADO; responde mensajes de las cuentas del agente)
    npm run setup      → configuración guiada (borrador por defecto)
    npm run watcher    → arrancarlo
  Lee DISCLAIMER.md antes de automatizar cuentas o sitios de terceros.
`);
