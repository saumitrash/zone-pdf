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

type Props = { doc: PdfDoc; path: string; title: string };

export function Reader({ doc, path, title }: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const zoom = useStore((s) => s.zoom);
  const focus = useStore((s) => s.focus);
  const remember = useStore((s) => s.remember);
  const bookmark = useStore((s) => s.library[path]);

  const count = doc.numPages;
  const [containerWidth, setContainerWidth] = useState(0);
  /** Intrinsic page sizes at scale 1; index 0 is filled first, rest stream in. */
  const [ratios, setRatios] = useState<number[]>([]);
  const [current, setCurrent] = useState(bookmark?.page ?? 0);
  const [progress, setProgress] = useState(0);
  const restored = useRef(false);

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

  const pageWidth = useMemo(() => {
    const fit = Math.min(containerWidth - PAD_X * 2, MAX_PAGE_WIDTH);
    return Math.max(240, Math.round(fit * zoom));
  }, [containerWidth, zoom]);

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

  // --- restore the saved position once placeholders exist -------------------
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || restored.current || !tops.length || !pageWidth) return;
    restored.current = true;
    if (!bookmark) return;
    const top = (tops[Math.min(bookmark.page, tops.length - 1)] ?? 0) + bookmark.offset;
    el.scrollTo({ top, behavior: "instant" as ScrollBehavior });
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
        remember(path, {
          page,
          offset: Math.round(y - tops[page]),
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
  }, [tops, pageAt, path, title, count, remember]);

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
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tops, pageAt]);

  // --- which pages carry a canvas ------------------------------------------
  const visible = useMemo(() => {
    const el = scrollerRef.current;
    const viewport = el?.clientHeight ?? 900;
    const first = pageAt(Math.max(0, (el?.scrollTop ?? 0)));
    const last = pageAt((el?.scrollTop ?? 0) + viewport);
    return { from: Math.max(0, first - OVERSCAN), to: Math.min(count - 1, last + OVERSCAN) };
  }, [current, pageAt, count]);

  return (
    <>
      <div className="scroller" ref={scrollerRef}>
        <div
          className="pages"
          style={{ gap: GAP, padding: `${PAD_TOP}px ${PAD_X}px 60vh` }}
        >
          {heights.map((h, i) => (
            <PageView
              key={i}
              doc={doc}
              index={i}
              width={pageWidth}
              height={h}
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
