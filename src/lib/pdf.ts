import * as pdfjs from "pdfjs-dist";

import { report } from "./debug";

export type PdfDoc = pdfjs.PDFDocumentProxy;
export type PdfPage = pdfjs.PDFPageProxy;

/** Workers we created, so closing a document tears its thread down too. */
const workers = new WeakMap<PdfDoc, Worker>();

export async function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  // Our own wrapper worker rather than `workerSrc`, so the WebView polyfills
  // load inside the worker scope before pdf.js does.
  const port = new Worker(new URL("./pdf.worker.ts", import.meta.url), {
    type: "module",
  });

  // A worker that fails to load reports nothing on its own — pdf.js simply
  // never settles, and the window stays blank. Surface it instead.
  port.onerror = (e) =>
    report(`pdf worker failed to load: ${(e as ErrorEvent).message || e.type}`);
  port.onmessageerror = () => report("pdf worker sent an undeserializable message");

  // `fromPort` rather than `new PDFWorker`: the bundled .d.ts types the
  // constructor's params as null-only, while the static factory is correct.
  const worker = pdfjs.PDFWorker.fromPort({
    name: "zone-pdf",
    port,
  }) as pdfjs.PDFWorker;

  try {
    // Fail on the handshake rather than hanging forever inside getDocument.
    await worker.promise;
    const doc = await pdfjs.getDocument({
      data: bytes,
      worker,
      isEvalSupported: false,
    }).promise;
    workers.set(doc, port);
    return doc;
  } catch (e) {
    report(`openPdf failed: ${String(e)}`);
    port.terminate();
    throw e;
  }
}

export async function closePdf(doc: PdfDoc): Promise<void> {
  const port = workers.get(doc);
  workers.delete(doc);
  await doc.destroy().catch(() => {});
  port?.terminate();
}
