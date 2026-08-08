/**
 * Tauri renders in the OS WebView — WKWebView on macOS — which is pinned to the
 * system Safari version, not to whatever Chrome the frontend was developed
 * against. Anything newer than the oldest Safari we support has to be filled in
 * here, before pdf.js loads.
 */

// pdf.js 5 calls Promise.try in its worker message loop. Safari shipped it in
// 18; macOS 14's WKWebView does not have it, and the failure is a bare
// unhandled rejection with no visible symptom beyond a blank page.
if (typeof (Promise as unknown as { try?: unknown }).try !== "function") {
  (Promise as unknown as { try: unknown }).try = function <T>(
    fn: (...args: unknown[]) => T,
    ...args: unknown[]
  ): Promise<Awaited<T>> {
    return new Promise((resolve) => resolve(fn(...args) as Awaited<T>));
  };
}
