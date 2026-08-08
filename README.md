# Zone

A PDF reader that gets out of the way. Native macOS app, local files only, no
account, no sync, no sidebar, no toolbar.

## Run it

```sh
npm install
npm run tauri dev      # dev, with HMR on the frontend
npm run tauri build    # signed-ish .app + .dmg in src-tauri/target/release/bundle
```

Requires Rust (`rustup`) and Xcode command line tools.

## Keys

| | |
|---|---|
| `space` / `j` / `↓` | forward a screen |
| `⇧space` / `k` / `↑` | back a screen |
| `n` / `p` | next / previous page |
| `g` / `⇧g` | start / end |
| `+` `−` `0` | zoom |
| `t` | cycle theme — paper, sepia, dim, black |
| `d` | focus band (dims the top and bottom of the viewport) |
| `f` | fullscreen |
| `o` / `w` | open / close |
| `?` | key list |

Move the pointer and the window shows a hairline progress bar and a page
counter. Leave it still for two seconds and both fade, along with the cursor.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri v2 (Rust) | ~10 MB app, native window, no bundled Chromium |
| UI | React 19 + TypeScript + Vite | Fast HMR, one surface to build |
| PDF | `pdfjs-dist` **4.x** directly | Raw access to viewports and text items; the React wrappers hide what reflow mode will need. Pinned to 4 — see WebView constraints below |
| State | Zustand | Prefs and reading positions, no provider tree |
| Styling | Plain CSS custom properties | Four themes are four blocks of variables; a utility framework buys nothing for a single-surface app |
| Storage | JSON in the app config dir, written by Rust | Atomic write-then-rename; no database for what is a few KB |

Nothing here talks to a network.

## WebView constraints

This is the part that will bite you if you change dependencies.

Tauri renders in the **OS WebView** — WKWebView on macOS — whose JavaScript
engine is pinned to the installed Safari, not to the Chrome you develop against.
pdf.js 5 assumes a 2025-era engine and fails on macOS 14 twice over:

- `Promise.try` (Safari 18) — hangs the worker handshake with no error
- `Uint8Array.prototype.toHex` (Safari 18.2) — throws inside the parser

Both failures are *silent*: a blank window, no console you can reach. Hence:

- **pdf.js is pinned to 4.x**, which targets a much wider engine range.
- **Its worker is wrapped**, not loaded via `workerSrc`. `src/lib/pdf.worker.ts`
  imports `src/lib/polyfills.ts` first and then the real worker, because a
  worker has its own global scope and the main thread's polyfills never reach
  it. `pdf.ts` hands that `Worker` to `PDFWorker.fromPort`.
- **The worker is excluded from Vite's dep optimizer** — pre-bundling a worker
  entry as if it were a dependency breaks its module scope.
- **esbuild and Rollup target `safari15`**, not esnext.
- **Worker `onerror` is wired up** and `worker.promise` is awaited before
  parsing, so a load failure reports instead of hanging.

If you upgrade pdf.js, test in the native window, not just `npm run dev` — the
browser will happily hide all of this.

## Two ways to run the UI

`npm run tauri dev` is the real thing. But `npm run dev` alone also works in a
browser: `src/lib/bridge.ts` detects the absence of `__TAURI_INTERNALS__` and
falls back to `fetch` for files and `localStorage` for state, so the reading
surface can be inspected with devtools. `public/sample.pdf` is a fixture for
this; `http://localhost:1420/?pdf=/sample.pdf` opens it directly.

Everything that touches the native window (title, fullscreen, file drop) is
guarded in `bridge.ts` — the `@tauri-apps/api` window helpers read
`__TAURI_INTERNALS__` eagerly and **throw** outside the shell, which unmounts
the React tree if you call them at the point of use.

In dev, webview errors are forwarded to the Rust process's stderr via the `dbg`
command (`src/lib/debug.ts`), because the OS WebView's console is not reachable
from a terminal.

## How it works

**Files never pass through the frontend's filesystem.** Rust owns disk access
through four commands in `src-tauri/src/lib.rs`:

- `pick_pdf` — native open dialog, returns a path
- `read_file` — returns raw bytes as a binary IPC payload, not a JSON number array
- `load_state` / `save_state` — the library blob, written via a temp file and rename

Because the dialog is driven from Rust, the webview needs no filesystem
capability at all. `src-tauri/capabilities/default.json` grants only
`core:default` plus three window calls.

**Rendering is virtualized.** `Reader.tsx` computes every page's height up front
(page 1's aspect ratio is assumed for all pages so placeholders appear
instantly, then real ratios stream in from a background loop). From those
heights it builds a `tops[]` array, which gives three things cheaply:

- binary search from scroll offset → current page
- exact scroll targets for page-to-page jumps
- a stable bookmark anchor: `{ page, offset-within-page }` rather than a raw
  scroll position, so restoring survives a zoom or window resize

Only pages within the viewport ±2 hold a canvas. Everything else is an empty
sized `div`, so a 600-page book costs the same memory as a 6-page one.

**Dark themes invert the canvas** with `filter: invert() hue-rotate(180deg)`
rather than tinting the background, so black text on white becomes light text
on dark and photographs stay roughly correct.

## Not built yet

- **Reflow mode.** The real prize: extract the text layer, detect columns by
  x-clustering the text items, strip repeating headers/footers, and re-typeset
  into one column at a 60–75 character measure. `pdfjs` gives text runs in draw
  order, not reading order, so this is a genuine algorithm, not a config flag.
  Fixed-layout mode stays as the fallback for scans and heavy math.
- **File associations** — bundle config plus handling macOS `RunEvent::Opened`
  so double-clicking a PDF opens Zone.
- **Annotations** — highlights keyed to text-item indices, stored next to the
  bookmark.
- **Outline / table of contents** — `doc.getOutline()`, shown only on a keypress.
