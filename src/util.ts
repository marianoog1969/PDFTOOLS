import { invoke } from "@tauri-apps/api/core";

export function nombreArchivo(ruta: string): string { return ruta.split(/[\\/]/).pop() || ruta; }
export function carpetaDe(ruta: string): string { return ruta.replace(/[\\/][^\\/]*$/, ""); }
export function unir(carpeta: string, nombre: string): string { return carpeta + (carpeta.includes("\\") ? "\\" : "/") + nombre; }
export function formatoTam(b: number): string {
  if (b >= 1048576) return (b / 1048576).toFixed(1).replace(".", ",") + " MB";
  if (b >= 1024) return Math.round(b / 1024) + " KB";
  return b + " B";
}

/** «informe.pdf» + «_marcado» → «informe_marcado.pdf» en la misma carpeta (con «(2)», «(3)»… si ya existe). */
export async function rutaSalida(entrada: string, sufijo: string, carpeta?: string): Promise<string> {
  const dir = carpeta || carpetaDe(entrada);
  const stem = nombreArchivo(entrada).replace(/\.pdf$/i, "");
  let cand = unir(dir, `${stem}${sufijo}.pdf`);
  let n = 2;
  while (await invoke<boolean>("archivo_existe", { ruta: cand })) { cand = unir(dir, `${stem}${sufijo} (${n}).pdf`); n++; if (n > 500) break; }
  return cand;
}

export function hexARgb(h: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
}

export function leerLS<T>(clave: string, por_defecto: T): T {
  try { const v = localStorage.getItem(clave); return v ? { ...por_defecto, ...JSON.parse(v) } : por_defecto; } catch { return por_defecto; }
}
export function guardarLS(clave: string, v: unknown) { try { localStorage.setItem(clave, JSON.stringify(v)); } catch { /* sin almacenamiento */ } }

export type Registrar = (tipo: "ok" | "err" | "info", texto: string) => void;
export interface PropsHerramienta { alGenerar: (ruta: string) => void; registrar: Registrar; zona: string; }
