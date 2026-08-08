import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PdfDoc } from "../lib/pdf";
import { useStore } from "../lib/store";
import { PageView } from "./PageView";

/** Must stay in sync with the inline styles below — layout maths depends on it. */
const GAP = 18;
const PAD_TOP = 56;
const PAD_X = 24;
/** Widest a page gets at zoom 1. Beyond this, lines are too long to track. */
const MAX_PAGE_WIDTH = 860;
/** Pages rendered outside the viewport, each direction. */
const OVERSCAN = 2;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
/** How long the gesture must rest before the canvases rasterise at the new size. */
const SETTLE_MS = 140;

/** WebKit's non-standard pinch events; not in lib.dom. */
type GestureEvent = Event & { scale: number; clientX: number; clientY: number };

/** What sat under the cursor when a zoom began, in zoom-invariant terms. */
type Anchor = { page: number; fy: number; fx: number; cx: number; cy: number };

type Props = { doc: PdfDoc; path: string; title: string };

export function Reader({ doc, path, title }: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const focus = useStore((s) => s.focus);
  const remember = useStore((s) => s.remember);
  // Read once at open, deliberately unsubscribed: `remember` writes a fresh
  // bookmark object on every scroll frame, so selecting it here would re-render
  // the whole reader at scroll rate for a value only the restore effect uses.
  const [bookmark] = useState(() => useStore.getState().library[path]);

  const count = doc.numPages;
  const [containerWidth, setContainerWidth] = useState(0);
  /** Intrinsic page sizes at scale 1; index 0 is filled first, rest stream in. */
  const [ratios, setRatios] = useState<number[]>([]);
  const [current, setCurrent] = useState(bookmark?.page ?? 0);
  const [progress, setProgress] = useState(0);
  const restored = useRef(false);

  // Zoom is a reading aid, not a preference: local, unpersisted, and reset for
  // every document because App keys this component by path.
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** Trails `zoom`; see the `renderWidth` prop on PageView for why. */
  const [renderZoom, setRenderZoom] = useState(1);

  // --- intrinsic page aspect ratios (height / width) -------------------------
  useEffect(() => {
    let cancelled = false;
    setRatios([]);
    restored.current = false;

    (async () => {
      const first = await doc.getPage(1);
      if (cancelled) return;
      const vp = first.getViewport({ scale: 1 });
      const base = vp.height / vp.width;
      // Assume uniform to get placeholders instantly, then correct in the background.
      const all = new Array<number>(count).fill(base);
      setRatios(all);

      for (let i = 1; i < count; i++) {
        const page = await doc.getPage(i + 1);
        if (cancelled) return;
        const v = page.getViewport({ scale: 1 });
        all[i] = v.height / v.width;
        if (i % 40 === 0) setRatios([...all]);
      }
      if (!cancelled) setRatios([...all]);
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, count]);

  // --- container width ------------------------------------------------------
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const widthAt = useCallback(
    (z: number) => {
      const fit = Math.min(containerWidth - PAD_X * 2, MAX_PAGE_WIDTH);
      return Math.max(240, Math.round(fit * z));
    },
    [containerWidth],
  );

  const pageWidth = useMemo(() => widthAt(zoom), [widthAt, zoom]);
  const renderWidth = useMemo(() => widthAt(renderZoom), [widthAt, renderZoom]);

  // Rasterising on every gesture frame would blank the canvases (setting
  // canvas.width clears them), so let the zoom come to rest first.
  useEffect(() => {
    const t = setTimeout(() => setRenderZoom(zoom), SETTLE_MS);
    return () => clearTimeout(t);
  }, [zoom]);

  /**
   * Side padding centres the page while it fits, and holds at PAD_X once it does
   * not — flex `align-items: center` would put the left overflow out of reach.
   * Doubles as the page's exact left edge for the zoom anchor.
   */
  const padX = useMemo(
    () => Math.max(PAD_X, Math.round((containerWidth - pageWidth) / 2)),
    [containerWidth, pageWidth],
  );
  const pannable = containerWidth > 0 && pageWidth + PAD_X * 2 > containerWidth;
  const pannableRef = useRef(pannable);
  pannableRef.current = pannable;

  const heights = useMemo(
    () => ratios.map((r) => Math.round(pageWidth * r)),
    [ratios, pageWidth],
  );

  /** Scroll offset of the top of each page. */
  const tops = useMemo(() => {
    const out = new Array<number>(heights.length);
    let y = PAD_TOP;
    for (let i = 0; i < heights.length; i++) {
      out[i] = y;
      y += heights[i] + GAP;
    }
    return out;
  }, [heights]);

  const pageAt = useCallback(
    (y: number) => {
      let lo = 0;
      let hi = tops.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tops[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [tops],
  );

  // --- zoom anchored to a point ---------------------------------------------
  const anchor = useRef<Anchor | null>(null);

  /** Note what sits under (cx, cy) as page-relative fractions, which zoom cannot change. */
  const capture = useCallback(
    (cx: number, cy: number) => {
      const el = scrollerRef.current;
      if (!el || !tops.length) return;
      const r = el.getBoundingClientRect();
      const y = el.scrollTop + (cy - r.top);
      const p = pageAt(y);
      anchor.current = {
        page: p,
        fy: (y - tops[p]) / (heights[p] || 1),
        fx: (el.scrollLeft + (cx - r.left) - padX) / pageWidth,
        cx,
        cy,
      };
    },
    [tops, heights, pageAt, padX, pageWidth],
  );
  // Gesture listeners are attached once, so they reach `capture` through a ref.
  const captureRef = useRef(capture);
  captureRef.current = capture;

  // Runs after the new page boxes are committed but before paint, so the point
  // under the cursor never visibly moves.
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollerRef.current;
    if (!a || !el || !tops.length) return;
    anchor.current = null;
    const r = el.getBoundingClientRect();
    const p = Math.min(a.page, tops.length - 1);
    el.scrollTop = tops[p] + a.fy * (heights[p] || 0) - (a.cy - r.top);
    el.scrollLeft = padX + a.fx * pageWidth - (a.cx - r.left);
  }, [pageWidth, padX, tops, heights]);

  /**
   * The one way zoom changes. Anchors first, and only when the zoom really moves
   * — capturing at the clamp limits would leave a stale anchor for the next
   * resize to act on. Advancing the ref eagerly lets gesture frames compound
   * correctly within a single React batch.
   */
  const applyZoom = useCallback((next: (z: number) => number, cx: number, cy: number) => {
    const z = clampZoom(next(zoomRef.current));
    if (z === zoomRef.current) return;
    captureRef.current(cx, cy);
    zoomRef.current = z;
    setZoom(z);
  }, []);
  const applyZoomRef = useRef(applyZoom);
  applyZoomRef.current = applyZoom;

  /** Zoom about the middle of the viewport — for the keyboard, which has no cursor. */
  const zoomFromCentre = useCallback(
    (next: (z: number) => number) => {
      const el = scrollerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      applyZoom(next, r.left + r.width / 2, r.top + r.height / 2);
    },
    [applyZoom],
  );

  // --- restore the saved position once placeholders exist -------------------
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || restored.current || !tops.length || !pageWidth) return;
    restored.current = true;
    if (!bookmark) return;
    const p = Math.min(bookmark.page, tops.length - 1);
    // `offset` is px at whatever zoom the mark was taken at; `frac` survives it.
    const within = bookmark.frac != null ? bookmark.frac * (heights[p] || 0) : bookmark.offset;
    el.scrollTo({ top: (tops[p] ?? 0) + within, behavior: "instant" as ScrollBehavior });
    setCurrent(bookmark.page);
    // bookmark is intentionally read once, at open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tops.length, pageWidth]);

  // --- scroll tracking ------------------------------------------------------
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !tops.length) return;
    let frame = 0;

    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = el.scrollTop;
        // The counter should name the page you are looking at, so it reads a
        // third of the way down the viewport. The bookmark stays exact.
        setCurrent(pageAt(y + el.clientHeight / 3));
        const span = el.scrollHeight - el.clientHeight;
        setProgress(span > 0 ? Math.min(1, y / span) : 0);
        const page = pageAt(y);
        const within = y - tops[page];
        remember(path, {
          page,
          offset: Math.round(within),
          frac: heights[page] ? within / heights[page] : 0,
          title,
          pages: count,
          lastOpened: Date.now(),
        });
      });
    };

    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [tops, heights, pageAt, path, title, count, remember]);

  // --- pointer: pinch, modifier-wheel, drag-to-pan --------------------------
  // Attached once and reaching state through refs, so a re-render mid-gesture
  // cannot tear the listeners down and lose the gesture's baseline.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // A bare wheel is still scrolling; only modified wheels zoom.
      if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
      e.preventDefault();
      // Both engines remap shift+wheel onto deltaX for a real mouse.
      const d = e.shiftKey && e.deltaY === 0 ? e.deltaX : e.deltaY;
      // Trackpad pinch arrives in small deltas; a mouse notch is ~100.
      const rate = e.ctrlKey ? 0.01 : 0.0025;
      // Exponential, so a notch is the same ratio at 0.5x as at 4x.
      applyZoomRef.current((z) => z * Math.exp(-d * rate), e.clientX, e.clientY);
    };

    // WebKit does not synthesise ctrl+wheel for trackpad pinch the way Blink
    // does — in the real app this is the only path that fires. Without the
    // preventDefault, WKWebView zooms the whole window instead.
    let base = 1;
    const onGestureStart = (ev: Event) => {
      // Only the baseline: `e.scale` is cumulative over the gesture. Anchoring
      // is left to onGestureChange, which knows the zoom actually moved.
      ev.preventDefault();
      base = zoomRef.current;
    };
    const onGestureChange = (ev: Event) => {
      ev.preventDefault();
      const e = ev as GestureEvent;
      applyZoomRef.current(() => base * e.scale, e.clientX, e.clientY);
    };
    const onGestureEnd = (ev: Event) => ev.preventDefault();

    // Drag to pan, but only while the page is wider than the window: otherwise
    // a stray click-and-twitch would shove the document around.
    const drag = { on: false, x: 0, y: 0 };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || !pannableRef.current) return;
      drag.on = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      el.dataset.panning = "true";
      el.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!drag.on) return;
      el.scrollLeft -= e.clientX - drag.x;
      el.scrollTop -= e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!drag.on) return;
      drag.on = false;
      delete el.dataset.panning;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  // --- keyboard navigation --------------------------------------------------
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const step = (dir: 1 | -1) =>
      el.scrollBy({ top: dir * el.clientHeight * 0.9, behavior: "smooth" });
    const toPage = (i: number) => {
      const target = Math.max(0, Math.min(tops.length - 1, i));
      el.scrollTo({ top: tops[target] ?? 0, behavior: "smooth" });
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
          break;
        case "j":
        case "ArrowDown":
          e.preventDefault();
          step(1);
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          step(-1);
          break;
        case "ArrowRight":
        case "n":
          e.preventDefault();
          toPage(pageAt(el.scrollTop) + 1);
          break;
        case "ArrowLeft":
        case "p":
          e.preventDefault();
          toPage(pageAt(el.scrollTop) - 1);
          break;
        // Some layouts and synthetic events report "g" + shiftKey rather than
        // "G", so branch on the modifier instead of the character.
        case "g":
        case "G":
          e.preventDefault();
          el.scrollTo({ top: e.shiftKey ? el.scrollHeight : 0, behavior: "smooth" });
          break;
        case "+":
        case "=":
          zoomFromCentre((z) => z * 1.1);
          break;
        case "-":
        case "_":
          zoomFromCentre((z) => z / 1.1);
          break;
        case "0":
          zoomFromCentre(() => 1);
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tops, pageAt, zoomFromCentre]);

  // --- which pages carry a canvas ------------------------------------------
  const visible = useMemo(() => {
    const el = scrollerRef.current;
    const viewport = el?.clientHeight ?? 900;
    const top = el?.scrollTop ?? 0;
    const first = pageAt(Math.max(0, top));
    const last = pageAt(top + viewport);
    // Canvases grow with the square of the zoom; keep fewer of them alive.
    const over = zoom > 2 ? 1 : OVERSCAN;
    return { from: Math.max(0, first - over), to: Math.min(count - 1, last + over) };
  }, [current, pageAt, count, zoom]);

  return (
    <>
      <div className="scroller" ref={scrollerRef} data-pannable={pannable}>
        <div
          className="pages"
          // min-width so the trailing padding survives: a scroll container does
          // not extend its scrollWidth for a flex child's overflow past it.
          style={{
            gap: GAP,
            padding: `${PAD_TOP}px ${padX}px 60vh`,
            minWidth: pageWidth + padX * 2,
          }}
        >
          {heights.map((h, i) => (
            <PageView
              key={i}
              doc={doc}
              index={i}
              width={pageWidth}
              height={h}
              renderWidth={renderWidth}
              active={i >= visible.from && i <= visible.to}
            />
          ))}
        </div>
      </div>

      <div className="spotlight" data-on={focus} />

      <div className="chrome progress">
        <i style={{ transform: `scaleX(${progress})` }} />
      </div>
      <div className="chrome counter">
        {current + 1} / {count}
      </div>
    </>
  );
}
