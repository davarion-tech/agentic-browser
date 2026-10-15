# Chat watcher / Vigilante de chats

> **Read the [Disclaimer](../DISCLAIMER.md) first.** Use the watcher only on accounts that belong to the agent (or to you), comply with each platform's terms, and disclose that replies come from an assistant where required. Many messaging platforms forbid unofficial automated clients and may suspend accounts. For production use, prefer the official APIs (WhatsApp Business API, Telegram Bot API, Gmail API).
>
> **Lee primero el [Aviso de responsabilidad](../DISCLAIMER.md).** Usa el vigilante solo en cuentas del agente (o tuyas), cumple los términos de cada plataforma e indica que responde un asistente cuando sea obligatorio. Muchas plataformas de mensajería prohíben los clientes automatizados no oficiales y pueden suspender cuentas. En producción, prefiere las APIs oficiales.

`src/watcher.js` keeps the agent's messaging tabs open. It detects new messages **without spending tokens** (unread count in the tab title, or an unread-badge CSS selector). Only then does it wake Claude, with a restricted tool set, to read the conversations and reply.

`src/watcher.js` mantiene abiertas las pestañas de mensajería del agente. Detecta mensajes nuevos **sin gastar tokens** (el número de no leídos en el título de la pestaña, o un selector CSS de insignias). Solo entonces despierta a Claude, con un juego de herramientas restringido, para leer las conversaciones y responder.

## Quick start / Inicio rápido

```bash
npm run setup
```

The guided setup explains each option and asks, one question at a time: mode (observe / draft / auto), allowlist, persona, rules, sensitive keywords, hourly limit, channels and webhook. It writes `watcher.config.json` and never stores your API key. You can also copy and edit `watcher.config.example.json`.

El asistente guiado explica cada opción y pregunta una cosa a la vez; luego escribe `watcher.config.json` sin guardar la API key.

```bash
npm run watcher
```

1. A Chrome window opens with the agent profile. Log into each channel once (for example, scan the WhatsApp Web QR code). The session is kept in `~/.agentic-browser/profile`.
2. Choose the brain (see below). With `claude-code` nothing else is needed if `claude auth status` shows you are logged in; with `api`, set `ANTHROPIC_API_KEY`.
3. Leave `"mode": "draft"` until you trust the replies. Check `~/.agentic-browser/watcher-log.jsonl`.

## Brain / Cerebro

| `brain` | How it thinks / Cómo piensa | Cost / Coste |
|---|---|---|
| `claude-code` | Runs `claude -p` with **your Claude subscription** (Pro/Max). Claude Code only gets the watcher's restricted tools through a local MCP bridge (`src/watcher-bridge.js`): no built-in tools (`--tools ""`), no other MCP servers (`--strict-mcp-config`), everything else denied (`--permission-mode dontAsk`). / Usa **tu suscripción** vía `claude -p`, solo con las herramientas restringidas del vigilante. | Counts against your plan's usage limits; no extra bill. / Consume el uso de tu plan; sin factura aparte. |
| `api` | Calls the Anthropic API directly with `ANTHROPIC_API_KEY`. / Llama a la API con `ANTHROPIC_API_KEY`. | Pay per token. / Pago por token. |
| `auto` (default) | `api` if an API credential is set, otherwise `claude-code`. | |

**Recommended for 24/7: a long-lived token.** In a regular terminal (not the Claude desktop app's terminal) run `claude setup-token`, then start the watcher with that token in `AGENT_CLAUDE_TOKEN`. Normal logins expire; this token is designed for unattended use. If `claude -p` reports an expired session, the watcher writes this hint to the log.

**Recomendado para 24/7: token de larga duración.** En una terminal normal (no la de la app de escritorio) ejecuta `claude setup-token` y arranca el vigilante con ese token en `AGENT_CLAUDE_TOKEN`. Los inicios de sesión normales caducan; este token está pensado para uso desatendido.

## Modes / Modos

| `mode` | Behavior / Comportamiento |
|---|---|
| `observe` | Never types. Every message becomes a notification to the owner. / Nunca escribe; cada mensaje se convierte en un aviso al dueño. |
| `draft` **(default)** | Types the reply in the chat box but **never presses Enter**. A human reviews and sends. / Escribe la respuesta pero **nunca pulsa Enter**; un humano revisa y envía. |
| `auto` | Sends automatically, **only to contacts in `allowlist`** (`"*"` = everyone). Everyone else gets a draft. / Envía solo a los contactos de `allowlist`; al resto le deja un borrador. |

## Safety enforced in code / Seguridad aplicada en código

These rules don't depend on the model behaving well:

- **Sensitive keywords** (`escalateKeywords`): if the incoming message or the reply contains one, nothing is typed and the owner is notified.
- **Rate limit** (`maxRepliesPerHour`): once reached, `auto` falls back to drafts.
- **Domain lock**: if any action leaves the channel's origin (for example, a malicious link in a message), the watcher navigates back and logs `blocked`.
- **Restricted tools**: no `browser_eval`, `browser_navigate`, `browser_upload` or `browser_tabs`. Only navigation keys are allowed; a bare Enter can never be sent outside the send policy. Multi-line replies use Shift+Enter.
- **Prompt-injection posture**: the system prompt treats messages as third-party data. The agent can always `escalate` instead of replying.
- **Step limit** (`maxStepsPerEvent`): an event can't loop forever.
- **Audit**: every wake, LLM call (with token usage), send, draft, escalation and block is written to `logFile` and, optionally, POSTed to `notifyWebhook` (to forward to Slack, Telegram, n8n…).

## Configuration / Configuración

See [watcher.config.example.json](../watcher.config.example.json).

| Key | Default | |
|---|---|---|
| `model` / `effort` | `claude-opus-5-5` / `medium` | Model and effort. Server-side refusal fallbacks are enabled. |
| `persona`, `rules` | — | Who the assistant is and the owner's rules (hours, prices, what to escalate). |
| `channels[]` | — | `name`, `url`, optional `origins`, `unread` (`{type:"title", pattern}` or `{type:"selector", selector}`) and `hints` describing the UI to the agent. |
| `allowlist` | `[]` | Contacts allowed to receive automatic replies in `auto` mode. |
| `escalateKeywords` | password, code, payment… | Always escalate. |
| `maxRepliesPerHour`, `maxStepsPerEvent`, `pollSeconds`, `renotifyMinutes` | 20, 25, 4, 10 | Limits and polling interval. |
| `notifyWebhook` | `null` | URL that receives a JSON POST for each important event. |

## Cost / Coste

Waiting is free: the tab title or badges are checked locally every `pollSeconds`. Each wake-up costs a few LLM calls (snapshot, click, read, reply). Typically a few thousand tokens per conversation, mostly cached system prompt and tools.

## Testing / Pruebas

```bash
npm run test:watcher
```

Real end-to-end run with your subscription (uses a little of your plan) / Prueba real con tu suscripción:

```bash
npm run test:watcher:claude
```

The test runs a local mock chat and a scripted fake model. It doesn't call the API. It checks that the allowlisted contact gets the reply, a "send me the verification code" message is escalated, a malicious link is blocked, forbidden tools and Enter are rejected, draft mode doesn't send, and the hourly limit applies.
