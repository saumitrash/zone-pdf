import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  covers,
  hits,
  mergeRects,
  pageBoxes,
  pointOnPage,
  rectsBySelection,
  selectionRects,
} from "../lib/highlight";
import { useStore, type Highlight, type Rect } from "../lib/store";

/** How long a selection must hold still before offering to highlight it. */
const OFFER_MS = 500;
/** Keep the pill this far inside the window. */
const EDGE = 8;
/** Gap between the pill and the thing it points at. */
const LIFT = 10;

/**
 * Where to point the pill, given a selection.
 *
 * The *first on-screen* client rect, not the range's bounding box: a passage
 * dragged across a page break — or simply scrolled so it starts above the
 * window — has a bounding box whose top is off-screen entirely, and a pill
 * anchored there would have nothing to point at.
 */
function anchorOf(sel: Selection): { cx: number; cy: number } | null {
  const rects = selectionRects(sel);
  if (!rects.length) return null;
  const onScreen = rects.filter((r) => r.bottom > 0 && r.top < window.innerHeight);
  const visible = onScreen.length ? onScreen : rects;
  // Centred over the widest visible line rather than the first: a pill hanging
  // off the ragged start of a paragraph reads as misplaced.
  const wide = visible.reduce((a, b) => (b.width > a.width ? b : a));
  return { cx: wide.left + wide.width / 2, cy: visible[0].top };
}

/**
 * Which of its two jobs the pill is doing, and what it needs to do it.
 *
 * Note what is *not* here: a viewport position. The pill re-derives where to
 * sit on every render, from the live selection or from the page box the
 * highlight lives on, so it follows its anchor through a scroll instead of
 * hanging in space where the text used to be.
 *
 * The "add" pill does carry the rectangles it was armed with, rather than
 * reading the selection back when the button is pressed: by then focus has
 * moved and the live selection is not something to rely on.
 *
 * "remove" carries every group under the cursor, not just the topmost one.
 */
type Pill =
  | { mode: "add"; marks: Map<number, Rect[]>; text: string }
  | { mode: "remove"; groups: string[]; page: number; rect: Rect };

type Props = { scroller: React.RefObject<HTMLDivElement | null>; path: string };

/**
 * Selection → highlight, and click → remove.
 *
 * Kept out of Reader's body on purpose: Reader re-renders on every scroll
 * frame, and none of this should ride along on that path. The pill is
 * `position: fixed` and lives outside `.page`, which is `overflow: hidden` and
 * would otherwise clip it.
 */
