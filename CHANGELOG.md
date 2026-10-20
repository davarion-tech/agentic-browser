# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-20

### Added
- **Teach mode.** `browser_teach_start` / `browser_teach_stop` record a task the person performs once in the agent's Chrome (clicks, typed text, selects, Enter, typed URLs) behind a "Recording" banner with Finish/Cancel buttons. Steps are stored as recipes (`~/.agentic-browser/recipes`, `AGENT_RECIPES`) by role, name, id, href or field name instead of pixels. Typed text becomes a parameter with the recorded value as default. Password and one-time-code fields are never recorded.
- `browser_replay` repeats a recipe with new `params`, locating each element again across frames and without perceiving the page at every step. Secret fields are handed to the person with `browser_request_human`. It stops at the first step it cannot complete and says which one.
- `browser_recipes` lists recipes or shows one with its steps and parameters.
- `browser_extract` returns the most relevant table or repeated list as JSON or CSV rows (title, url, price, image, text for lists; one column per header for tables, with rowspan/colspan and footnote marks resolved). It can save to disk (`file`, `AGENT_EXPORTS`). CSV output escapes quotes and neutralizes spreadsheet formulas.
- Live token counter: `browser_cursor_style({ hud: true })` or `AGENT_HUD=1` draws a corner panel with tokens used, the screenshot equivalent and the ratio. `browser_stats` returns the same numbers.
- `browser_extract` joins the `core` tool set (13 tools).
- `AGENT_VIEWPORT` to fix the page size (for example `1280x800`).
- `browser_batch` runs up to 30 actions in one call, in order, and stops at the first error.
- `AGENT_SPEED=fast|normal|demo` presets for cursor travel, typing delay and settle time.
- `browser_type` keeps the focused field on screen before and after typing, so the person watching sees the text appear.
- The token HUD is now a compact pill that switches to the other bottom corner when the agent's cursor comes near.

### Fixed
- The cursor, banners and HUD did not render on sites that enforce Trusted Types (Google Docs, Gmail, YouTube). The overlay no longer uses `innerHTML`.
- With a visible window, the browser no longer overflows small or scaled screens: Chrome opens maximized and the page follows the real window size instead of a fixed 1280×800.

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
