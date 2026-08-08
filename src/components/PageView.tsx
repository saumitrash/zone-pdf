import { memo, useEffect, useRef, type CSSProperties } from "react";
import { TextLayer } from "pdfjs-dist";
import type { RenderTask } from "pdfjs-dist";
import type { PdfDoc } from "../lib/pdf";

type Props = {
  doc: PdfDoc;
  index: number;
  width: number;
  height: number;
  /** This page's width at scale 1, in PDF units. Drives `--scale-factor`. */
  baseWidth: number;
  /**
   * The width to rasterise at. Lags `width` during a zoom gesture: re-rendering
   * on every frame would swamp the worker, and until it catches up CSS stretches
   * the old bitmap — a free preview.
   */
  renderWidth: number;
  /** The strip worth holding pixels for, in page units (index plus fraction). */
  bandFrom: number;
  bandTo: number;
  /** Only mounted pages hold a canvas; everything else is an empty box. */
  active: boolean;
};

/** Cap backing-store resolution — 2x is indistinguishable from 3x on text. */
const MAX_DPR = 2;
/**
 * And cap the backing store by area. It applies to the *slice*, so where a
 * whole-page render used to be forced down to ~1.2x device resolution at 3x
 * zoom, a strip now lands at close to the full 2x.
 */
const MAX_BACKING_PX = 16_000_000;
/**
 * A slice this much of the page is rounded up to the whole page: the pixels
 * saved are not worth re-rasterising as the band creeps over the rest.
 */
const WHOLE_PAGE_AT = 0.75;
/**
 * A render this big is slow enough to be worth previewing first: paint a cheap
 * pass, then replace it with the sharp one. Below this a single pass wins.
 */
const PREVIEW_MIN_PX = 4_000_000;
/** How much coarser the preview pass is — 1/9 the pixels, so ~1/9 the time. */
const PREVIEW_DIVISOR = 3;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function Page({ doc, index, width, height, baseWidth, renderWidth, bandFrom, bandTo, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  /** The slice currently on the canvas, or null if it holds nothing usable. */
  const drawn = useRef<{ f0: number; f1: number } | null>(null);

  // Which slice of this page to rasterise, as fractions of its height — the one
  // form that survives a zoom. The band arrives already snapped to a lattice, so
  // these hold still until it really moves.
  const lo = clamp01(bandFrom - index);
  const hi = clamp01(bandTo - index);
  // A band wider than a page has nothing to gain from slicing — that is every
  // page at ordinary zoom, and it must keep rendering in one shot as it always
  // has. Slicing is for the case the band cannot hold a whole page at all.
  const whole = bandTo - bandFrom >= 1 || hi - lo >= WHOLE_PAGE_AT;
  const f0 = whole ? 0 : lo;
  const f1 = whole ? 1 : hi;

  useEffect(() => {
    if (!active) drawn.current = null;
  }, [active]);

  useEffect(() => {
    if (!active || f1 <= f0) return;
    let cancelled = false;
    let task: RenderTask | undefined;

    (async () => {
      const page = await doc.getPage(index + 1);
      if (cancelled) return;

      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const unscaled = page.getViewport({ scale: 1 });
      const frac = f1 - f0;
      let scale = (renderWidth * dpr) / unscaled.width;
      const px = unscaled.width * unscaled.height * frac * scale * scale;
      if (px > MAX_BACKING_PX) scale *= Math.sqrt(MAX_BACKING_PX / px);

      /**
       * One pass. The bitmap is built off-screen and only swapped in once it is
       * complete: sizing a live canvas clears it, so rendering straight into the
       * visible one is what made zoom strobe and tear.
       */
      const pass = async (s: number) => {
        const full = page.getViewport({ scale: s });
        const w = Math.max(1, Math.floor(full.width));
        const h = Math.max(1, Math.round(full.height * frac));
        const buf = document.createElement("canvas");
        buf.width = w;
        buf.height = h;
        const bctx = buf.getContext("2d", { alpha: false });
        if (!bctx) return;
        // The strip is cut by translating the page up, not by cropping after.
        const viewport = page.getViewport({ scale: s, offsetY: -full.height * f0 });
        task = page.render({ canvasContext: bctx, viewport });
        await task.promise;
        if (cancelled) return;

        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d", { alpha: false });
        if (!canvas || !ctx) return;
        // Resize, blit and reposition in one synchronous block, so no frame can
        // catch the canvas cleared or the old bitmap under the new geometry.
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(buf, 0, 0);
        canvas.style.top = `${f0 * 100}%`;
        canvas.style.height = `${frac * 100}%`;
      };

      // A moved slice has nothing on screen to stretch, so it gets a coarse pass
      // first. A pure zoom change does not: the old bitmap is already the preview.
      const moved = !drawn.current || drawn.current.f0 !== f0 || drawn.current.f1 !== f1;
      const heavy = unscaled.width * unscaled.height * frac * scale * scale > PREVIEW_MIN_PX;
      try {
        if (moved && heavy) await pass(scale / PREVIEW_DIVISOR);
        if (cancelled) return;
        await pass(scale);
        drawn.current = { f0, f1 };
      } catch {
        // Cancelled mid-render while scrolling or zooming past — expected.
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index, renderWidth, active, f0, f1]);

  /**
   * The text layer, rendered once at scale 1 and never again.
   *
   * pdf.js positions its spans as percentages of page width and height, and
   * sizes their type through `--scale-factor`, so a zoom needs nothing from us
   * but a new value for that variable — no second `getTextContent`, no
   * re-layout on a pinch frame. The variable tracks `width`, the live box, not
   * `renderWidth`: the glyph boxes must line up with the geometry the reader is
   * dragging over, and since the text is transparent nobody sees them lead the
   * bitmap through the settle.
   */
  useEffect(() => {
    const container = textRef.current;
    if (!active || !container) return;
    let cancelled = false;
    let layer: TextLayer | undefined;

    (async () => {
      const page = await doc.getPage(index + 1);
      if (cancelled) return;
      layer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport: page.getViewport({ scale: 1 }),
      });
      try {
        await layer.render();
        // pdf.js sizes the container itself, with `round(down, …)` — which can
        // land a pixel short of the .page box. Its spans are positioned as
        // percentages *of this container*, so that pixel would shear the whole
        // text layer off the bitmap. Take the size back.
        container.style.width = "100%";
        container.style.height = "100%";
      } catch {
        // Scrolled out of the band mid-render, or a page with no text at all.
      }
    })();

    return () => {
      cancelled = true;
      layer?.cancel();
      container.replaceChildren();
    };
  }, [doc, index, active]);

  return (
    <div
      className="page"
      data-index={index}
      // `--scale-factor` is what makes the text layer follow a zoom for free.
      style={{ width, height, "--scale-factor": baseWidth ? width / baseWidth : 1 } as CSSProperties}
    >
      {active && <canvas ref={canvasRef} />}
      <div className="textLayer" ref={textRef} />
    </div>
  );
}

/**
 * Memoised because Reader re-renders on every scroll frame — `progress` is a
 * float that changes constantly — and without this every page in the document
 * reconciles each time. Every prop is a primitive for the same reason; an inline
 * object or arrow prop would silently undo it.
 */
export const PageView = memo(Page);
