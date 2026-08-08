import { memo, useEffect, useRef } from "react";
import type { RenderTask } from "pdfjs-dist";
import type { PdfDoc } from "../lib/pdf";

type Props = {
  doc: PdfDoc;
  index: number;
  width: number;
  height: number;
  /**
   * The width to rasterise at. Lags `width` during a zoom gesture: setting
   * `canvas.width` clears the canvas, so re-rendering on every frame would
   * strobe. Until it catches up, CSS stretches the old bitmap — a free preview.
   */
  renderWidth: number;
  /** Only mounted pages hold a canvas; everything else is an empty box. */
  active: boolean;
};

/** Cap backing-store resolution — 2x is indistinguishable from 3x on text. */
const MAX_DPR = 2;
/**
 * And cap the backing store by area, so a magnified page does not allocate
 * hundreds of megabytes. 16M pixels is 64MB; at 5x that still rasterises the
 * page at ~4x its own point size, so it stays sharper than a 1x render.
 */
const MAX_BACKING_PX = 16_000_000;

function Page({ doc, index, width, height, renderWidth, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let task: RenderTask | undefined;

    (async () => {
      const page = await doc.getPage(index + 1);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;

      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const unscaled = page.getViewport({ scale: 1 });
      let scale = (renderWidth * dpr) / unscaled.width;
      const px = unscaled.width * unscaled.height * scale * scale;
      if (px > MAX_BACKING_PX) scale *= Math.sqrt(MAX_BACKING_PX / px);
      const viewport = page.getViewport({ scale });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;

      task = page.render({ canvasContext: ctx, viewport });
      try {
        await task.promise;
      } catch {
        // Cancelled mid-render while scrolling past — expected, not an error.
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index, renderWidth, active]);

  return (
    <div className="page" data-index={index} style={{ width, height }}>
      {active && <canvas ref={canvasRef} />}
    </div>
  );
}

/**
 * Memoised because Reader re-renders on every scroll frame — `progress` is a
 * float that changes constantly — and without this every page in the document
 * reconciles each time. During a zoom all the size props move together, so this
 * buys nothing there; it is scrolling a long document that it rescues.
 */
export const PageView = memo(Page);