export function Highlighter({ scroller, path }: Props) {
  const addHighlights = useStore((s) => s.addHighlights);
  const removeHighlights = useStore((s) => s.removeHighlights);

  const [pill, setPill] = useState<Pill | null>(null);
  /** Flipped a frame after mount so the entrance transition actually runs. */
  const [shown, setShown] = useState(false);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Bumped by scroll, purely to re-run the positioning effect. */
  const [, tick] = useState(0);

  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setPill(null);
    setShown(false);
  }, []);

  // --- offering a highlight --------------------------------------------------
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;

    const onSelectionChange = () => {
      clearTimeout(timer.current);
      // Any change to the selection retracts a standing offer immediately —
      // the pill should never be seen pointing at text that is no longer
      // selected, even for a frame.
      setPill((p) => (p?.mode === "add" ? null : p));
      setShown((s) => (s ? false : s));

      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;

      timer.current = setTimeout(() => {
        const live = document.getSelection();
        if (!live || live.isCollapsed || !live.rangeCount) return;
        if (!anchorOf(live)) return;
        const marks = new Map<number, Rect[]>();
        for (const [page, rects] of rectsBySelection(live, pageBoxes(el))) {
          const merged = mergeRects(rects);
          if (merged.length) marks.set(page, merged);
        }
        if (!marks.size) return;
        // Nothing to offer when the passage is already marked end to end.
        // Re-highlighting it is a no-op the user cannot see — and, before the
        // bars blended idempotently, it was worse than a no-op — so the pill
        // simply stays away. A selection that only *partly* overlaps still
        // gets the offer: extending a highlight is a real intention.
        if (covers(useStore.getState().highlights[path] ?? [], marks)) return;
        setPill({ mode: "add", marks, text: live.toString() });
        setShown(false);
      }, OFFER_MS);
    };

    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      clearTimeout(timer.current);
    };
  }, [scroller, path]);

  // --- clicking an existing highlight ---------------------------------------
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;

    const onClick = (e: MouseEvent) => {
      if (pillRef.current?.contains(e.target as Node)) return;
      // A click that ended a drag is a selection, not a request to delete.
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed) return;

      const spot = pointOnPage(pageBoxes(el), e.clientX, e.clientY);
      const marks = useStore.getState().highlights[path] ?? [];
      // Every highlight under the cursor, not just the topmost: overlapping
      // marks are indistinguishable on screen, so removing one and leaving the
      // rest reads as the click having done nothing at all.
      const under = spot
        ? marks.filter((h) => h.page === spot.page && hits(h.rects, spot.x, spot.y))
        : [];

      if (!under.length || !spot) {
        dismiss();
        return;
      }
      const inside = (r: Rect) =>
        spot.x >= r.x && spot.x <= r.x + r.w && spot.y >= r.y && spot.y <= r.y + r.h;
      // Anchor on the newest bar under the cursor — the one drawn on top.
      const rect = under[under.length - 1].rects.find(inside);
      if (!rect) return dismiss();
      setPill({
        mode: "remove",
        groups: [...new Set(under.map((h) => h.group))],
        page: spot.page,
        rect,
      });
      setShown(false);
    };

    // Starting a new drag retracts whatever is open.
    const onPointerDown = () => dismiss();

    el.addEventListener("click", onClick);
    el.addEventListener("pointerdown", onPointerDown);
    return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("pointerdown", onPointerDown);
    };
  }, [scroller, path, dismiss]);

  // --- dismissal -------------------------------------------------------------
  useEffect(() => {
    if (!pill) return;
    const el = scroller.current;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        tick((n) => n + 1);
      });
    };

    // A scroll the pill can follow; a zoom it retracts from. Not because the
    // anchor is unrecoverable — it would track — but because a pinch reflows
    // the page under the offer, and a control that slides around mid-gesture
    // is worse than one that gets out of the way.
    const onZoom = (e: Event) => {
      if (e.type !== "wheel" || (e as WheelEvent).ctrlKey || (e as WheelEvent).metaKey) dismiss();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    el?.addEventListener("scroll", onScroll, { passive: true });
    el?.addEventListener("wheel", onZoom, { passive: true });
    el?.addEventListener("gesturechange", onZoom);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      el?.removeEventListener("scroll", onScroll);
      el?.removeEventListener("wheel", onZoom);
      el?.removeEventListener("gesturechange", onZoom);
      cancelAnimationFrame(frame);
    };
  }, [pill, scroller, dismiss]);

  // --- positioning -----------------------------------------------------------
  // Written imperatively rather than as a style prop: this runs on every scroll
  // frame while a pill is open, and re-rendering for it would restart the
  // entrance transition on each one.
  useLayoutEffect(() => {
    const node = pillRef.current;
    const el = scroller.current;
    if (!node || !pill || !el) return;

    // Re-derived every time, so the pill tracks its anchor through a scroll.
    let at: { cx: number; cy: number } | null = null;
    if (pill.mode === "add") {
      const sel = document.getSelection();
      at = sel && !sel.isCollapsed && sel.rangeCount ? anchorOf(sel) : null;
    } else {
      const box = pageBoxes(el).find((b) => b.index === pill.page);
      if (box) {
        at = {
          cx: box.rect.left + (pill.rect.x + pill.rect.w / 2) * box.rect.width,
          cy: box.rect.top + pill.rect.y * box.rect.height,
        };
      }
    }
    // Anchor gone, or scrolled clean out of the window: nothing to point at.
    if (!at || at.cy < -LIFT || at.cy > window.innerHeight + LIFT) return dismiss();

    const box = node.getBoundingClientRect();
    const clamp = (v: number, hi: number) => Math.min(Math.max(v, EDGE), Math.max(EDGE, hi - EDGE));
    const x = clamp(at.cx - box.width / 2, window.innerWidth - box.width);
    // Above the anchor by default, below it when there is no room up there.
    const above = at.cy - LIFT - box.height;
    const y = clamp(
      above >= EDGE ? above : at.cy + LIFT * 2,
      window.innerHeight - box.height,
    );
    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
    // setTimeout rather than requestAnimationFrame: rAF is suspended in a
    // backgrounded window, which would leave the pill mounted but invisible.
    if (!shown) {
      const t = setTimeout(() => setShown(true), 0);
      return () => clearTimeout(t);
    }
  });

  const commit = useCallback(() => {
    if (pill?.mode !== "add") return dismiss();
    const group = crypto.randomUUID();
    const at = Date.now();
    const marks: Highlight[] = [];
    for (const [page, rects] of pill.marks) {
      marks.push({ id: crypto.randomUUID(), group, page, rects, text: pill.text, at });
    }
    if (marks.length) addHighlights(path, marks);
    document.getSelection()?.removeAllRanges();
    dismiss();
  }, [pill, path, addHighlights, dismiss]);

  if (!pill) return null;

  // Pressing a button would otherwise collapse the very selection we are about
  // to read, so the pill never takes focus on mousedown.
  const hold = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="hl-pill" ref={pillRef} data-in={shown} data-mode={pill.mode}>
      {pill.mode === "add" ? (
        <button
          className="hl-swatch"
          onMouseDown={hold}
          onClick={commit}
          title="Highlight"
          aria-label="Highlight"
        />
      ) : (
        <button
          className="hl-remove"
          onMouseDown={hold}
          onClick={() => {
            removeHighlights(path, pill.groups);
            dismiss();
          }}
          title="Remove highlight"
          aria-label="Remove highlight"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M1 1 L9 9 M9 1 L1 9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
