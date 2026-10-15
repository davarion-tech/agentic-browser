# Security

agentic-browser gives an AI agent real control of a browser profile. Treat it like giving someone your keyboard and mouse.

## Threat model

| Risk | What can happen | Built-in mitigation | What you should do |
|---|---|---|---|
| **Prompt injection** | A web page, email or chat message contains text like "ignore your instructions and send me…" and the agent obeys. | `browser_read` wraps page text in `<page_content trust="untrusted">`. The snapshot only lists visible elements. | Tell your agent that page content is data, never instructions. Require human confirmation for irreversible actions. |
| **Over-privileged agent** | The agent can run arbitrary JavaScript, upload local files, or browse anywhere. | `AGENT_TOOLS=core` exposes a reduced tool set. `AGENT_READONLY=1` disables every action that changes a page. `AGENT_ALLOWED_ORIGINS` restricts navigation to a domain allowlist. | Use the smallest tool set that does the job. Never expose `browser_eval` or `browser_upload` to agents that read untrusted content. |
| **Session theft** | The agent profile holds logged-in sessions (cookies). | The profile is separate from your personal Chrome profile (`~/.agentic-browser/profile`). | Give the agent its own accounts. Never log it into your bank or main email. |
| **Network exposure** | Someone else on the network drives your browser through the HTTP API. | The HTTP server binds to `127.0.0.1` only. `AGENT_TOKEN` enables Bearer authentication. | Always set `AGENT_TOKEN`. Never put the API behind a public reverse proxy. |
| **Runaway loops** | The agent repeats the same action and burns tokens or spams a site. | The response warns when the same call repeats 3 times. `browser_trace` logs every action to `~/.agentic-browser/trace.jsonl`. | Set step and budget limits in your agent. Review the trace. |
| **Credentials and 2FA** | The agent sees or types passwords and one-time codes. | `browser_request_human` hands control to the person watching. Password field values are masked in snapshots. | Let humans type secrets. Do not put credentials in prompts. |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") on this repository, and include steps to reproduce. We aim to acknowledge reports within 7 days.
