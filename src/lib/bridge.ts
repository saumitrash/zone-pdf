import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * Outside the native shell (`npm run dev` in a plain browser) there is no Rust
 * side, so disk access and persistence fall back to fetch + localStorage. This
 * exists so the reading surface itself can be developed and inspected in a
 * browser; the shipped app always takes the Tauri path.
 */
const NATIVE = "__TAURI_INTERNALS__" in window;

/** Native file picker. Resolves to an absolute path, or null if cancelled. */
export function pickPdf(): Promise<string | null> {
  if (!NATIVE) return Promise.resolve("/sample.pdf");
  return invoke<string | null>("pick_pdf");
}

/** A PDF handed to us at launch, via argv or "Open With". */
export function initialPath(): Promise<string | null> {
  if (!NATIVE) return Promise.resolve(new URLSearchParams(location.search).get("pdf"));
  return invoke<string | null>("initial_path");
}

/** Read a file off disk as bytes. */
export async function readFile(path: string): Promise<Uint8Array> {
  if (!NATIVE) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const bytes = await invoke<ArrayBuffer | number[]>("read_file", { path });
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes);
}

export async function loadState<T>(fallback: T): Promise<T> {
  try {
    const raw = NATIVE
      ? await invoke<string>("load_state")
      : localStorage.getItem("zone") || "{}";
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

export function saveState(value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  if (!NATIVE) {
    localStorage.setItem("zone", json);
    return Promise.resolve();
  }
  return invoke("save_state", { json });
}

/**
 * Window-level affordances. The `@tauri-apps/api` window and webview helpers
 * read `__TAURI_INTERNALS__` eagerly and throw outside the native shell, so
 * every one of them is guarded here rather than at the call site.
 */
export function setWindowTitle(title: string): void {
  if (!NATIVE) {
    document.title = title;
    return;
  }
  void getCurrentWindow().setTitle(title);
}

export function toggleFullscreen(): void {
  if (!NATIVE) {
    void (document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen());
    return;
  }
  const win = getCurrentWindow();
  void win.isFullscreen().then((on) => win.setFullscreen(!on));
}

/** Files dropped onto the window. Returns an unsubscribe function. */
export function onFileDrop(handler: (paths: string[]) => void): () => void {
  if (!NATIVE) return () => {};
  let unlisten: (() => void) | undefined;
  let stopped = false;
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type === "drop") handler(event.payload.paths);
    })
    .then((fn) => {
      if (stopped) fn();
      else unlisten = fn;
    });
  return () => {
    stopped = true;
    unlisten?.();
  };
}
