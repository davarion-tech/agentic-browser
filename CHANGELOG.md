# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

## [1.1.2] - 2026-10-21

### Security
- **Chrome's sandbox is now enabled.** playwright-core launches Chromium with `--no-sandbox` unless told otherwise, so Chrome showed "unsupported command-line flag: --no-sandbox" and every tab ran without the OS-level isolation that contains a compromised renderer. agentic-browser now launches with the sandbox on (also in `npm run doctor`). Set `AGENT_NO_SANDBOX=1` only where the sandbox cannot run (Linux as root, some containers). Covered by `test/security.test.js`.

## [1.1.1] - 2026-10-20

### Fixed
- `browser_upload` could crash the whole MCP/HTTP server. The file-chooser wait was created before the click with a 5 s timeout and no handler, so when the click failed or took longer than 5 s (common in Google Drive) the rejected promise was unhandled and Node exited. The wait now has a handler and a 15 s timeout, and a click that does not open a file chooser returns a clear error. Covered by `test/security.test.js`.

## [1.1.0] - 2026-10-20

Security release. Upgrading is recommended for everyone using the HTTP API.

### Security
- **HTTP API hardened against web pages (CSRF / DNS rebinding).** Before, any website open on the same computer could send commands to `http://127.0.0.1:8787` when `AGENT_TOKEN` was not set. Now a Bearer token is always required (generated in `~/.agentic-browser/http-token` when `AGENT_TOKEN` is not set), requests carrying `Origin` or a cross-site `Sec-Fetch-Site` header are rejected, the `Host` header must be `127.0.0.1`/`localhost`, `POST` bodies must be `application/json`, and bodies are capped at 1 MB.
- **The agent never types secrets.** `browser_type` and `browser_press` refuse to write into password fields, one-time codes, card numbers and account numbers (detected by `type`, `autocomplete` and field names). These fields are marked `{sensitive}` and their values masked in snapshots. Text with tab characters is refused so focus cannot jump into such a field. The chat watcher applies the same check.
- **The audit trace no longer stores typed text**, only its length.
- **All page-derived text is wrapped as untrusted** (`<page_content trust="untrusted">`): snapshots, `find`, `element_at`, `cursor`, `watch`, `console`, `events`, `eval` and the events/snapshot appended to action results. A page cannot close the delimiter early.
- **Pages can no longer replace the agent's perception or overlay.** `window.__agentPerc` and `window.__agentCursor` are frozen, non-writable and non-configurable. The human-handoff banner only accepts trusted clicks, and the agent's own click tools refuse to press it.

### Changed (may break existing setups)
- `browser_eval` is **off by default**. Set `AGENT_ALLOW_EVAL=1` to enable it. Even then it refuses expressions that mention passwords, one-time codes or card fields.
- `browser_upload` only accepts files inside `AGENT_UPLOAD_DIRS` (default: the agent's downloads folder). Paths are resolved through symlinks.
- `AGENT_DIALOGS` now defaults to `dismiss`. The dialog text is still reported to the agent in the events.
- HTTP clients must send the token. `examples/python_client.py` reads it from `~/.agentic-browser/http-token` automatically.

### Added
- `test/security.test.js` (`npm run test:security`, also part of `npm test`).

## [1.0.1] - 2026-10-16

### Fixed
- Pages opened by websites on their own (Google One Tap sign-in, ad or `about:blank` popups) no longer hijack the agent's active tab. A new page only becomes active when the active tab opened it within ~2 s of an agent input action (click, type, press, drag, select, upload), or when the agent creates it with `browser_tabs action:new`. Any other page is reported as a `background-tab` event and the active tab stays put.
- When the active tab closes, the agent now returns to the tab that opened it, then to the previously active tab, and only then to the last open tab (previously it always jumped to the last tab).
- `browser_tabs action:select` with a non-existent index now returns a clear error.

## [1.0.0] - 2026-10-15

### Added
- Initial release: an agentic browser on top of your real Chrome (or another Chromium browser) driven over CDP.
- MCP server (stdio) and an HTTP API exposing the same tool registry.
- 27 `browser_*` tools: navigation, history, snapshot, find, element-at, click, type, press, scroll, drag, select, upload, read, eval, wait, watch, tabs, console, events, trace, screenshot, recording and more.
- Token-cheap text perception: compact snapshots with refs, roles, states and pixel coordinates, diff mode, iframe and open shadow DOM support.
- Visible red agent cursor with smooth movement, click ripples and annotations.
- Human handoff (`browser_request_human`) for logins, 2FA, CAPTCHAs and decisions.
- Zero-token waiting with `browser_watch` (MutationObserver and title changes).
- Video recording of the active tab (MP4 with ffmpeg, WebM otherwise).
- Optional chat watcher with observe / draft / auto policies, a contact whitelist and hourly limits.
