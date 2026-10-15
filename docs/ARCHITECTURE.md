# Architecture

## How chrome.exe works (and why we don't fork it)

Measured live on Chrome 155.0.8059.40 for Windows:

| Piece | What it is |
|---|---|
| `chrome.exe` (4.4 MB) | A launcher. It reads the command line, decides which process type to become, and loads the DLL. |
| `chrome.dll` (291 MB) | The whole browser: Blink (rendering), V8 (JavaScript), networking, storage, UI, DevTools. |
| `resources.pak`, `icudtl.dat`, V8 snapshot | Resources, Unicode data, and a precompiled V8 heap. |

Opening a single tab starts about 13 `chrome.exe` processes, each with a different `--type=`:

```
browser            root process: windows, tabs, profile; coordinates the rest (no sandbox)
renderer  ×N       one per site (Site Isolation): Blink + V8, strictly sandboxed
gpu-process        compositing and rasterization on the GPU
utility network.mojom.NetworkService   all networking (HTTP, DNS, TLS, cookies)
utility storage.mojom.StorageService   IndexedDB, localStorage, cache
crashpad-handler   crash reporting
```

The processes talk over **Mojo** IPC. A human click travels OS → browser process → IPC → renderer (Blink hit-test) → DOM event → JavaScript.

**Chrome DevTools Protocol (CDP)** is the official door for automation. With `--remote-debugging-port`, the browser process exposes a JSON-RPC WebSocket. `Input.dispatchMouseEvent` / `dispatchKeyEvent` inject events at the same point a real mouse enters the pipeline, so pages receive `isTrusted = true` events. `Runtime.evaluate` runs JavaScript in any frame. `Page`, `Target`, `Network` and `Accessibility` cover navigation, tabs, network and the accessibility tree.

Forking Chromium means tens of GB of source and hours per build, and you lose automatic security updates. CDP already gives agents everything they need. agentic-browser drives your installed Chrome unmodified, so you keep extensions, codecs, PDF viewer, WebGPU and updates.

## Components

```
 Agent (Claude, GPT, Hermes, OpenClaw, script…)          Human (optional, watches)
        │ MCP stdio  ─or─  HTTP JSON                              │
        ▼                                                         ▼
 ┌──────────────────────────────┐   CDP (WebSocket)   ┌────────────────────────────┐
 │ src/mcp.js   src/http.js     │ ──────────────────▶ │ chrome.exe (your Chrome)   │
 │ src/tools.js  tool registry  │                     │  ├ overlay.js   → cursor,  │
 │   + read-only, loop detector,│                     │  │   handoff banner        │
 │     trace, tool subsets      │ ◀── events ──────── │  └ perception.js → refs,   │
 │ src/browser.js tabs, frames, │   console, dialogs, │      pixel coords, diff,   │
 │   cursor path, watch, origin │   downloads, tabs   │      shadow DOM, occlusion │
 │   allowlist, serial queue    │                     └────────────────────────────┘
 └──────────────────────────────┘
```

- **`src/perception.js`** runs inside each document. It walks the DOM, including open shadow roots, and assigns stable `ref` ids. For each element it computes the center in viewport CSS pixels and flags elements covered by something else (`occluded`). It keeps role + name per ref, so a ref invalidated by a re-render can be relocated when the match is unique. Frames are walked too (refs `f1:7`), with coordinates translated to the main viewport.
- **`src/overlay.js`** listens to the real `mousemove`/`mousedown` events that CDP produces and draws the cursor, trail, click ripple and action label. It lives in a closed shadow root with `pointer-events:none`, so it never intercepts clicks or appears in snapshots. It also hosts the human-handoff banner, the only clickable part.
- **`src/browser.js`** moves the mouse along an eased Bézier curve with dozens of intermediate events, so hover menus and drag-and-drop behave as with a person. `watch()` installs a `MutationObserver` and also polls the page title, so waiting costs zero tokens.
- **`src/tools.js`** is the single tool registry used by both servers. A common wrapper adds read-only mode, the repeated-action warning and the JSONL audit trace.
- Actions are **serialized**: there is one mouse and one keyboard, even when an agent issues calls in parallel.

## Token budget

| Perception | Typical cost |
|---|---|
| Screenshot (1280×800) | ~1,000–1,500 tokens per look |
| `browser_snapshot`, small page | ~120–150 tokens |
| `browser_snapshot`, link-heavy page (Wikipedia home) | ~1,300 tokens |
| `browser_snapshot` with `diff: true` after an action | only the changed lines |
| `browser_element_at` | ~100 tokens |
