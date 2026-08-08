/**
 * pdf.js's worker runs in its own global scope, so the main thread's polyfills
 * do not reach it. This wrapper applies them and then boots the real worker.
 */
import "./polyfills";
import "pdfjs-dist/build/pdf.worker.min.mjs";
