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

/** [1,2,3,5,7,8] → «1-3, 5, 7-8» (ordena y quita duplicados). */
export function aRango(nums: number[]): string {
  const l = [...new Set(nums)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const partes: string[] = [];
  for (let i = 0; i < l.length;) {
    let j = i;
    while (j + 1 < l.length && l[j + 1] === l[j] + 1) j++;
    partes.push(j > i ? `${l[i]}-${l[j]}` : `${l[i]}`);
    i = j + 1;
  }
  return partes.join(", ");
}

/** Valida un rango «1-3, 5» para un documento de `total` páginas (0 = desconocido). */
export function validarRangoPaginas(r: string, total: number): { ok: boolean; error?: string; n: number } {
  let n = 0;
  for (const parte of r.split(",")) {
    const t = parte.trim(); if (!t) continue;
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(t);
    if (!m) return { ok: false, error: `No se entiende «${t}»`, n: 0 };
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b < a || (total > 0 && b > total)) return { ok: false, error: `«${t}» está fuera de 1-${total || "?"}`, n: 0 };
    n += b - a + 1;
  }
  return n > 0 ? { ok: true, n } : { ok: false, error: "Indica al menos una página", n: 0 };
}

/** «Impreso el 08/11/2026 a las 10:30» */
export function textoFechaImpresion(d = new Date()): string {
  const f = d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
  const h = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `Impreso el ${f} a las ${h}`;
}

// ── Utilidades comunes de las herramientas ──────────────────────────────────

const CLAVE_CARPETA = "pdftool_ultima_carpeta";
export function leerUltimaCarpeta(): string | undefined { try { return localStorage.getItem(CLAVE_CARPETA) || undefined; } catch { return undefined; } }
export function guardarUltimaCarpeta(ruta: string) { const c = carpetaDe(ruta); if (c && c !== ruta) { try { localStorage.setItem(CLAVE_CARPETA, c); } catch { /* sin almacenamiento */ } } }

/** «informe.pdf» + «_OCR» → «informe_OCR.pdf» */
export function rutaConSufijo(ruta: string, sufijo: string): string { const p = ruta.lastIndexOf("."); return p === -1 ? ruta + sufijo : ruta.slice(0, p) + sufijo + ruta.slice(p); }

