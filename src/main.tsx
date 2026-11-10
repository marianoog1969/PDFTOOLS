import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./estilos.css";
import { invoke } from "@tauri-apps/api/core";

// Errores de la interfaz no capturados → logs\errores.log
function registrarError(origen: string, e: unknown) {
  const texto = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  invoke("registrar_error_js", { origen, mensaje: texto }).catch(() => {});
}
window.addEventListener("error", (ev) => registrarError("JS", ev.error ?? `${ev.message} (${ev.filename}:${ev.lineno})`));
window.addEventListener("unhandledrejection", (ev) => registrarError("PROMESA", ev.reason));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
