# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

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