/** Tamaño legible; 0 → «» */
export function formatoTamano(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function moverEnLista<T>(lista: T[], origen: number, destino: number): T[] {
  if (origen < 0 || origen >= lista.length || destino < 0 || destino >= lista.length) return lista;
  const copia = [...lista];
  const [item] = copia.splice(origen, 1);
  copia.splice(destino, 0, item);
  return copia;
}

/** Rango de páginas «1-3, 5» → conjunto de páginas válidas (ignora lo que esté fuera de 1..total). */
export function rangoAPaginas(rango: string, total: number): Set<number> {
  const r = new Set<number>();
  for (const parte of rango.split(",")) {
    const t = parte.trim();
    if (!t) continue;
    if (t.includes("-")) {
      const [a, b] = t.split("-").map((x) => parseInt(x.trim(), 10));
      if (!isNaN(a) && !isNaN(b)) for (let n = Math.max(1, a); n <= Math.min(total, b); n++) r.add(n);
    } else {
      const n = parseInt(t, 10);
      if (!isNaN(n) && n >= 1 && n <= total) r.add(n);
    }
  }
  return r;
}

/** Partes de «Dividir»: cada N páginas, o cortando antes de las páginas indicadas («5, 12»). */
export function calcularRangosDividir(modo: "cada" | "puntos", cadaN: string, puntos: string, total: number): { rangos: [number, number][]; error?: string } {
  if (!total || total <= 0) return { rangos: [], error: "" };
  if (modo === "cada") {
    const n = parseInt(cadaN, 10);
    if (!cadaN.trim()) return { rangos: [], error: "" };
    if (isNaN(n) || n < 1) return { rangos: [], error: "Indica un número de páginas válido" };
    if (n >= total) return { rangos: [], error: `El PDF solo tiene ${total} página(s)` };
    const rangos: [number, number][] = [];
    for (let inicio = 1; inicio <= total; inicio += n) rangos.push([inicio, Math.min(inicio + n - 1, total)]);
    return { rangos };
  }
  const partes = puntos.split(",").map((p) => p.trim()).filter(Boolean);
  if (partes.length === 0) return { rangos: [], error: "" };
  const nums: number[] = [];
  for (const p of partes) {
    const n = parseInt(p, 10);
    if (isNaN(n)) return { rangos: [], error: `Número inválido: "${p}"` };
    if (n <= 1 || n > total) return { rangos: [], error: `El punto ${n} debe estar entre 2 y ${total}` };
    nums.push(n);
  }
  const puntosOrdenados = [...new Set(nums)].sort((a, b) => a - b);
  const rangos: [number, number][] = [];
  let inicio = 1;
  for (const p of puntosOrdenados) { rangos.push([inicio, p - 1]); inicio = p; }
  rangos.push([inicio, total]);
  return { rangos };
}

/** Mensaje de error técnico → explicación en lenguaje claro (con el original entre paréntesis). */
export function amigable(msg: string): string {
  const m = msg.toLowerCase();
  const con = (t: string) => `${t} (${msg})`;
  if (/os error 32|used by another process|being used|sharing violation|en uso/.test(m)) return con("El archivo está abierto en otro programa. Ciérralo e inténtalo de nuevo.");
  if (/os error 5\b|access is denied|acceso denegado|permission denied/.test(m)) return con("Sin permiso para escribir ahí. Elige otra carpeta o comprueba que el archivo no sea de solo lectura.");
  if (/os error 2\b|no such file|cannot find the file|no se encuentra/.test(m)) return con("No se encuentra el archivo; puede que se haya movido o borrado.");
  if (/os error 3\b|cannot find the path|ruta de acceso/.test(m)) return con("No se encuentra la carpeta. Si es una unidad de red, comprueba que está conectada.");
  if (/os error 112|no space left|disk full/.test(m)) return con("No hay espacio suficiente en el disco. Libera espacio o elige otra unidad.");
  if (/password|encrypted|contraseña/.test(m)) return con("El PDF está protegido con contraseña; quítale la protección para poder usarlo.");
  if (/pin|cancel(ado|led)|operation was canceled|operación cancelada/.test(m) && /firm|sign|windows/.test(m)) return con("La firma se canceló (¿PIN no introducido?). Vuelve a intentarlo e introduce el PIN del DNIe.");
  if (/tarjeta|smart ?card|lector/.test(m)) return con("No se detecta la tarjeta. Comprueba que el DNIe está insertado y el lector conectado.");
  if (/caduc/.test(m)) return con("El certificado está caducado. Elige otro o renuévalo.");
  if (/pfx|contraseña incorrecta|password is not correct|mac verify/.test(m)) return con("No se pudo abrir el certificado: revisa la contraseña o que el archivo sea un .pfx/.p12 válido.");
  if (/pdf no v[aá]lido|invalid (file )?header|xref|trailer|corrupt|dañad|damaged|startxref|parse/.test(m)) return con("El PDF parece dañado o no es un PDF válido. Prueba a abrirlo con otro programa o a repararlo.");
  if (/ghostscript|gswin|gs\.exe|utils/.test(m) && /no se|not found|falta|missing|cannot/.test(m)) return con("Falta Ghostscript en la carpeta UTILS. Pulsa «Ver cómo» en el aviso amarillo.");
  if (/tesseract/.test(m) && /no se|not found|falta|missing|cannot/.test(m)) return con("Falta Tesseract en la carpeta UTILS. Pulsa «Ver cómo» en el aviso amarillo.");
  if (/cancel/.test(m)) return "Operación cancelada.";
  if (/timed out|timeout|tiempo de espera/.test(m)) return con("La operación tardó demasiado. Inténtalo con menos archivos o un archivo más pequeño.");
  return msg;
}

export function esErrorDll(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("can't load") || m.includes("dll") || m.includes("load library") || m.includes("vcruntime");
}

export const esPdf = (p: string) => p.toLowerCase().endsWith(".pdf");
export const esImagen = (p: string) => /\.(jpe?g|png|bmp|tiff?|gif|webp|heic|heif)$/i.test(p);
export type TipoOffice = "word" | "excel" | "powerpoint";
/** Programa de Office que abre el documento (por extensión); null si no es un documento de Office. */
export function tipoOffice(p: string): TipoOffice | null {
  const ext = (p.match(/\.([^.\\/]+)$/)?.[1] ?? "").toLowerCase();
  if (/^(docx?|docm|dotx?|dotm|rtf|odt|txt|wpd)$/.test(ext)) return "word";
  if (/^(xlsx?|xlsm|xlsb|xltx?|xltm|ods|csv)$/.test(ext)) return "excel";
  if (/^(pptx?|pptm|ppsx?|potx?|odp)$/.test(ext)) return "powerpoint";
  return null;
}
export const esOffice = (p: string) => tipoOffice(p) !== null;
