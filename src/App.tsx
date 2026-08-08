import { useCallback, useEffect, useRef, useState } from "react";
import {
  initialPath,
  onFileDrop,
  pickPdf,
  readFile,
  setWindowTitle,
  toggleFullscreen,
} from "./lib/bridge";
import { closePdf, openPdf, type PdfDoc } from "./lib/pdf";
import { useStore } from "./lib/store";
import { Reader } from "./components/Reader";
import { Welcome, basename } from "./components/Welcome";
import { Keys } from "./components/Keys";

/** How long the pointer must rest before the window empties itself out. */
const IDLE_MS = 2000;

type Doc = { doc: PdfDoc; path: string; title: string };

export default function App() {
  const { ready, theme, zoom, hydrate, cycleTheme, setZoom, toggleFocus, forget } =
    useStore();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const docRef = useRef<Doc | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // --- opening --------------------------------------------------------------
  const openPath = useCallback(
    async (path: string) => {
      setBusy(true);
      setError(null);
      try {
        const bytes = await readFile(path);
        const next = await openPdf(bytes);
        const meta = await next.getMetadata().catch(() => null);
        const title =
          (meta?.info as { Title?: string } | undefined)?.Title?.trim() || basename(path);

        if (docRef.current) void closePdf(docRef.current.doc);
        const entry = { doc: next, path, title };
        docRef.current = entry;
        setDoc(entry);
        setWindowTitle(title);
      } catch (e) {
        setError(String(e));
        forget(path);
      } finally {
        setBusy(false);
      }
    },
    [forget],
  );

  const open = useCallback(async () => {
    const path = await pickPdf();
    if (path) await openPath(path);
  }, [openPath]);

  const close = useCallback(() => {
    if (docRef.current) void closePdf(docRef.current.doc);
    docRef.current = null;
    setDoc(null);
    setWindowTitle("Zone");
  }, []);

  // --- a PDF handed to us at launch ------------------------------------------
  const launched = useRef(false);
  useEffect(() => {
    if (!ready || launched.current) return;
    launched.current = true;
    void initialPath().then((path) => {
      if (path) void openPath(path);
    });
  }, [ready, openPath]);

  // --- drag and drop --------------------------------------------------------
  useEffect(
    () =>
      onFileDrop((paths) => {
        const pdf = paths.find((p) => p.toLowerCase().endsWith(".pdf"));
        if (pdf) void openPath(pdf);
      }),
    [openPath],
  );

  // --- global keys ----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "t":
          cycleTheme();
          break;
        case "d":
          toggleFocus();
          break;
        case "f":
          toggleFullscreen();
          break;
        case "o":
          void open();
          break;
        case "w":
          if (doc) close();
          break;
        case "+":
        case "=":
          setZoom(zoom + 0.1);
          break;
        case "-":
          setZoom(zoom - 0.1);
          break;
        case "0":
          setZoom(1);
          break;
        case "?":
          setShowKeys((v) => !v);
          break;
        case "Escape":
          setShowKeys(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleTheme, toggleFocus, open, close, doc, setZoom, zoom]);

  // --- idle: strip the window bare -----------------------------------------
  useEffect(() => {
    const root = document.documentElement;
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      root.dataset.idle = "false";
      clearTimeout(timer);
      timer = setTimeout(() => (root.dataset.idle = "true"), IDLE_MS);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  if (!ready) return <div className="titlebar" data-tauri-drag-region />;

  return (
    <>
      <div className="titlebar" data-tauri-drag-region />

      {doc ? (
        <Reader key={doc.path} doc={doc.doc} path={doc.path} title={doc.title} />
      ) : (
        <Welcome onOpen={open} onPick={openPath} />
      )}

      {busy && <div className="veil">opening…</div>}
      {error && (
        <div className="veil" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {showKeys && <Keys onClose={() => setShowKeys(false)} />}
    </>
  );
}
