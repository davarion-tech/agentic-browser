# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Privacy mask for recordings and screen sharing.** `browser_cursor_style({ privacy: "whatsapp" })` (or `AGENT_PRIVACY=whatsapp`) blurs the chat list, the open chat's header and profile photos on WhatsApp Web, so a demo or a shared screen never shows contacts or numbers. Presets: `whatsapp`, `telegram`, `gmail` (each only on its own domain); any other value is a CSS selector applied on every page; `"off"` removes it. Only people see the blur: the agent still reads the page. Pages opened afterwards are blurred before they paint.
- **Watcher: watched chats only.** `contacts` limits the watcher to the chats you name. A message from anyone else doesn't wake the model, and before typing the watcher checks the open chat's title in the page, so it can't write in another chat whatever the model says. Safe to run on an account that also has personal chats.
- **Watcher: on-screen notices.** A card in the agent's browser for every wake, draft ("review it and press Send"), send, escalation ("I didn't reply: your call") and block. Names are hidden when the privacy mask is on. `notifyOnScreen: false` turns them off.
- **Watcher: a video per event.** `record: true` saves each wake-up, from the new message to the draft or escalation, as its own clip.

## [1.2.0] - 2026-10-21

### Added
- **Teach mode.** `browser_teach_start` / `browser_teach_stop` record a task the person performs once in the agent's Chrome (clicks, typed text, selects, Enter, typed URLs) behind a "Recording" banner with Finish/Cancel buttons. Steps are stored as recipes (`~/.agentic-browser/recipes`, `AGENT_RECIPES`) by role, name, id, href or field name instead of pixels. Typed text becomes a parameter with the recorded value as default. Password and one-time-code fields are never recorded.
- `browser_replay` repeats a recipe with new `params`, locating each element again across frames and without perceiving the page at every step. Secret fields are handed to the person with `browser_request_human`. It stops at the first step it cannot complete and says which one.
- `browser_recipes` lists recipes or shows one with its steps and parameters.
- `browser_extract` returns the most relevant table or repeated list as JSON or CSV rows (title, url, price, image, text for lists; one column per header for tables, with rowspan/colspan and footnote marks resolved). It can save to disk (`file`, `AGENT_EXPORTS`). CSV output escapes quotes and neutralizes spreadsheet formulas.
- Live token counter: `browser_cursor_style({ hud: true })` or `AGENT_HUD=1` draws a corner panel with tokens used, the screenshot equivalent and the ratio. `browser_stats` returns the same numbers.
- `browser_extract` joins the `core` tool set (13 tools).
- `AGENT_VIEWPORT` to fix the page size (for example `1280x800`).
- Floating "Enseñar" button on the left edge of the agent's Chrome: the person starts a recording without the agent, names it in the banner and presses Finish; the recipe is saved, a toast confirms it and the agent gets a `recipe-saved` event. `AGENT_TEACH_BUTTON=0` hides it.
- `browser_dismiss` and an automatic pass after `browser_navigate` (plus one more before the next perception) close website popups through their close or reject button, never accept, subscribe or sign in. `AGENT_AUTO_DISMISS=0` turns it off.
- Chrome starts without the translate bar, the search-engine choice screen, the restore-pages bubble and permission prompts (denied).
- `browser_batch` runs up to 30 actions in one call, in order, and stops at the first error.
- `AGENT_SPEED=fast|normal|demo` presets for cursor travel, typing delay and settle time.
- `browser_type` keeps the focused field on screen before and after typing, so the person watching sees the text appear.
- The token HUD is now a compact pill that switches to the other bottom corner when the agent's cursor comes near.

### Security
- Teach mode cannot be driven by web pages: the page-to-server channel is captured before page scripts run, every message is signed with a per-launch token that only our injected scripts know, and only trusted (real) input events are recorded. Banner and button clicks must be trusted too.
- Secret detection for recordings uses the same rules as the 1.1.0 typing block (password, one-time code, card, account and PIN fields): their values are never recorded and replay hands them to the person.
- Everything the new tools return that comes from a page (extracted rows, recipe steps, replay log, batch results, closed popups) is wrapped as untrusted content. The audit trace hides typed text inside `browser_batch` and the values of `browser_replay` params.

### Fixed
- The cursor, banners and HUD did not render on sites that enforce Trusted Types (Google Docs, Gmail, YouTube). The overlay no longer uses `innerHTML`.
- With a visible window, the browser no longer overflows small or scaled screens: Chrome opens maximized and the page follows the real window size instead of a fixed 1280×800.

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
