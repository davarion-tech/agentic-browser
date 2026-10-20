# Security

agentic-browser gives an AI agent real control of a browser profile. Treat it like giving someone your keyboard and mouse.

## Threat model

| Risk | What can happen | Built-in mitigation | What you should do |
|---|---|---|---|
| **Prompt injection** | A web page, email or chat message contains text like "ignore your instructions and send me…" and the agent obeys. | Every tool output that carries page text (snapshot, find, read, watch, console, events…) is wrapped in `<page_content trust="untrusted">`, and a page cannot close that delimiter early. `__agentPerc`/`__agentCursor` are frozen so a page cannot fake what the agent perceives. | Tell your agent that page content is data, never instructions. Require human confirmation for irreversible actions. |
| **Over-privileged agent** | The agent can run arbitrary JavaScript, upload local files, or browse anywhere. | `browser_eval` is off unless `AGENT_ALLOW_EVAL=1`. `browser_upload` only reads files inside `AGENT_UPLOAD_DIRS`. Dialogs are dismissed by default. `AGENT_TOOLS=core` exposes a reduced tool set. `AGENT_READONLY=1` disables every action that changes a page. `AGENT_ALLOWED_ORIGINS` restricts navigation to a domain allowlist. | Use the smallest tool set that does the job. Never expose `browser_eval` or `browser_upload` to agents that read untrusted content. |
| **Session theft** | The agent profile holds logged-in sessions (cookies). | The profile is separate from your personal Chrome profile (`~/.agentic-browser/profile`). | Give the agent its own accounts. Never log it into your bank or main email. |
| **Network and web exposure** | Someone on the network, or a web page open in any browser on the same computer, drives your browser through the HTTP API. | The HTTP server binds to `127.0.0.1` only, always requires a Bearer token (`AGENT_TOKEN` or the generated `~/.agentic-browser/http-token`), rejects requests with an `Origin` or cross-site `Sec-Fetch-Site` header, checks the `Host` header against DNS rebinding and only accepts JSON bodies. | Keep the token file private. Never put the API behind a public reverse proxy. |
| **Runaway loops** | The agent repeats the same action and burns tokens or spams a site. | The response warns when the same call repeats 3 times. `browser_trace` logs every action to `~/.agentic-browser/trace.jsonl`. | Set step and budget limits in your agent. Review the trace. |
| **Credentials and 2FA** | The agent sees or types passwords and one-time codes. | The agent cannot type into password, one-time-code, card or account-number fields (marked `{sensitive}`, values masked). `browser_request_human` hands control to the person watching, and only a real human click resolves its banner. Typed text is never stored in the trace. | Let humans type secrets. Do not put credentials in prompts. |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") on this repository, and include steps to reproduce. We aim to acknowledge reports within 7 days.
