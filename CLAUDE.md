# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Zone is a distraction-free PDF reader: a Tauri v2 (Rust) desktop shell around a
React 19 + TypeScript + Vite frontend, rendering with pdf.js. Local files only,
no network calls anywhere.

## Commands

```sh
npm run tauri dev            # the real app; frontend hot-reloads, Rust does not
npm run dev                  # frontend only, in a browser (see "Two runtimes")
npm run build                # tsc --noEmit equivalent + vite build
npx tsc --noEmit             # typecheck alone; fast inner loop
npm run tauri build          # .app + .dmg into src-tauri/target/release/bundle

cd src-tauri && cargo check  # Rust typecheck (~2min cold, ~8s warm)
cd src-tauri && cargo build  # debug binary at src-tauri/target/debug/zone
```

Requires `rustup` and Xcode command line tools. If `cargo` is missing from PATH,
it is at `~/.cargo/bin`.

There is **no test framework in this repo**. Do not invent test commands — see
"Verifying changes" for how this code is actually checked.

## Two runtimes, one frontend

The frontend runs in two places, and this shapes the whole codebase:

1. **The OS WebView** (WKWebView on macOS) under `npm run tauri dev`.
2. **A plain browser** under `npm run dev` — `src/lib/bridge.ts` detects the
   absence of `__TAURI_INTERNALS__` and substitutes `fetch` for disk reads and
   `localStorage` for persistence. `public/sample.pdf` is the fixture;
   `http://localhost:1420/?pdf=/sample.pdf` opens it directly.

**Every `@tauri-apps/api` call must go through `src/lib/bridge.ts`.** The window
and webview helpers read `__TAURI_INTERNALS__` eagerly and *throw synchronously*
outside the shell — calling one from a component unmounts the React tree and
leaves a blank page with only a generic React warning. `bridge.ts` is the single
guarded boundary; add new native calls there, never at the point of use.

Browser behaviour is **not** proof of native behaviour. The reverse of the usual
assumption applies here: Chrome is the permissive environment, the WebView is
the strict one.

## WebView engine constraints (read before touching pdf.js)

WKWebView's JS engine is pinned to the installed Safari, not to your dev Chrome.
pdf.js 5 fails on macOS 14 twice — `Promise.try` (Safari 18) hangs the worker
handshake, and `Uint8Array.prototype.toHex` (Safari 18.2) throws in the parser.
**Both are silent:** blank window, and the WebView console is unreachable from a
terminal. The mitigations are load-bearing:

- **pdf.js is pinned to 4.x.** Upgrading to 5 will break the native app while
  leaving `npm run dev` working perfectly.
