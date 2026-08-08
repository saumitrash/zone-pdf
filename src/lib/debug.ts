/**
 * The OS WebView has no console reachable from a terminal, and its most common
 * failures (an unsupported API, a worker that won't load) surface as silence.
 * In dev, breadcrumbs go to the Rust side's stderr.
 */
const ON = import.meta.env.DEV && "__TAURI_INTERNALS__" in window;

export function report(msg: string): void {
  if (!ON) {
    console.warn("[zone]", msg);
    return;
  }
  void import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke("dbg", { msg }).catch(() => {}),
  );
}
