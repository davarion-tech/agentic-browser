# Use cases / Casos de uso

Each case lists the recommended configuration and the tools involved. Read the [Disclaimer](../DISCLAIMER.md) before automating any third-party site.

Cada caso indica la configuración recomendada y las herramientas que usa. Lee el [Aviso de responsabilidad](../DISCLAIMER.md) antes de automatizar sitios de terceros.

---

## 1. Web research with fewer tokens / Investigación web con menos tokens

An agent searches, opens results and reads articles without a single screenshot.

Un agente busca, abre resultados y lee artículos sin una sola captura.

- **Flow:** `browser_navigate` (with `snapshot: true`) → `browser_type` (with `submit: true`) → `browser_snapshot` → `browser_click` → `browser_read`.
- **Measured:** a 7-step Wikipedia search cost ≈ 2,540 tokens of tool output. With screenshots the same flow would be ≈ 9,000–10,000 tokens.
- **Config:** `AGENT_TOOLS=core`, `AGENT_READONLY=1` if the agent only needs to read.

## 2. QA and end-to-end testing of your own web app / QA y pruebas de tu propia app

Point the agent at `localhost`. It fills forms, clicks through flows, checks `browser_console` for JS errors, and you watch the red cursor do it.

Apunta el agente a `localhost`. Rellena formularios, recorre flujos y revisa `browser_console` en busca de errores de JS, mientras tú ves el cursor rojo hacerlo.

- **Tools:** `browser_snapshot` (with `diff: true` after each action), `browser_console`, `browser_events`, `browser_trace`.
- **Config:** `AGENT_ALLOWED_ORIGINS=localhost`, `AGENT_HEADLESS=1` in CI.

## 3. Back-office tasks in web apps without an API / Tareas administrativas en webs sin API

Download monthly reports from a supplier portal, update a record in an internal CRM, or fill in a government form, all on the agent's own accounts.

Descargar reportes mensuales del portal de un proveedor, actualizar un registro en un CRM interno o rellenar un formulario de gobierno, siempre con las cuentas propias del agente.

- **Tools:** `browser_find`, `browser_select`, `browser_upload`, `browser_events` (downloads are saved to `~/.agentic-browser/downloads`).
- **Human in the loop:** use `browser_request_human` for login, 2FA, and the final "Submit".

## 4. Monitoring pages and inboxes / Vigilar páginas y bandejas

Wait for a price, a status, a new email or a new chat message, without spending tokens while waiting.

Esperar un precio, un estado, un correo nuevo o un mensaje de chat sin gastar tokens mientras espera.

- **Tool:** `browser_watch` with `text` (a regex), `selector` (the container to watch) or `titleChange` (for example `"(3) Inbox"`). The agent's turn blocks inside the browser and resumes only when something changes.
- **Example:** `browser_watch({ "text": "Shipped|Enviado", "timeout": 3600000 })`.

## 5. Assistant for an agent-owned messaging account / Asistente para la cuenta de mensajería del agente

An agent with its **own** accounts (email, social networks, calendar) keeps those tabs open and answers routine messages. It escalates anything sensitive to a human.

Un agente con sus **propias** cuentas (correo, redes, calendario) mantiene esas pestañas abiertas, responde mensajes rutinarios y escala lo sensible a un humano.

- **Building blocks:** `browser_watch` to wake up, `browser_snapshot`/`browser_read` to read, `browser_type` to draft. Start in draft mode: the agent writes, a human presses send.
- **Prefer official APIs** (WhatsApp Business API, Telegram Bot API, Gmail API) for production messaging. Many platforms forbid unofficial automated clients.
- **Ready-made:** the [chat watcher](WATCHER.md) (`npm run watcher`) implements this with a code-enforced send policy: draft by default, allowlist, sensitive keywords, hourly limit and domain lock.

## 6. Supervised automation and demos / Automatización supervisada y demos

The visible cursor, click ripples and action labels make agent behaviour easy to follow live or in a screen recording. That makes it useful for demos, training, and building trust before you grant more autonomy.

El cursor visible, las ondas de clic y las etiquetas de acción permiten seguir lo que hace el agente en vivo o en una grabación de pantalla. Sirve para demos, formación y para ganar confianza antes de darle más autonomía.

## 7. Plugging into any agent framework / Conectarlo a cualquier framework de agentes

- **MCP clients** (Claude Code, Claude Desktop, Cursor, Codex, Hermes, OpenClaw, Agent SDK…): register `src/mcp.js`.
- **Anything else** (Python, LangChain, n8n, custom loops): run `npm run http`. Then `GET /tools` returns JSON Schemas you can pass as function/tool definitions to any LLM API.
- **Several agents, one browser:** run a single HTTP server (it serializes actions) or launch Chrome with `--remote-debugging-port` and point each server at it with `AGENT_CDP_URL`.

---

## Not supported / No soportado

- Solving CAPTCHAs or evading bot detection. The agent should call `browser_request_human` instead.
- Mass messaging, account farming, scraping against a site's terms, or anything in the prohibited uses of the [Disclaimer](../DISCLAIMER.md).