- **The worker is wrapped, not `workerSrc`.** `src/lib/pdf.worker.ts` imports
  `src/lib/polyfills.ts` and *then* the real worker, because a worker has its own
  global scope and main-thread polyfills never reach it. `pdf.ts` passes that
  `Worker` to `PDFWorker.fromPort` (v4 has no `PDFWorker.create`; the bundled
  `.d.ts` types the constructor's params as null-only, hence the factory).
- **`optimizeDeps.exclude`** keeps Vite from pre-bundling the worker entry as a
  dependency, which breaks its module scope.
- **esbuild and Rollup target `safari15`**, not esnext.
- `worker.onerror` is wired and `worker.promise` is awaited before parsing, so a
  load failure reports instead of hanging forever.

Pinch-zoom splits the same way, and **only the WebView path matters in the real
app**. Blink synthesises trackpad pinch as a `wheel` event with `ctrlKey: true`;
WebKit does not — it fires its own `gesturestart` / `gesturechange` / `gestureend`
carrying a cumulative `e.scale`, and without `preventDefault()` on all three
WKWebView zooms the entire window instead of the document. `Reader.tsx` wires
both families; the `wheel` path is what you can exercise in `npm run dev`, the
gesture path can only be tested natively.

## The Rust/JS boundary

Rust owns *all* disk access, via four commands in `src-tauri/src/lib.rs`:
`pick_pdf`, `read_file`, `load_state`/`save_state` (plus `dbg`, below).

Consequences worth preserving:

- Because the file dialog is driven from Rust, **the webview holds no filesystem
  capability at all**. `src-tauri/capabilities/default.json` grants only
  `core:default` plus three window permissions. Calling a Tauri *plugin* from JS
  requires adding its permission there; calling your own `#[tauri::command]`
  does not. Prefer a new Rust command over widening capabilities.
- `read_file` returns `tauri::ipc::Response` so bytes travel as a binary payload
  rather than a JSON number array. Don't "simplify" it to `Vec<u8>`.
- `load_state`/`save_state` treat the library as an **opaque string** — the
  frontend owns the schema (`Persisted` in `src/lib/store.ts`). Saves go through
  a temp file and `rename` so a crash cannot truncate the library. State lives at
  `~/Library/Application Support/com.zone.reader/library.json`.
- `initial_path` reads argv, which is also where a macOS "Open With" hand-off
  will land once the bundle declares a file association.

## Reader layout maths

`src/components/Reader.tsx` is where the non-obvious logic lives.

- **Page heights are computed up front, not measured.** Page 1's aspect ratio is
  assumed for every page so placeholders appear instantly, then real ratios
  stream in from a background loop that batches `setRatios` every 40 pages.
- Those heights build a **`tops[]` array** (scroll offset of each page top),
  which serves three purposes: binary search from scroll offset → current page,
  exact targets for page jumps, and bookmark anchoring.
- **`GAP`, `PAD_TOP`, `PAD_X`, `MAX_PAGE_WIDTH` are duplicated between TS and the
  DOM on purpose** — they are applied as inline styles on `.pages` precisely so
  `tops[]` cannot drift from the rendered layout. If you move this spacing into
  `styles.css`, `tops[]` silently desynchronises and every jump lands wrong.
- **Bookmarks are `{page, offset-within-page}`**, never a raw scroll offset. The
  offset is written twice: `offset` in px and `frac` as a share of page height.
  Only `frac` survives a zoom change — `offset` is the legacy form, still read
  for library entries written before `frac` existed. Restore runs once per
  document, guarded by the `restored` ref, and uses `behavior: "instant"`.
- The **counter reads a third of the way down the viewport** (the page you are
  looking at) while the **bookmark stays exact at `scrollTop`**. Two anchors, on
  purpose.
- **The `band` decides everything about pixels.** It is the strip worth holding
  rasterised — the viewport plus `BAND_MARGIN` of slack each way — and it alone
  decides both which pages mount a canvas and which slice of a page gets
  rasterised, so the two can never disagree. It replaced a page-count
  `OVERSCAN`; pages outside it are empty sized divs.
  **The band is carried in *page units* (page index plus fraction), not scroll
  pixels, and that is load-bearing.** Page units are exactly what the zoom anchor
  holds still, so the band does not move during a pinch. In pixels it would shift
  every frame and fire a render per frame — precisely what `SETTLE_MS` exists to
  prevent. For the same reason its span is measured against the *settled* page
  height (`renderWidth / pageWidth`), not the live one. Edges snap to `BAND_Q`
  eighths of a page so ordinary scrolling does not re-rasterise.
- **`PageView` is `memo`-wrapped and every prop it takes is a primitive**
  — `progress` changes on every scroll frame, so without that, each frame
  reconciles every page in the document. Passing it an inline object or arrow
  prop would silently undo this. For the same reason `Reader` reads the bookmark
  through `useStore.getState()` rather than a selector: `remember` writes a new
  object at scroll rate.
- **At high zoom only the visible slice of a page is rasterised.** `PageView`
  intersects the band with its own index to get two fractions of page height,
  and cuts the strip by translating the pdf.js viewport (`offsetY`) rather than
  by cropping afterwards; the canvas is `position: absolute` with `top`/`height`
  in *percent*, so the strip tracks the box as zoom changes. Fractions, not
  pixels, throughout — that is what survives a zoom.
  A band wider than a whole page (every page at ordinary zoom) skips slicing
  entirely and renders in one shot, as it always did. Resolution is still capped
  at 2× DPR and by total area (`MAX_BACKING_PX`), but the cap now applies to the
  strip, so a 3× page renders at ~full device resolution instead of the ~1.2×
  the whole-page cap used to force.
- **The canvas is never rendered into directly.** Each pass builds its bitmap on
  a detached canvas and only then resizes, blits and repositions the live one —
  all in one synchronous block. Sizing a live canvas *clears* it, so rendering
  straight into it left a window where the document could be caught blank or
  half-swapped. A slice that has moved (nothing on screen to stretch) gets a
  cheap `PREVIEW_DIVISOR` pass first, so something legible lands immediately.
- **Zoom is local to `Reader` and deliberately not persisted** — it is a reading
  aid, and `App` keys `Reader` by path so every document opens at 1×.
- **`pageWidth` and `renderWidth` are two different things.** The first sizes the
  `.page` box every frame so `tops[]` stays exact; the second lags it by
  `SETTLE_MS` and drives the canvas — rasterising on every gesture frame would
  swamp the worker. While `renderWidth` trails, CSS stretches the old bitmap as a
  free preview.
- **Zoom anchors on a page-relative fraction**, captured before the change and
  applied in a `useLayoutEffect` after the new boxes commit. `applyZoom` is the
  only entry point and skips capture when the value is already clamped, so a
  stale anchor cannot fire on the next resize.
- Horizontal panning needs three things together: `overflow-x: auto`,
  `align-items: flex-start` (flex `center` puts the left overflow out of reach),
  and the JS-computed `padX`. `.pages` also carries a `minWidth` — a scroll
  container will not extend `scrollWidth` for a flex child's overflow, so the
  trailing padding vanishes without it.
- **There is no drag-to-pan.** Left-drag belongs to text selection, which is
  what highlighting is built on. Panning a zoomed page is trackpad or
  shift-scroll only. Do not reintroduce a pointer-drag handler on `.scroller`.

## Text layer and highlights

Selection, and therefore highlighting, needs a pdf.js `TextLayer`. Four things
about it are load-bearing:

- **It is built once, at `getViewport({ scale: 1 })`, and never rebuilt.** With
  the layer's own container as pdf.js's root container, spans are positioned as
  *percentages* of page width and height and sized with
  `calc(var(--scale-factor) * Npx)` — so a zoom costs one custom-property write
  on `.page` and no worker traffic. `--scale-factor` is `pageWidth / baseWidth`
  and tracks `pageWidth`, the live box, not `renderWidth`.
- **Take the container's size back after `render()`.** pdf.js writes an inline
  `round(down, …)` width/height on it, which can land a pixel short of the
  `.page` box; since its spans are percentages *of that container*, the pixel
  shears the whole layer off the bitmap. `PageView` resets both to `100%`.
- **A highlight bar is not DOM — it is painted into the page bitmap.** `PageView`
  fills its rects onto the off-screen buffer with the 2d `darken` composite op,
  right after `page.render()` and before the blit. `darken` keeps the darker of
  page and tint per channel, so paper turns amber and the glyphs stay exactly as
  dark as they were: the bar reads as sitting *behind* the words. It is
  idempotent, so overlapping marks cannot darken each other, and because the
  bars go through `--page-filter` with the rest of the page, **one tint
  (`HL_TINT`) serves all four themes** — the inversion that turns white paper
  dark turns light amber into dark amber for free.
  This replaced two attempts at a `mix-blend-mode` overlay in a sibling `.marks`
  div, and the reason is worth keeping: a CSS blend has to reach across a
  compositing boundary to find the canvas, and **when it cannot, it degrades
  silently to flat opaque paint that hides the text outright.** First a
  `z-index` on `.marks` made it a stacking context and `multiply` became a grey
  wash; then `darken` painted solid yellow slabs over whole lines in the native
  app while looking perfect in Chrome. Inside one 2d context there is no
  boundary to fail at. Do not reintroduce a DOM overlay for the bars.
- **`PageView` subscribes to `highlights[path]` itself** rather than taking the
  rects as a prop. That reference survives the bookmark writes that happen at
  scroll rate, so it re-renders only when a mark really changes — and the props
  stay primitives, which is what keeps `memo` working. The cost is that adding
  or removing a highlight re-rasterises that page; the swap is atomic, so it
  reads as a brief pause rather than a flash.
- **Never derive highlight rects from `range.getClientRects()`.** Once a range
  spans more than one element it also returns a rect per wholly-contained
  block, up to the page-sized containers — highlighting those paints a slab
  over the page. `selectionRects` in `src/lib/highlight.ts` walks the range's
  text nodes instead, which yields line boxes and nothing else.

Two more, outside the layer itself:

- **Highlights are a sibling of `library` in the persisted state, not a field on
  `Bookmark`.** `remember` rebuilds the whole bookmark on every scroll frame, so
  anything nested inside one is overwritten sixty times a second.
- **Overlap is handled at both ends.** The offer pill stays away when a
  selection is already covered end to end (`covers` in `highlight.ts`, sampling
  three points per bar so *extending* a mark still offers), and a click removes
  every group under the cursor rather than the topmost — leaving the others
  behind looks exactly like the click having done nothing.
- `user-select: none` is applied to the chrome, **not** to `body`. WebKit has a
  history of treating an ancestor's `none` as final and ignoring a descendant's
  `text`, and the text layer is the one thing that must stay selectable.

Stored rects are fractions of the page box, like the bookmark's `frac` — the one
form that survives zoom, resize and reopening. A selection crossing a page break
becomes one `Highlight` per page sharing a `group`; removing either removes both.

## Keybindings live in three files

Scroll- and zoom-related keys are in `Reader.tsx`; global ones (theme, focus,
fullscreen, open/close, help) are in `App.tsx`; and the `?` overlay list is hardcoded
in `Keys.tsx`. **Adding a binding means touching all three.** Branch on
`e.shiftKey` rather than on an uppercase `e.key` — some layouts and all synthetic
events report `"g"` + `shiftKey`, not `"G"`.

## Verifying changes

The WebView has no reachable console, and the terminal here lacks Accessibility /
Screen-Recording rights, so the native window cannot be screenshotted or driven
by AppleScript. What works:

- **Dev-only error forwarding.** `src/lib/debug.ts` `report()` pushes webview
  errors to the Rust process's stderr through the `dbg` command, and
  `src/main.tsx` forwards `error` / `unhandledrejection`. This is the only way to
  see a WebView failure headlessly — keep it.
- **Headless native smoke test.** Launch the debug binary with a PDF path and
  watch two files:

  ```sh
  rm -f "$HOME/Library/Application Support/com.zone.reader/library.json"
  nohup ./src-tauri/target/debug/zone /path/to/sample.pdf > app.log 2>&1 & disown
  # library.json gaining an entry proves the whole chain: IPC → pdf.js parse →
  # layout → scroll tracking → atomic persist. app.log carries any failure.
  ```

  Note that a bare `npm run tauri dev` started as a background command gets
  reaped; launch the built binary with `nohup … & disown` instead, and keep the
  Vite dev server running separately.
- **Browser checks for anything visual**, via the fallback above. Watch for
  `document.visibilityState === "hidden"`: a backgrounded tab suspends
  `requestAnimationFrame` and `behavior: "smooth"` scrolling and swallows
  synthetic key events, which looks exactly like broken code. A tab driven by
  browser automation is hidden almost all the time, so any probe that awaits
  `requestAnimationFrame` hangs until the tool times out — wait on `setTimeout`
  instead, and keep the total under the tool's limit since background timers are
  throttled to ~1s too.

  **The same suspension stalls pdf.js itself.** `InternalRenderTask` schedules
  its continuation through `requestAnimationFrame`, so in a hidden tab a render
  large enough to be chunked never finishes: canvases sit at the default
  300x150, with nothing in the console. It looks exactly like a broken render
  path. Take a screenshot to bring the tab forward, *then* read the DOM. And
  because instrumentation cannot live on `window` — `javascript_tool` evaluates
  in an isolated world — route measurements through a `dataset` attribute, or
  observe the DOM directly: a `MutationObserver` on the `width` attribute counts
  rasterisations, since setting `canvas.width` reflects to the attribute.

## Deliberately not built

Reflow mode (extract the text layer, cluster text items by x to detect columns,
strip repeating headers/footers, re-typeset to a 60–75 character measure) is the
intended next major feature and the reason pdf.js is used directly rather than
through a React wrapper — the wrappers hide the viewport and text-item access it
needs. The text layer added for highlighting is a first step toward it. Also
absent: file associations, notes attached to highlights, and outline/TOC. See
the README's "Not built yet".
