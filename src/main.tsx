import "./lib/polyfills";

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { invoke } from "@tauri-apps/api/core";

// The OS WebView has no console we can read from a terminal, and its failures
// are usually silent. In dev, push them to the Rust side's stderr.
if (import.meta.env.DEV && "__TAURI_INTERNALS__" in window) {
  const send = (msg: string) => void invoke("dbg", { msg }).catch(() => {});
  window.addEventListener("error", (e) => send(`${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => send(`rejection: ${String(e.reason)}`));
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
