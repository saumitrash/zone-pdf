import { useEffect, useRef } from "react";
import type { RenderTask } from "pdfjs-dist";
import type { PdfDoc } from "../lib/pdf";

type Props = {
  doc: PdfDoc;
  index: number;
  width: number;
  height: number;
  /** Only mounted pages hold a canvas; everything else is an empty box. */
  active: boolean;
};

/** Cap backing-store resolution — 2x is indistinguishable from 3x on text. */
const MAX_DPR = 2;

export function PageView({ doc, index, width, height, active }: Props) {
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
      const viewport = page.getViewport({ scale: (width * dpr) / unscaled.width });

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
  }, [doc, index, width, active]);

  return (
    <div className="page" data-index={index} style={{ width, height }}>
      {active && <canvas ref={canvasRef} />}
    </div>
  );
}
