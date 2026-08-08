import type { Highlight, Rect } from "./store";

/**
 * Turning a selection into something that survives a zoom.
 *
 * Everything here works in *page-normalised* coordinates — fractions of a page
 * box's width and height — for the same reason the bookmark stores `frac`: it
 * is the one form a zoom, a resize or a reopen cannot invalidate. Client
 * rectangles are read once, at the moment of the click, and immediately
 * divided out.
 */

/**
 * Narrower or shorter than this and it is not a real rectangle — pdf.js emits
 * zero-width rects for line breaks and inter-word spaces.
 */
const MIN_SPAN = 0.0015;

/** Four decimals is sub-0.1px on an 860px page, and keeps library.json small. */
const q = (n: number) => Math.round(n * 1e4) / 1e4;

/** A page box as it currently sits on screen. */
type PageBox = { index: number; rect: DOMRect };

/** The `.page` elements currently mounted, with their indices. */
export function pageBoxes(scroller: HTMLElement): PageBox[] {
  return Array.from(scroller.querySelectorAll<HTMLElement>(".page")).map((el) => ({
    index: Number(el.dataset.index),
    rect: el.getBoundingClientRect(),
  }));
}

/** Which page a viewport point falls on, and where on it, as fractions. */
export function pointOnPage(
  boxes: PageBox[],
  cx: number,
  cy: number,
): { page: number; x: number; y: number } | null {
  for (const { index, rect } of boxes) {
    if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) continue;
    if (rect.width <= 0 || rect.height <= 0) continue;
    return { page: index, x: (cx - rect.left) / rect.width, y: (cy - rect.top) / rect.height };
  }
  return null;
}

/**
 * The line boxes a selection covers, in viewport coordinates.
 *
 * Deliberately *not* `range.getClientRects()`. Once a range spans more than one
 * element — anything crossing a page break, and plenty that does not — that
 * method also returns a rect for each wholly-contained block, up to and
 * including the page-sized containers themselves. Highlighting those paints a
 * slab over the whole page.
 *
 * Walking the range's text nodes and asking each for its own rects gives line
 * boxes and nothing else, which is exactly what a highlight is made of.
 */
export function selectionRects(sel: Selection): DOMRect[] {
  const out: DOMRect[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(
      root.nodeType === Node.TEXT_NODE ? (root.parentNode ?? root) : root,
      NodeFilter.SHOW_TEXT,
    );
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n)) continue;
      const text = n as Text;
      const sub = document.createRange();
      sub.setStart(text, n === range.startContainer ? range.startOffset : 0);
      sub.setEnd(text, n === range.endContainer ? range.endOffset : text.length);
      if (sub.collapsed) continue;
      out.push(...Array.from(sub.getClientRects()));
    }
  }
  return out.filter((r) => r.width > 0 && r.height > 0);
}

/**
 * Those line boxes, cut up by page and normalised.
 *
 * A selection spanning a page break simply produces entries for both pages —
 * the intersection test handles it with no special case.
 */
export function rectsBySelection(sel: Selection, boxes: PageBox[]): Map<number, Rect[]> {
  const out = new Map<number, Rect[]>();
  {
    for (const r of selectionRects(sel)) {
      for (const { index, rect: p } of boxes) {
        if (p.width <= 0 || p.height <= 0) continue;
        const left = Math.max(r.left, p.left);
        const right = Math.min(r.right, p.right);
        const top = Math.max(r.top, p.top);
        const bottom = Math.min(r.bottom, p.bottom);
        if (right <= left || bottom <= top) continue;
        const rect = {
          x: (left - p.left) / p.width,
          y: (top - p.top) / p.height,
          w: (right - left) / p.width,
          h: (bottom - top) / p.height,
        };
        if (rect.w < MIN_SPAN || rect.h < MIN_SPAN) continue;
        const list = out.get(index) ?? [];
        list.push(rect);
        out.set(index, list);
      }
    }
  }
  return out;
}

/** Two rects sit on the same line when their vertical centres nearly agree. */
const sameLine = (a: Rect, b: Rect) =>
  Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < Math.min(a.h, b.h) / 2;

/** How wide a gap two rects on a line may span and still be one bar. */
const GAP_FACTOR = 0.6;

/**
 * Collapse per-span rectangles into one bar per line.
 *
 * pdf.js emits a span per text run, so a single line of prose arrives as a
 * dozen abutting rects. Merging them is what separates a clean highlight from
 * a row of overlapping smudges with visibly darker seams.
 *
 * The gap threshold is measured in line heights, not page fractions, so it
 * scales with the type: it welds the words of a sentence together while
 * leaving the two columns of a two-column page as separate bars.
 */
export function mergeRects(rects: Rect[]): Rect[] {
  const lines: Rect[][] = [];
  for (const r of rects) {
    const line = lines.find((l) => sameLine(l[0], r));
    if (line) line.push(r);
    else lines.push([r]);
  }

  const out: Rect[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let run: Rect | null = null;
    for (const r of line) {
      if (run && r.x - (run.x + run.w) <= run.h * GAP_FACTOR) {
        const right = Math.max(run.x + run.w, r.x + r.w);
        const top = Math.min(run.y, r.y);
        const bottom = Math.max(run.y + run.h, r.y + r.h);
        run.x = Math.min(run.x, r.x);
        run.w = right - run.x;
        run.y = top;
        run.h = bottom - top;
      } else {
        run = { ...r };
        out.push(run);
      }
    }
  }
  return out.map((r) => ({ x: q(r.x), y: q(r.y), w: q(r.w), h: q(r.h) }));
}

/** Is a normalised point inside any of these rects? */
export const hits = (rects: Rect[], x: number, y: number) =>
  rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);

/**
 * Is every bar of a would-be highlight already sitting under an existing one?
 *
 * Used to keep the offer pill away from text that is already marked. Three
 * points along each bar rather than just its centre, so a selection that runs
 * off the end of an existing highlight still counts as new — extending a mark
 * is a real intention, re-applying it is not.
 */
export function covers(existing: Highlight[], marks: Map<number, Rect[]>): boolean {
  if (!existing.length) return false;
  for (const [page, rects] of marks) {
    const here = existing.filter((h) => h.page === page);
    if (!here.length) return false;
    for (const r of rects) {
      const y = r.y + r.h / 2;
      for (const t of [0.15, 0.5, 0.85]) {
        const x = r.x + r.w * t;
        if (!here.some((h) => hits(h.rects, x, y))) return false;
      }
    }
  }
  return true;
}
