import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import VisorPdf from "./VisorPdf";
import AnotadorPdf, { type Anot } from "./AnotadorPdf";
import MarcaPdf from "./MarcaPdf";
import MetadatosPdf from "./MetadatosPdf";
import FormularioPdf from "./FormularioPdf";
import LotesPdf from "./LotesPdf";
import Visor from "./Visor";
import AboutDialog from "./AboutDialog";
import DonateButton from "./DonateButton";
import Paleta, { type ItemPaleta } from "./Paleta";
import ColaArchivos, { type ArchivoCola } from "./ColaArchivos";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./App.css";
import "./tema.css";
import manualHtml from "./assets/manual.html?raw";
import { I } from "./Icono";
import { AvisosHost, ConfirmHost, avisar, confirmar } from "./Avisos";
import MenuSuperior, { type GrupoMenu } from "./MenuSuperior";

type EstadoTarjeta = "inactivo" | "procesando" | "hecho" | "error";
type EstadoItem = "pendiente" | "procesando" | "hecho" | "error";
type NivelCompresion = "screen" | "ebook" | "printer" | "prepress";
const ORDEN_NIVELES: NivelCompresion[] = ["screen", "ebook", "printer", "prepress"];
const NIVELES_COMPRESION: Record<NivelCompresion, { nombre: string; corto: string; desc: string }> = {
  screen: { nombre: "Máxima compresión", corto: "Mínimo", desc: "Compresión extrema: archivo muy pequeño (suele quedar en un 10-30 % del original). Imágenes a 72 ppp y calidad baja: se lee bien en pantalla pero se ve borroso al ampliar o imprimir. Ideal para enviar por correo o subir a una web." },
  ebook: { nombre: "Equilibrada (recomendada)", corto: "Equilibrada", desc: "Buena compresión con buena calidad (suele quedar en un 30-50 % del original). Imágenes a 150 ppp: texto nítido, suficiente para leer en pantalla e imprimir documentos normales. Lo más adecuado para la mayoría de PDF y escaneos." },
  printer: { nombre: "Buena calidad", corto: "Buena calidad", desc: "Poca compresión, alta calidad (suele quedar en un 60-80 % del original). Imágenes hasta 200 ppp con calidad alta, aptas para imprimir. Si el PDF no se puede reducir, se conserva el original." },
  prepress: { nombre: "Mejor calidad", desc: "Sin pérdida apreciable de calidad y sin tocar las imágenes: el archivo apenas se reduce. Para imprenta o archivo definitivo.", corto: "Mejor calidad" },
};
interface AnalisisCompresion { tam: number; tam_imagenes: number; n_imagenes: number; ppp_max: number; estimado: number[]; }
type Zona = "marca" | "metadatos" | "formulario" | "lotes" | "combinar" | "comprimir" | "ocr" | "extraer" | "imagenes" | "reordenar" | "dividir" | "anotar" | "visor";

interface LineaRegistro { hora: string; tipo: "info" | "ok" | "err"; texto: string; }
interface ItemCola { ruta: string; estado: EstadoItem; mensaje?: string; }
interface ProgresoOcr { actual: number; total: number; }
interface ProcesoBloqueo { nombre: string; pid: number; }
interface InfoPdf { paginas: number; protegido: boolean; corrupto: boolean; error?: string; tamano_bytes: number; }
interface ResultadoValidacion { ruta: string; ok: boolean; protegido: boolean; corrupto: boolean; error?: string; }
interface PaginaReordenar { numeroOriginal: number; miniatura: string; }
interface HistorialItem {
  id: string;
  operacion: "combinar" | "comprimir" | "ocr" | "extraer" | "imagenes" | "reordenar" | "dividir" | "anotar" | "organizar" | "firmar";
  archivos: string[];
  resultado: string;
  fecha: string;
  ok: boolean;
}

interface EstadoUtils { gs: boolean; tesseract: boolean; version_gs?: string; version_tesseract?: string; carpeta_local?: string; carpeta_red?: string; }
interface ResumenProceso { ok: number; error: number; }

const CLAVE_CARPETA = "pdftool_ultima_carpeta";
function leerUltimaCarpeta(): string | undefined { return localStorage.getItem(CLAVE_CARPETA) || undefined; }
function guardarUltimaCarpeta(ruta: string) { const c = ruta.replace(/[\\/][^\\/]*$/, ""); if (c) localStorage.setItem(CLAVE_CARPETA, c); }
function nombreArchivo(ruta: string): string { return ruta.split(/[\\/]/).pop() || ruta; }
function rutaConSufijo(ruta: string, sufijo: string): string { const p = ruta.lastIndexOf("."); return p === -1 ? ruta + sufijo : ruta.slice(0, p) + sufijo + ruta.slice(p); }

function formatoTamano(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function horaActual(): string { return new Date().toLocaleTimeString("es-ES", { hour12: false }); }
function textoEstado(e: EstadoTarjeta): string { return { inactivo: "", procesando: "Procesando", hecho: "Listo", error: "Error" }[e]; }

function validarRango(rango: string, total: number): { valido: boolean; error?: string; paginas: number } {
  if (!rango.trim()) return { valido: false, paginas: 0 };
  let paginas = 0;
  for (const parte of rango.split(",")) {
    const t = parte.trim();
    if (!t) continue;
    if (t.includes("-")) {
      const [a, b] = t.split("-").map((x) => parseInt(x.trim(), 10));
      if (isNaN(a) || isNaN(b)) return { valido: false, error: `Número inválido en "${t}"`, paginas: 0 };
      if (a < 1 || b > total || a > b) return { valido: false, error: `Rango ${a}-${b} fuera de límites (1-${total})`, paginas: 0 };
      paginas += b - a + 1;
    } else {
      const n = parseInt(t, 10);
      if (isNaN(n)) return { valido: false, error: `Número inválido: "${t}"`, paginas: 0 };
      if (n < 1 || n > total) return { valido: false, error: `Página ${n} fuera de límites (1-${total})`, paginas: 0 };
      paginas++;
    }
  }
  return { valido: paginas > 0, paginas };
}

function rangoAPaginas(rango: string, total: number): Set<number> {
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

function paginasARango(pags: Set<number>): string {
  const l = [...pags].sort((a, b) => a - b);
  const partes: string[] = [];
  for (let i = 0; i < l.length;) {
    let j = i;
    while (j + 1 < l.length && l[j + 1] === l[j] + 1) j++;
    partes.push(j > i ? `${l[i]}-${l[j]}` : `${l[i]}`);
    i = j + 1;
  }
  return partes.join(", ");
}

function SvgCombinar() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="3" width="13" height="16" rx="2"/><path d="M4 8v11a2 2 0 0 0 2 2h11"/></svg>; }
function SvgComprimir() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>; }
function SvgOcr() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 9h8M8 13h5"/><path d="M3 7V5a2 2 0 0 1 2-2h2M3 17v2a2 2 0 0 0 2 2h2M21 7V5a2 2 0 0 0-2-2h-2M21 17v2a2 2 0 0 1-2 2h-2"/></svg>; }
function SvgAnotar() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>; }
function SvgExtraer() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 3v18"/><path d="M14 8l3 3-3 3"/></svg>; }
function SvgDividir() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="8" height="18" rx="1.5"/><rect x="13" y="3" width="8" height="18" rx="1.5"/><path d="M12 3v18" strokeDasharray="2 2"/></svg>; }
function SvgReordenar() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="7" height="9" rx="1.2"/><rect x="14" y="11" width="7" height="9" rx="1.2"/><path d="M9 16.5 4 21M4 21v-4M4 21h4"/><path d="M15 7.5 20 3M20 3v4M20 3h-4"/></svg>; }
function SvgAsa() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>; }
function SvgZoom() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>; }
function SvgCarpeta() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>; }
function SvgCandado() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>; }
function SvgImagenes() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>; }
function SvgCheck() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>; }
function SvgX() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>; }

const HERRAMIENTAS: { id: Zona; etiqueta: string; desc: string; grupo: string; icono: ReactNode }[] = [
  { id: "visor", etiqueta: "Visor y organizar", desc: "Abre PDF en pestañas, reorganiza y anota", grupo: "Documento", icono: <SvgReordenar /> },
  { id: "combinar", etiqueta: "Combinar", desc: "Une varios PDF en uno", grupo: "Organizar páginas", icono: <SvgCombinar /> },
  { id: "extraer", etiqueta: "Extraer páginas", desc: "Saca un rango como PDF nuevo", grupo: "Organizar páginas", icono: <SvgExtraer /> },
  { id: "dividir", etiqueta: "Dividir", desc: "Parte un PDF en varios", grupo: "Organizar páginas", icono: <SvgDividir /> },
  { id: "comprimir", etiqueta: "Comprimir", desc: "Reduce el tamaño del archivo", grupo: "Optimizar y convertir", icono: <SvgComprimir /> },
  { id: "ocr", etiqueta: "OCR", desc: "Hace buscable un PDF escaneado", grupo: "Optimizar y convertir", icono: <SvgOcr /> },
  { id: "imagenes", etiqueta: "Imágenes a PDF", desc: "Convierte fotos y escaneos en PDF", grupo: "Optimizar y convertir", icono: <SvgImagenes /> },
  { id: "marca", etiqueta: "Marca de agua y páginas", desc: "Marca de agua y numeración", grupo: "Editar contenido", icono: <I n="stamp" s={20} /> },
  { id: "formulario", etiqueta: "Rellenar formulario", desc: "Rellena y aplana campos", grupo: "Editar contenido", icono: <I n="form" s={20} /> },
  { id: "metadatos", etiqueta: "Metadatos y limpieza", desc: "Revisa y elimina datos ocultos", grupo: "Editar contenido", icono: <I n="shield" s={20} /> },
  { id: "lotes", etiqueta: "Lotes y perfiles", desc: "Procesa carpetas enteras", grupo: "Automatizar", icono: <I n="layers" s={20} /> },
];
const GRUPOS_HERRAMIENTAS = ["Documento", "Organizar páginas", "Optimizar y convertir", "Editar contenido", "Automatizar"];

export default function App() {
  const [registro, setRegistro] = useState<LineaRegistro[]>([]);
  const [registroAbierto, setRegistroAbierto] = useState(false);
  const [avisoUtilsAbierto, setAvisoUtilsAbierto] = useState(false);
  const registroRef = useRef<HTMLDivElement>(null);
  const [estadoCombinar, setEstadoCombinar] = useState<EstadoTarjeta>("inactivo");
  const [estadoComprimir, setEstadoComprimir] = useState<EstadoTarjeta>("inactivo");
  const [estadoOcr, setEstadoOcr] = useState<EstadoTarjeta>("inactivo");
  const [estadoExtraer, setEstadoExtraer] = useState<EstadoTarjeta>("inactivo");
  const [solicitudVisor, setSolicitudVisor] = useState<{ rutas: string[]; n: number } | null>(null);
  const [paletaAbierta, setPaletaAbierta] = useState(false);
  const [cola, setCola] = useState<{ archivos: ArchivoCola[]; ignorados: string[] } | null>(null);
  const [recientes, setRecientes] = useState<string[]>(() => { try { const v = JSON.parse(localStorage.getItem("pdftool_recientes") ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 8) : []; } catch { return []; } });
  const [tema, setTema] = useState<"claro" | "oscuro">(() => { let g: string | null = null; try { g = localStorage.getItem("pdftool_tema"); } catch { /* sin almacenamiento */ } if (g === "oscuro" || g === "claro") return g; try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "oscuro" : "claro"; } catch { return "claro"; } });
  const [verAtajos, setVerAtajos] = useState(false);
  const [estadoVisor, setEstadoVisor] = useState<{ nombre: string; paginas: number; cambios: boolean; modo: string } | null>(null);
  const [estadoAnotar, setEstadoAnotar] = useState<EstadoTarjeta>("inactivo");
  const [entradaAnotar, setEntradaAnotar] = useState<string | null>(null);
  const [anotaciones, setAnotaciones] = useState<Anot[]>([]);
  const [nivel, setNivel] = useState<NivelCompresion>("ebook");
  const [modoComp, setModoComp] = useState<"nivel" | "tamano">("nivel");
  const [maxMB, setMaxMB] = useState("2");
  const [dpiOcr, setDpiOcr] = useState<150 | 300 | 600>(300);
  const [corregirOrientacion, setCorregirOrientacion] = useState(false);
  const [progresoOcr, setProgresoOcr] = useState<ProgresoOcr | null>(null);
  const [indiceOcrActual, setIndiceOcrActual] = useState<number | null>(null);
  const [ultimaSalida, setUltimaSalida] = useState<string | null>(null);
  useEffect(() => {
    if (!ultimaSalida) return;
    const ruta = ultimaSalida;
    avisar({ tipo: "ok", titulo: "Archivo guardado", texto: ruta.split(/[\\/]/).pop(), acciones: [
      { texto: "Abrir", principal: true, hacer: () => abrirEnVisor([ruta]) },
      { texto: "Abrir carpeta", hacer: () => { invoke("abrir_carpeta", { ruta }).catch(() => {}); } },
    ] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ultimaSalida]);
  const [resumenUltimo, setResumenUltimo] = useState<ResumenProceso | null>(null);
  const [listaCombinar, setListaCombinar] = useState<string[]>([]);
  const [infosPdf, setInfosPdf] = useState<Record<string, InfoPdf>>({});
  const [erroresCombinar, setErroresCombinar] = useState<Record<string, string>>({});
  const [colaComprimir, setColaComprimir] = useState<ItemCola[]>([]);
  const [analisis, setAnalisis] = useState<Record<string, AnalisisCompresion | null>>({});
  const [colaOcr, setColaOcr] = useState<ItemCola[]>([]);
  const [entradaExtraer, setEntradaExtraer] = useState<string | null>(null);
  const [listaImagenes, setListaImagenes] = useState<string[]>([]);
  const [imagenesSeparadas, setImagenesSeparadas] = useState(false);
  const [estadoImagenes, setEstadoImagenes] = useState<EstadoTarjeta>("inactivo");
  const [rangoExtraer, setRangoExtraer] = useState("");
  const [entradaReordenar, setEntradaReordenar] = useState<string | null>(null);
  const [estadoReordenar, setEstadoReordenar] = useState<EstadoTarjeta>("inactivo");
  const [paginasReordenar, setPaginasReordenar] = useState<PaginaReordenar[]>([]);
  const [ordenOriginalReordenar, setOrdenOriginalReordenar] = useState<number[]>([]);
  const [paginasOriginalesReordenar, setPaginasOriginalesReordenar] = useState<PaginaReordenar[]>([]);
  const [cargandoMiniaturas, setCargandoMiniaturas] = useState(false);
  const [progresoMiniaturas, setProgresoMiniaturas] = useState<ProgresoOcr | null>(null);
  const [progresoReordenar, setProgresoReordenar] = useState<ProgresoOcr | null>(null);
  const [arrastreReordenar, setArrastreReordenar] = useState<{ origen: number | null; sobre: number | null; posicion: "antes" | "despues" }>({ origen: null, sobre: null, posicion: "antes" });
  const [seleccionReordenar, setSeleccionReordenar] = useState<number | null>(null);
  const [historialOrdenReordenar, setHistorialOrdenReordenar] = useState<PaginaReordenar[][]>([]);
  const [zoomReordenar, setZoomReordenar] = useState<{ src: string; numero: number } | null>(null);
  const [dialogoDescartarOrden, setDialogoDescartarOrden] = useState<{ resolver: (v: boolean) => void } | null>(null);

  // --- estados: DIVIDIR ---
  const [entradaDividir, setEntradaDividir] = useState<string | null>(null);
  const [estadoDividir, setEstadoDividir] = useState<EstadoTarjeta>("inactivo");
  const [modoDividir, setModoDividir] = useState<"cada" | "puntos">("cada");
  const [cadaNDividir, setCadaNDividir] = useState("10");
  const [puntosDividir, setPuntosDividir] = useState("");
  const [progresoDividir, setProgresoDividir] = useState<ProgresoOcr | null>(null);
  const [zonaActiva, setZonaActiva] = useState<Zona | null>(null);
  const [herramienta, setHerramienta] = useState<Zona>("visor");
  const herramientaRef = useRef<Zona>("visor");
  herramientaRef.current = herramienta;
  const [utils, setUtils] = useState<EstadoUtils | null>(null);
  const [arrastreOrigenCombinar] = useState<{ current: number | null }>({ current: null });
  const [arrastreOrigenComprimir] = useState<{ current: number | null }>({ current: null });
  const [arrastreOrigenOcr] = useState<{ current: number | null }>({ current: null });
  const [arrastreOrigenImagenes] = useState<{ current: number | null }>({ current: null });
  const [dialogoBloqueo, setDialogoBloqueo] = useState<{ procesos: ProcesoBloqueo[]; resolver: (v: boolean) => void } | null>(null);
  const [dialogoBorrado, setDialogoBorrado] = useState<{ rutas: string[]; resolver: (v: boolean) => void } | null>(null);
  const [dialogoSobrescritura, setDialogoSobrescritura] = useState<{ ruta: string; resolver: (v: "sobrescribir" | "renombrar" | "cancelar") => void } | null>(null);
  const [dialogoArchivosFallidos, setDialogoArchivosFallidos] = useState<{ archivos: { nombre: string; motivo: string }[]; resolver: (v: boolean) => void } | null>(null);
  const [flashCombinar, setFlashCombinar] = useState(false);
  const [dialogoDll, setDialogoDll] = useState(false);
  const [verManual, setVerManual] = useState(false);
  const [verAcerca, setVerAcerca] = useState(false);
  const [lateralCompacto, setLateralCompacto] = useState<boolean>(() => { try { return localStorage.getItem("pdftool_lateral_compacto") === "1"; } catch { return false; } });
  const alternarLateral = () => setLateralCompacto((v) => { const n = !v; try { localStorage.setItem("pdftool_lateral_compacto", n ? "1" : "0"); } catch { /* */ } return n; });
  const [dialogoCierre, setDialogoCierre] = useState(false);
  const [visorLog, setVisorLog] = useState<string | null>(null);
  const [historial, setHistorial] = useState<HistorialItem[]>([]);
  const [cargandoInfos, setCargandoInfos] = useState<Set<string>>(new Set());
  const [tiempoInicio, setTiempoInicio] = useState<number | null>(null);
  const [itemsCompletados, setItemsCompletados] = useState(0);
  const [eta, setEta] = useState<string | null>(null);
  const [archivosSobre, setArchivosSobre] = useState<string[] | null>(null);

  const algoProcesando = estadoCombinar === "procesando" || estadoComprimir === "procesando" || estadoOcr === "procesando" || estadoExtraer === "procesando" || estadoAnotar === "procesando" || estadoImagenes === "procesando" || estadoReordenar === "procesando" || cargandoMiniaturas || estadoDividir === "procesando";

  useEffect(() => { if (registroRef.current) registroRef.current.scrollTop = registroRef.current.scrollHeight; }, [registro, registroAbierto]);
  // Si aparece un error, el registro se despliega solo
  useEffect(() => { if (registro.length && registro[registro.length - 1].tipo === "err") setRegistroAbierto(true); }, [registro]);

  // Estimación previa del tamaño tras comprimir (solo lectura del PDF, no comprime)
  useEffect(() => {
    colaComprimir.forEach((it) => {
      if (it.ruta in analisis) return;
      setAnalisis((a) => ({ ...a, [it.ruta]: null }));
      invoke<AnalisisCompresion>("analizar_compresion", { ruta: it.ruta })
        .then((r) => setAnalisis((a) => ({ ...a, [it.ruta]: r })))
        .catch(() => setAnalisis((a) => ({ ...a, [it.ruta]: null })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colaComprimir]);

  const fechaLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

  const opIni = useRef<number | null>(null);
  const fraccionGlobal: number | null = (() => {
    const f = (p: ProgresoOcr | null) => (p ? p.actual / Math.max(p.total, 1) : null);
    if (cargandoMiniaturas) return f(progresoMiniaturas);
    if (estadoReordenar === "procesando") return f(progresoReordenar);
    if (estadoDividir === "procesando") return f(progresoDividir);
    if (estadoOcr === "procesando" && colaOcr.length > 0) return Math.min(1, ((indiceOcrActual ?? 0) + (progresoOcr ? progresoOcr.actual / Math.max(progresoOcr.total, 1) : 0)) / colaOcr.length);
    if (estadoComprimir === "procesando" && colaComprimir.length > 0) return colaComprimir.filter((c) => c.estado === "hecho" || c.estado === "error").length / colaComprimir.length;
    return null;
  })();
  useEffect(() => {
    if (!algoProcesando) { opIni.current = null; setEta(null); return; }
    if (opIni.current === null) opIni.current = Date.now();
    const fr = fraccionGlobal;
    if (fr !== null && fr > 0.04 && fr < 1) {
      const s = Math.round(((Date.now() - opIni.current) / 1000) * (1 - fr) / fr);
      setEta(s >= 90 ? `~${Math.round(s / 60)} min` : `~${Math.max(s, 1)} s`);
    } else setEta(null);
  }, [algoProcesando, fraccionGlobal]);

  function anotar(tipo: LineaRegistro["tipo"], texto: string) {
    const hora = horaActual();
    setRegistro((prev) => [...prev, { hora, tipo, texto }]);
    const tag = tipo === "ok" ? "OK  " : tipo === "err" ? "ERR " : "INFO";
    if (tipo === "err") avisar({ tipo: "err", titulo: "No se pudo completar", texto: texto.length > 220 ? texto.slice(0, 220) + "…" : texto });
    invoke("escribir_log", { linea: `${fechaLocal()} ${hora} [${tag}] ${texto}`, fecha: fechaLocal() }).catch(() => {});
  }

  useEffect(() => {
    const t = setTimeout(() => {
      invoke<EstadoUtils>("estado_utils").then(setUtils).catch(() => setUtils({ gs: false, tesseract: false }));
    }, 100);
    return () => clearTimeout(t);
  }, []);

  async function cargarInfoPdf(rutas: string[]) {
    setCargandoInfos((prev) => new Set([...prev, ...rutas]));
    const nuevas: Record<string, InfoPdf> = {};
    await Promise.all(rutas.map(async (r) => {
      try { nuevas[r] = await invoke<InfoPdf>("comprobar_pdf", { ruta: r }); }
      catch { nuevas[r] = { paginas: 0, protegido: false, corrupto: false, tamano_bytes: 0 }; }
    }));
    setInfosPdf((prev) => ({ ...prev, ...nuevas }));
    setCargandoInfos((prev) => { const s = new Set(prev); rutas.forEach((r) => s.delete(r)); return s; });
    return nuevas;
  }

  async function verificarProteccion(rutas: string[]): Promise<boolean> {
    const infos = await cargarInfoPdf(rutas);
    const protegidos = rutas.filter((r) => infos[r]?.protegido);
    if (protegidos.length > 0) { protegidos.forEach((r) => anotar("err", `PDF protegido: ${nombreArchivo(r)}`)); return false; }
    return true;
  }

  function agregarAColaUnica(prev: ItemCola[], rutas: string[]): { cola: ItemCola[]; duplicados: string[] } {
    const existentes = new Set(prev.map((it) => it.ruta));
    const nuevos = rutas.filter((r) => !existentes.has(r));
    const duplicados = rutas.filter((r) => existentes.has(r));
    return { cola: [...prev, ...nuevos.map((r): ItemCola => ({ ruta: r, estado: "pendiente" }))], duplicados };
  }

  function moverEnLista<T>(lista: T[], origen: number, destino: number): T[] {
    const copia = [...lista];
    const [item] = copia.splice(origen, 1);
    copia.splice(destino, 0, item);
    return copia;
  }

  useEffect(() => {
    const webview = getCurrentWebview();
    const promesa = webview.onDragDropEvent((ev) => {
      if (ev.payload.type === "enter") { setArchivosSobre(ev.payload.paths); }
      if (ev.payload.type === "leave" || ev.payload.type === "drop") { setArchivosSobre(null); }
      if (ev.payload.type === "over" || ev.payload.type === "enter") {
        const { x, y } = ev.payload.position;
        const el = document.elementFromPoint(x / window.devicePixelRatio, y / window.devicePixelRatio);
        setZonaActiva((el?.closest<HTMLElement>("[data-zona]")?.dataset.zona as Zona) ?? null);
        return;
      }
      if (ev.payload.type !== "drop") { setZonaActiva(null); return; }
      const { x, y } = ev.payload.position;
      const el = document.elementFromPoint(x / window.devicePixelRatio, y / window.devicePixelRatio);
      const zona = ((el?.closest<HTMLElement>("[data-zona]")?.dataset.zona as Zona | undefined) ?? herramientaRef.current);
      setZonaActiva(null);

      const todasLasRutas = ev.payload.paths;
      if (algoProcesando) return;

      // Filtro por zona: PDFs para operaciones PDF, imágenes para la tarjeta de imágenes
      const esPdf = (p: string) => p.toLowerCase().endsWith(".pdf");
      const esImagen = (p: string) => /\.(jpe?g|png|bmp|tiff?|gif|webp|heic|heif)$/i.test(p);

      if (zona === "imagenes") {
        const imgs = todasLasRutas.filter(esImagen);
        const noImagen = todasLasRutas.filter((p) => !esImagen(p));
        if (noImagen.length > 0) anotar("info", `${noImagen.length} archivo(s) ignorado(s): solo se aceptan imágenes en esta tarjeta`);
        if (imgs.length) {
          setListaImagenes((p) => [...new Set([...p, ...imgs])]);
          anotar("info", `Añadidas ${imgs.length} imagen(es)`);
        }
        return;
      }

      if (zona === "visor") {
        const archivos: ArchivoCola[] = todasLasRutas.filter((p) => esPdf(p) || esImagen(p)).map((p) => ({ ruta: p, tipo: esPdf(p) ? "pdf" : "imagen" }));
        const ignorados = todasLasRutas.filter((p) => !esPdf(p) && !esImagen(p));
        if (ignorados.length) anotar("info", `${ignorados.length} archivo(s) ignorado(s) (no son PDF ni imágenes): ${ignorados.slice(0, 3).map(nombreArchivo).join(", ")}${ignorados.length > 3 ? "…" : ""}`);
        if (archivos.length === 0) return;
        if (archivos.length === 1 && archivos[0].tipo === "pdf") setSolicitudVisor({ rutas: [archivos[0].ruta], n: Date.now() });
        else setCola({ archivos, ignorados });
        return;
      }

      // Para el resto de zonas, filtrar solo PDFs
      const rutas = todasLasRutas.filter(esPdf);
      const noPermitidos = todasLasRutas.filter((p) => !esPdf(p));
      if (noPermitidos.length > 0) anotar("info", `${noPermitidos.length} archivo(s) ignorado(s): solo se aceptan PDF`);
      if (!rutas.length) return;

      if (zona === "combinar") {
        const yaEnLista = new Set(listaCombinar);
        const nuevas = rutas.filter((r) => !yaEnLista.has(r));
        const dupes = rutas.filter((r) => yaEnLista.has(r));
        if (nuevas.length) { setListaCombinar((p) => [...p, ...nuevas]); cargarInfoPdf(nuevas); }
        if (dupes.length) anotar("info", `${dupes.length} archivo(s) ya estaban en la lista`);
        if (nuevas.length) anotar("info", `Añadidos ${nuevas.length} archivo(s) a Combinar`);
      } else if (zona === "comprimir") {
        const { cola, duplicados } = agregarAColaUnica(colaComprimir, rutas);
        setColaComprimir(cola);
        if (duplicados.length) anotar("info", `${duplicados.length} archivo(s) ya estaban en Comprimir`);
        if (rutas.length - duplicados.length > 0) anotar("info", `Añadidos ${rutas.length - duplicados.length} archivo(s) a Comprimir`);
      } else if (zona === "ocr") {
        const { cola, duplicados } = agregarAColaUnica(colaOcr, rutas);
        setColaOcr(cola);
        if (duplicados.length) anotar("info", `${duplicados.length} archivo(s) ya estaban en OCR`);
        if (rutas.length - duplicados.length > 0) anotar("info", `Añadidos ${rutas.length - duplicados.length} archivo(s) a OCR`);
      } else if (zona === "extraer" && rutas[0]) {
        setEntradaExtraer(rutas[0]); cargarInfoPdf([rutas[0]]); setEstadoExtraer("inactivo");
        anotar("info", `Archivo listo para extraer: ${nombreArchivo(rutas[0])}`);
      } else if (zona === "anotar" && rutas[0]) {
        setEntradaAnotar(rutas[0]); setAnotaciones([]); cargarInfoPdf([rutas[0]]); setEstadoAnotar("inactivo");
        anotar("info", `Archivo listo para anotar: ${nombreArchivo(rutas[0])}`);
      } else if (zona === "reordenar" && rutas[0]) {
        confirmarDescartarSiHaceFalta().then((ok) => { if (ok) cargarReordenar(rutas[0]); });
      } else if (zona === "marca" || zona === "formulario" || zona === "metadatos" || zona === "lotes") {
        window.dispatchEvent(new CustomEvent("pdftool-soltar", { detail: { zona, rutas } }));
      } else if (zona === "dividir" && rutas[0]) {
        setEntradaDividir(rutas[0]); cargarInfoPdf([rutas[0]]); setEstadoDividir("inactivo");
        anotar("info", `Archivo listo para dividir: ${nombreArchivo(rutas[0])}`);
      }
    });
    return () => { promesa.then((c) => c()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [algoProcesando, listaCombinar, colaComprimir, colaOcr]);

  useEffect(() => {
    const p = listen<ProgresoOcr>("ocr-progreso", (ev) => setProgresoOcr(ev.payload));
    return () => { p.then((c) => c()); };
  }, []);

  useEffect(() => {
    const p = listen<ProgresoOcr>("miniaturas-progreso", (ev) => setProgresoMiniaturas(ev.payload));
    return () => { p.then((c) => c()); };
  }, []);

  useEffect(() => {
    const p = listen<ProgresoOcr>("reordenar-progreso", (ev) => setProgresoReordenar(ev.payload));
    return () => { p.then((c) => c()); };
  }, []);

  useEffect(() => {
    const p = listen<ProgresoOcr>("dividir-progreso", (ev) => setProgresoDividir(ev.payload));
    return () => { p.then((c) => c()); };
  }, []);

  function preguntarDescartarOrden(): Promise<boolean> { return new Promise((r) => setDialogoDescartarOrden({ resolver: r })); }

  function preguntarBloqueo(procesos: ProcesoBloqueo[]): Promise<boolean> { return new Promise((r) => setDialogoBloqueo({ procesos, resolver: r })); }
  function preguntarBorrado(rutas: string[]): Promise<boolean> { return new Promise((r) => setDialogoBorrado({ rutas, resolver: r })); }
  function preguntarSobrescritura(ruta: string): Promise<"sobrescribir" | "renombrar" | "cancelar"> { return new Promise((r) => setDialogoSobrescritura({ ruta, resolver: r })); }

  async function comprobarYDesbloquear(rutas: string[]): Promise<boolean> {
    const existentes = rutas.filter(Boolean);
    if (!existentes.length) return true;
    let procesos: ProcesoBloqueo[] = [];
    try { procesos = await invoke<ProcesoBloqueo[]>("comprobar_bloqueo", { rutas: existentes }); } catch { return true; }
    if (!procesos.length) return true;
    const cerrar = await preguntarBloqueo(procesos);
    setDialogoBloqueo(null);
    if (!cerrar) return false;
    try { await invoke("cerrar_procesos", { pids: procesos.map((p) => p.pid) }); } catch (e) { anotar("err", amigable(String(e))); return false; }
    await new Promise((r) => setTimeout(r, 400));
    return true;
  }

  async function rutaDisponible(base: string): Promise<string | null> {
    const existe = await invoke<boolean>("archivo_existe", { ruta: base });
    if (!existe) return base;
    const opcion = await preguntarSobrescritura(base);
    setDialogoSobrescritura(null);
    if (opcion === "cancelar") return null;
    if (opcion === "sobrescribir") return base;
    const p = base.lastIndexOf(".");
    const sin = p !== -1 ? base.slice(0, p) : base;
    const ext = p !== -1 ? base.slice(p) : "";
    for (let n = 2; n < 100; n++) {
      const c = `${sin}_${n}${ext}`;
      if (!await invoke<boolean>("archivo_existe", { ruta: c })) return c;
    }
    return `${sin}_99${ext}`;
  }

  function esErrorDll(msg: string): boolean {
    const m = msg.toLowerCase();
    return m.includes("can't load") || m.includes("dll") || m.includes("load library") || m.includes("vcruntime");
  }

  function amigable(msg: string): string {
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

  function manejarErrorGs(e: unknown) {
    const msg = amigable(String(e));
    if (esErrorDll(msg)) {
      setDialogoDll(true);
    } else {
      anotar("err", msg);
    }
  }

  async function cancelar() {
    try { await invoke("cancelar_operacion"); anotar("info", "Cancelando..."); } catch (e) { anotar("err", amigable(String(e))); }
  }

  function calcularEta(inicio: number, completados: number, total: number): string | null {
    if (completados === 0) return null;
    const elapsed = (Date.now() - inicio) / 1000;
    const segsRestantes = Math.round((elapsed / completados) * (total - completados));
    if (segsRestantes < 60) return `~${segsRestantes}s`;
    const min = Math.floor(segsRestantes / 60);
    const seg = segsRestantes % 60;
    return seg > 0 ? `~${min}m ${seg}s` : `~${min}m`;
  }

  function guardarEnHistorial(item: Omit<HistorialItem, "id" | "fecha">) {
    const entrada: HistorialItem = { ...item, id: Date.now().toString(), fecha: new Date().toLocaleTimeString("es-ES", { hour12: false }) };
    setHistorial((prev) => [entrada, ...prev].slice(0, 5));
  }

  async function abrirLog() {
    try {
      const contenido = await invoke<string>("leer_log", { fecha: fechaLocal() });
      setVisorLog(contenido || "(El log está vacío)");
    } catch (e) { anotar("err", amigable(String(e))); }
  }

  async function iniciarOperacion() {
    await invoke("resetear_cancelacion");
    setTiempoInicio(Date.now());
    setItemsCompletados(0);
    setEta(null);
    setResumenUltimo(null);
  }

  // Solo resetea el flag de cancelación en el backend, sin tocar ETA/contadores.
  // Necesario en toda operación de un solo disparo (combinar, extraer, imágenes
  // combinadas, miniaturas, reordenar): si el usuario canceló una operación anterior,
  // el flag se queda en "true" en el backend hasta que alguien lo resetea explícitamente,
  // y si nadie lo hace la siguiente operación fallaría de inmediato como si ya estuviese cancelada.
  async function limpiarCancelacion() {
    try { await invoke("resetear_cancelacion"); } catch { /* no crítico */ }
  }

  function registrarItemCompletado(totalItems: number) {
    setItemsCompletados((prev) => {
      const nuevo = prev + 1;
      if (tiempoInicio) setEta(calcularEta(tiempoInicio, nuevo, totalItems));
      return nuevo;
    });
  }

  // --- COMBINAR ---
  async function agregarArchivosCombinar() {
    const rutas = await open({ multiple: true, defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!rutas) return;
    const yaEnLista = new Set(listaCombinar);
    const nuevas = rutas.filter((r) => !yaEnLista.has(r));
    const dupes = rutas.filter((r) => yaEnLista.has(r));
    if (nuevas.length) { setListaCombinar((p) => [...p, ...nuevas]); cargarInfoPdf(nuevas); guardarUltimaCarpeta(nuevas[0]); }
    if (dupes.length) anotar("info", `${dupes.length} archivo(s) ya estaban en la lista`);
  }
  function quitarDeCombinar(i: number) { setListaCombinar((p) => p.filter((_, j) => j !== i)); }
  function onDragStartCombinar(i: number) { arrastreOrigenCombinar.current = i; }
  function onDropCombinar(i: number) {
    const o = arrastreOrigenCombinar.current; arrastreOrigenCombinar.current = null;
    if (o === null || o === i) return;
    setListaCombinar((p) => moverEnLista(p, o, i));
  }

  const totalPaginasCombinar = listaCombinar.reduce((sum, r) => sum + (infosPdf[r]?.paginas ?? 0), 0);

  async function combinar() {
    if (!listaCombinar.length) return;
    await limpiarCancelacion();
    const validaciones = await invoke<ResultadoValidacion[]>("validar_pdfs", { rutas: listaCombinar });
    const fallidos = validaciones.filter((v) => !v.ok);
    if (fallidos.length > 0) {
      const nuevosErrores: Record<string, string> = {};
      fallidos.forEach((v) => {
        const motivo = v.protegido ? "protegido con contraseña" : v.corrupto ? "corrupto o inválido" : v.error || "error desconocido";
        nuevosErrores[v.ruta] = motivo;
        anotar("err", `${nombreArchivo(v.ruta)}: ${motivo}`);
      });
      setErroresCombinar(nuevosErrores);
      if (fallidos.length === listaCombinar.length) return;
      const continuar = await new Promise<boolean>((res) => setDialogoArchivosFallidos({ archivos: fallidos.map((v) => ({ nombre: nombreArchivo(v.ruta), motivo: v.protegido ? "protegido" : "corrupto" })), resolver: res }));
      setDialogoArchivosFallidos(null);
      if (!continuar) return;
      const validos = validaciones.filter((v) => v.ok).map((v) => v.ruta);
      if (!validos.length) return;
      return await combinarRutas(validos);
    }
    setErroresCombinar({});
    await combinarRutas(listaCombinar);
  }

  async function combinarRutas(rutas: string[]) {
    const salida = await save({ defaultPath: leerUltimaCarpeta() ? `${leerUltimaCarpeta()}\\combinado.pdf` : "combinado.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!salida) return;
    if (!await comprobarYDesbloquear([...rutas, salida])) { anotar("err", "Combinación cancelada: archivo en uso"); return; }
    setEstadoCombinar("procesando");
    anotar("info", `Combinando ${rutas.length} archivos`);
    try {
      await invoke("combinar_pdfs", { rutas, salida });
      setEstadoCombinar("hecho");
      guardarUltimaCarpeta(salida);
      anotar("ok", `Generado: ${salida}`);
      guardarEnHistorial({ operacion: "combinar", archivos: rutas, resultado: salida, ok: true });
      const rutas_a_borrar = [...listaCombinar];
      setListaCombinar([]); setInfosPdf({}); setErroresCombinar({});
      setFlashCombinar(true); setTimeout(() => setFlashCombinar(false), 2500);
      await abrirResultado(salida);
      const confirmar = await preguntarBorrado(rutas_a_borrar);
      setDialogoBorrado(null);
      if (confirmar) {
        const errores = await invoke<string[]>("borrar_archivos", { rutas: rutas_a_borrar });
        errores.length === 0 ? anotar("ok", `Borrados ${rutas_a_borrar.length} archivo(s) originales`) : errores.forEach((e) => anotar("err", e));
      } else { anotar("info", "Archivos originales conservados"); }
    } catch (e) { setEstadoCombinar("error"); manejarErrorGs(e); }
  }

  // --- COMPRIMIR ---
  async function agregarColaComprimir() {
    const rutas = await open({ multiple: true, defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!rutas) return;
    const { cola, duplicados } = agregarAColaUnica(colaComprimir, rutas);
    setColaComprimir(cola);
    if (duplicados.length) anotar("info", `${duplicados.length} archivo(s) ya estaban en Comprimir (omitidos)`);
    guardarUltimaCarpeta(rutas[0]);
  }
  function quitarDeColaComprimir(i: number) { setColaComprimir((p) => p.filter((_, j) => j !== i)); }
  function onDragStartComprimir(i: number) { arrastreOrigenComprimir.current = i; }
  function onDropComprimir(i: number) {
    const o = arrastreOrigenComprimir.current; arrastreOrigenComprimir.current = null;
    if (o === null || o === i) return;
    setColaComprimir((p) => moverEnLista(p, o, i));
  }

  async function procesarColaComprimir() {
    const pendientes = colaComprimir.map((it, i) => ({ ...it, idx: i })).filter((it) => it.estado === "pendiente");
    if (!pendientes.length) return;
    await iniciarOperacion();
    setEstadoComprimir("procesando");
    let okCount = 0; let errCount = 0; let ultimaSalidaOk: string | null = null;

    for (const { ruta, idx } of pendientes) {
      setColaComprimir((p) => p.map((it, i) => i === idx ? { ...it, estado: "procesando", mensaje: undefined } : it));
      if (!await verificarProteccion([ruta])) { setColaComprimir((p) => p.map((it, i) => i === idx ? { ...it, estado: "error", mensaje: "PDF protegido" } : it)); errCount++; continue; }
      const salidaBase = rutaConSufijo(ruta, "_compressed");
      const salida = await rutaDisponible(salidaBase);
      if (!salida) { setColaComprimir((p) => p.map((it, i) => i === idx ? { ...it, estado: "error", mensaje: "cancelado" } : it)); errCount++; continue; }
      const n = pendientes.findIndex((p) => p.idx === idx) + 1;
      anotar("info", modoComp === "tamano" ? `Comprimiendo hasta ${maxMB} MB [${n}/${pendientes.length}]: ${nombreArchivo(ruta)}` : `Comprimiendo (${NIVELES_COMPRESION[nivel].nombre}) [${n}/${pendientes.length}]: ${nombreArchivo(ruta)}`);
      if (!await comprobarYDesbloquear([ruta, salida])) { setColaComprimir((p) => p.map((it, i) => i === idx ? { ...it, estado: "error", mensaje: "en uso" } : it)); errCount++; continue; }
      try {
        const nombresNivel: Record<string, string> = { printer: "Buena calidad", ebook: "Equilibrada", screen: "Mínimo", extremo: "Compresión extrema", original: "sin cambios" };
        const limiteBytes = Math.round((parseFloat(maxMB.replace(",", ".")) || 0) * 1024 * 1024);
        const res = modoComp === "tamano"
          ? await invoke<{ tamano_entrada: number; tamano_salida: number; nivel: string; cumple: boolean }>("comprimir_a_tamano", { entrada: ruta, salida, maxBytes: limiteBytes })
          : await invoke<{ tamano_entrada: number; tamano_salida: number; nivel: string; cumple: boolean }>("comprimir_pdf", { entrada: ruta, salida, nivel });
        const red = res.tamano_entrada > 0 ? Math.round((1 - res.tamano_salida / res.tamano_entrada) * 100) : 0;
        let msg = res.tamano_salida >= res.tamano_entrada ? `${formatoTamano(res.tamano_entrada)} · ya estaba optimizado, se conserva el original` : `${formatoTamano(res.tamano_entrada)} → ${formatoTamano(res.tamano_salida)} (-${Math.abs(red)}%)`;
        if (modoComp === "tamano") {
          if (res.nivel === "original") msg = `${formatoTamano(res.tamano_entrada)} · ya cumplía el límite, sin cambios`;
          else if (res.cumple) msg += ` · nivel «${nombresNivel[res.nivel] ?? res.nivel}»`;
          else msg += ` · no se llegó a ${maxMB} MB; es lo mínimo posible`;
        }
        setColaComprimir((p) => p.map((it, i) => i === idx ? { ...it, estado: "hecho", mensaje: msg } : it));
        anotar("ok", `${nombreArchivo(ruta)}: ${msg}`); ultimaSalidaOk = salida; okCount++;
        guardarEnHistorial({ operacion: "comprimir", archivos: [ruta], resultado: salida, ok: true });
        registrarItemCompletado(pendientes.length);
      } catch (e) { const msg = String(e); setColaComprimir((p) => p.map((it, i) => i === idx ? { ...it, estado: "error", mensaje: esErrorDll(msg) ? "Error DLL — ver instrucciones" : amigable(msg) } : it)); manejarErrorGs(e); errCount++; }
    }
    setEstadoComprimir(errCount > 0 && okCount === 0 ? "error" : errCount > 0 ? "error" : "hecho");
    setEta(null);
    setResumenUltimo({ ok: okCount, error: errCount });
    if (ultimaSalidaOk) {
      if (pendientes.length === 1) await abrirResultado(ultimaSalidaOk);
      else { setUltimaSalida(ultimaSalidaOk); try { await invoke("abrir_carpeta", { ruta: ultimaSalidaOk }); } catch { } }
    }
    if (errCount === 0) setTimeout(() => { setColaComprimir([]); setEstadoComprimir("inactivo"); }, 2000);
  }

  // --- OCR ---
  async function agregarColaOcr() {
    const rutas = await open({ multiple: true, defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!rutas) return;
    const { cola, duplicados } = agregarAColaUnica(colaOcr, rutas);
    setColaOcr(cola);
    if (duplicados.length) anotar("info", `${duplicados.length} archivo(s) ya estaban en OCR`);
    guardarUltimaCarpeta(rutas[0]);
  }
  function quitarDeColaOcr(i: number) { setColaOcr((p) => p.filter((_, j) => j !== i)); }
  function onDragStartOcr(i: number) { arrastreOrigenOcr.current = i; }
  function onDropOcr(i: number) {
    const o = arrastreOrigenOcr.current; arrastreOrigenOcr.current = null;
    if (o === null || o === i) return;
    setColaOcr((p) => moverEnLista(p, o, i));
  }

  async function procesarColaOcr() {
    const pendientes = colaOcr.map((it, i) => ({ ...it, idx: i })).filter((it) => it.estado === "pendiente");
    if (!pendientes.length) return;
    await iniciarOperacion();
    setEstadoOcr("procesando");
    let okCount = 0; let errCount = 0; let ultimaSalidaOk: string | null = null;

    for (const { ruta, idx } of pendientes) {
      setIndiceOcrActual(idx); setProgresoOcr(null);
      setColaOcr((p) => p.map((it, i) => i === idx ? { ...it, estado: "procesando", mensaje: undefined } : it));
      if (!await verificarProteccion([ruta])) { setColaOcr((p) => p.map((it, i) => i === idx ? { ...it, estado: "error", mensaje: "PDF protegido" } : it)); errCount++; continue; }
      const salidaBase = rutaConSufijo(ruta, "_OCR");
      const salida = await rutaDisponible(salidaBase);
      if (!salida) { setColaOcr((p) => p.map((it, i) => i === idx ? { ...it, estado: "error", mensaje: "cancelado" } : it)); errCount++; continue; }
      const n = pendientes.findIndex((p) => p.idx === idx) + 1;
      anotar("info", `OCR [${n}/${pendientes.length}]: ${nombreArchivo(ruta)}`);
      if (!await comprobarYDesbloquear([ruta, salida])) { setColaOcr((p) => p.map((it, i) => i === idx ? { ...it, estado: "error", mensaje: "en uso" } : it)); errCount++; continue; }
      try {
        await invoke("ocr_pdf", { entrada: ruta, salida, idioma: "spa", dpi: dpiOcr, corregirOrientacion });
        setColaOcr((p) => p.map((it, i) => i === idx ? { ...it, estado: "hecho", mensaje: "listo" } : it));
        anotar("ok", `Generado: ${salida}`); ultimaSalidaOk = salida; okCount++;
        registrarItemCompletado(pendientes.length);
        guardarEnHistorial({ operacion: "ocr", archivos: [ruta], resultado: salida, ok: true });
      } catch (e) { const msg = String(e); setColaOcr((p) => p.map((it, i) => i === idx ? { ...it, estado: "error", mensaje: esErrorDll(msg) ? "Error DLL — ver instrucciones" : amigable(msg) } : it)); manejarErrorGs(e); errCount++; }
    }
    setEstadoOcr(errCount > 0 && okCount === 0 ? "error" : errCount > 0 ? "error" : "hecho");
    setProgresoOcr(null); setIndiceOcrActual(null); setEta(null);
    setResumenUltimo({ ok: okCount, error: errCount });
    if (ultimaSalidaOk) {
      if (pendientes.length === 1) await abrirResultado(ultimaSalidaOk);
      else { setUltimaSalida(ultimaSalidaOk); try { await invoke("abrir_carpeta", { ruta: ultimaSalidaOk }); } catch { } }
    }
    if (errCount === 0) setTimeout(() => { setColaOcr([]); setEstadoOcr("inactivo"); }, 2000);
  }

  // --- IMÁGENES A PDF ---
  const EXTS_IMAGEN = ["jpg", "jpeg", "png", "bmp", "tiff", "tif", "gif", "webp", "heic", "heif"];

  async function agregarImagenes() {
    const rutas = await open({
      multiple: true,
      defaultPath: leerUltimaCarpeta(),
      filters: [{ name: "Imágenes", extensions: EXTS_IMAGEN }],
    });
    if (!rutas) return;
    setListaImagenes((p) => [...new Set([...p, ...rutas])]);
    guardarUltimaCarpeta(rutas[0]);
  }

  async function convertirImagenes() {
    if (!listaImagenes.length) return;
    await limpiarCancelacion();

    if (!imagenesSeparadas) {
      // ── Modo combinado: todas las imágenes → un único PDF ──
      const s = await save({
        defaultPath: leerUltimaCarpeta() ? `${leerUltimaCarpeta()}\\imagenes.pdf` : "imagenes.pdf",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!s) return;
      const salida = await rutaDisponible(s);
      if (!salida) return;

      setEstadoImagenes("procesando");
      anotar("info", `Convirtiendo ${listaImagenes.length} imagen(es) a un único PDF A4`);
      try {
        await invoke("imagenes_a_pdf", { rutas: listaImagenes, salida, separados: false });
        setEstadoImagenes("hecho");
        anotar("ok", `Generado: ${salida}`);
        guardarEnHistorial({ operacion: "imagenes", archivos: listaImagenes, resultado: salida, ok: true });
        await abrirResultado(salida);
        setTimeout(() => { setListaImagenes([]); setEstadoImagenes("inactivo"); }, 2000);
      } catch (e) { setEstadoImagenes("error"); manejarErrorGs(e); }

    } else {
      // ── Modo separado: una imagen → un PDF, con comprobación de sobrescritura ──
      setEstadoImagenes("procesando");
      anotar("info", `Convirtiendo ${listaImagenes.length} imagen(es) a PDF A4 separados`);
      let okCount = 0; let errCount = 0; let ultimaOk: string | null = null;

      for (const ruta of listaImagenes) {
        const salidaBase = ruta.replace(/\.[^.]+$/, ".pdf");
        const salida = await rutaDisponible(salidaBase);
        if (!salida) { anotar("info", `Omitido: ${nombreArchivo(ruta)}`); errCount++; continue; }
        anotar("info", `Convirtiendo [${okCount + errCount + 1}/${listaImagenes.length}]: ${nombreArchivo(ruta)}`);
        try {
          await invoke("imagen_a_pdf", { ruta, salida });
          anotar("ok", `Generado: ${salida}`);
          guardarEnHistorial({ operacion: "imagenes", archivos: [ruta], resultado: salida, ok: true });
          ultimaOk = salida; okCount++;
        } catch (e) { manejarErrorGs(e); errCount++; }
      }

      setEstadoImagenes(errCount > 0 && okCount === 0 ? "error" : "hecho");
      setResumenUltimo({ ok: okCount, error: errCount });
      if (ultimaOk) { setUltimaSalida(ultimaOk); try { await invoke("abrir_carpeta", { ruta: ultimaOk }); } catch { } }
      if (errCount === 0) setTimeout(() => { setListaImagenes([]); setEstadoImagenes("inactivo"); }, 2000);
    }
  }

  // --- EXTRAER ---
  async function seleccionarExtraer() {
    const ruta = await open({ defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!ruta || Array.isArray(ruta)) return;
    setEntradaExtraer(ruta); setEstadoExtraer("inactivo"); cargarInfoPdf([ruta]);
  }

  // Limpiar rango cuando se selecciona un archivo nuevo
  const prevEntradaExtraer = useRef<string | null>(null);
  useEffect(() => {
    if (entradaExtraer && entradaExtraer !== prevEntradaExtraer.current) {
      setRangoExtraer("");
    }
    prevEntradaExtraer.current = entradaExtraer;
  }, [entradaExtraer]);

  // --- DIVIDIR ---
  function calcularRangosDividir(modo: "cada" | "puntos", cadaN: string, puntos: string, total: number): { rangos: [number, number][]; error?: string } {
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

  const infoDividir = entradaDividir ? infosPdf[entradaDividir] : null;
  const calculoDividir = infoDividir && !infoDividir.protegido && infoDividir.paginas > 0
    ? calcularRangosDividir(modoDividir, cadaNDividir, puntosDividir, infoDividir.paginas)
    : { rangos: [] as [number, number][] };

  async function seleccionarDividir() {
    const ruta = await open({ defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!ruta || Array.isArray(ruta)) return;
    setEntradaDividir(ruta); setEstadoDividir("inactivo"); setPuntosDividir(""); cargarInfoPdf([ruta]);
  }

  async function dividir() {
    if (!entradaDividir || calculoDividir.rangos.length === 0) return;
    if (!await verificarProteccion([entradaDividir])) return;
    await limpiarCancelacion();
    setEstadoDividir("procesando");
    setProgresoDividir(null);
    anotar("info", `Dividiendo ${nombreArchivo(entradaDividir)} en ${calculoDividir.rangos.length} parte(s)`);
    try {
      const generados = await invoke<string[]>("dividir_pdf", { entrada: entradaDividir, rangos: calculoDividir.rangos });
      setEstadoDividir("hecho");
      anotar("ok", `Generado(s) ${generados.length} archivo(s)`);
      guardarEnHistorial({ operacion: "dividir", archivos: [entradaDividir], resultado: generados[0], ok: true });
      if (generados.length === 1) await abrirResultado(generados[0]);
      else { setUltimaSalida(generados[0]); try { await invoke("abrir_carpeta", { ruta: generados[0] }); } catch { } }
    } catch (e) {
      setEstadoDividir("error");
      const msg = String(e);
      if (msg.includes("Operación cancelada")) { anotar("info", "División cancelada"); }
      else { manejarErrorGs(e); }
    } finally {
      setProgresoDividir(null);
    }
  }

  // --- REORDENAR ---
  async function cargarReordenar(ruta: string) {
    setEntradaReordenar(ruta);
    setEstadoReordenar("inactivo");
    setPaginasReordenar([]);
    setOrdenOriginalReordenar([]);
    setPaginasOriginalesReordenar([]);
    setHistorialOrdenReordenar([]);
    setSeleccionReordenar(null);
    setProgresoMiniaturas(null);
    if (!await verificarProteccion([ruta])) { setEntradaReordenar(null); return; }
    await limpiarCancelacion();
    setCargandoMiniaturas(true);
    anotar("info", `Generando miniaturas de ${nombreArchivo(ruta)}...`);
    try {
      const miniaturas = await invoke<string[]>("generar_miniaturas_paginas", { entrada: ruta });
      const paginas = miniaturas.map((m, i) => ({ numeroOriginal: i + 1, miniatura: m }));
      setPaginasReordenar(paginas);
      setOrdenOriginalReordenar(paginas.map((p) => p.numeroOriginal));
      setPaginasOriginalesReordenar(paginas);
      anotar("ok", `${miniaturas.length} miniatura(s) generada(s)`);
    } catch (e) {
      setEntradaReordenar(null);
      const msg = String(e);
      if (msg.includes("Operación cancelada")) { anotar("info", "Generación de miniaturas cancelada"); }
      else { manejarErrorGs(e); }
    } finally {
      setCargandoMiniaturas(false);
      setProgresoMiniaturas(null);
    }
  }

  const ordenCambiadoReordenar = paginasReordenar.some((p, i) => p.numeroOriginal !== ordenOriginalReordenar[i]);

  // Antes de descartar el orden actual (cambiar de archivo / soltar uno nuevo), pide confirmación si hay cambios sin guardar.
  async function confirmarDescartarSiHaceFalta(): Promise<boolean> {
    if (!ordenCambiadoReordenar) return true;
    const ok = await preguntarDescartarOrden();
    setDialogoDescartarOrden(null);
    return ok;
  }

  async function seleccionarReordenar() {
    if (!await confirmarDescartarSiHaceFalta()) return;
    const ruta = await open({ defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!ruta || Array.isArray(ruta)) return;
    await cargarReordenar(ruta);
  }

  function cambiarArchivoReordenar() { seleccionarReordenar(); }

  async function limpiarReordenar() {
    if (!await confirmarDescartarSiHaceFalta()) return;
    setEntradaReordenar(null);
    setPaginasReordenar([]);
    setOrdenOriginalReordenar([]);
    setPaginasOriginalesReordenar([]);
    setHistorialOrdenReordenar([]);
    setSeleccionReordenar(null);
    setEstadoReordenar("inactivo");
  }

  // Guarda un punto en el historial de "deshacer" antes de aplicar un cambio de orden.
  function registrarHistorialReordenar(previo: PaginaReordenar[]) {
    setHistorialOrdenReordenar((h) => [...h.slice(-19), previo]);
  }

  function deshacerReordenar() {
    setHistorialOrdenReordenar((h) => {
      if (h.length === 0) return h;
      const anterior = h[h.length - 1];
      setPaginasReordenar(anterior);
      return h.slice(0, -1);
    });
    setSeleccionReordenar(null);
  }

  function moverPaginaA(origen: number, destino: number) {
    if (origen === destino || destino < 0 || destino >= paginasReordenar.length) return;
    registrarHistorialReordenar(paginasReordenar);
    setPaginasReordenar((prev) => {
      const copia = [...prev];
      const [movida] = copia.splice(origen, 1);
      copia.splice(destino, 0, movida);
      return copia;
    });
    setSeleccionReordenar(destino);
  }

  function eliminarPaginaReordenar(index: number) {
    if (paginasReordenar.length <= 1) return; // no puede quedar el documento sin páginas
    registrarHistorialReordenar(paginasReordenar);
    setPaginasReordenar((prev) => prev.filter((_, i) => i !== index));
    setSeleccionReordenar(null);
  }

  function onDragStartReordenar(index: number) { setSeleccionReordenar(index); setArrastreReordenar({ origen: index, sobre: index, posicion: "antes" }); }
  function onDragOverReordenar(index: number, e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const posicion: "antes" | "despues" = e.clientX - rect.left < rect.width / 2 ? "antes" : "despues";
    setArrastreReordenar((s) => (s.sobre === index && s.posicion === posicion ? s : { ...s, sobre: index, posicion }));
  }
  function onDragEndReordenar() { setArrastreReordenar({ origen: null, sobre: null, posicion: "antes" }); }
  function onDropReordenar(indexObjetivo: number) {
    const { origen, posicion } = arrastreReordenar;
    if (origen === null) { onDragEndReordenar(); return; }
    let destino = posicion === "antes" ? indexObjetivo : indexObjetivo + 1;
    if (origen < destino) destino -= 1; // compensar el hueco que deja quitar el elemento de origen
    if (destino !== origen) moverPaginaA(origen, destino);
    onDragEndReordenar();
  }

  function restablecerReordenar() {
    // Usa la lista original completa (no la actual), porque la actual puede
    // tener páginas eliminadas que "restablecer" debe traer de vuelta.
    registrarHistorialReordenar(paginasReordenar);
    setPaginasReordenar((_prev) => {
      const mapa = new Map(paginasOriginalesReordenar.map((p) => [p.numeroOriginal, p]));
      return ordenOriginalReordenar.map((n) => mapa.get(n)!);
    });
    setSeleccionReordenar(null);
  }

  async function guardarReordenar() {
    if (!entradaReordenar || paginasReordenar.length === 0) return;
    const orden = paginasReordenar.map((p) => p.numeroOriginal);
    const salidaBase = rutaConSufijo(entradaReordenar, "_reordenado");
    const salida = await rutaDisponible(salidaBase);
    if (!salida) return;
    await limpiarCancelacion();
    setEstadoReordenar("procesando");
    setProgresoReordenar(null);
    anotar("info", `Reordenando páginas de ${nombreArchivo(entradaReordenar)}`);
    try {
      await invoke("reordenar_paginas", { entrada: entradaReordenar, orden, salida });
      setEstadoReordenar("hecho"); anotar("ok", `Generado: ${salida}`);
      guardarEnHistorial({ operacion: "reordenar", archivos: [entradaReordenar], resultado: salida, ok: true });
      setOrdenOriginalReordenar(orden);
      setPaginasOriginalesReordenar(paginasReordenar);
      setHistorialOrdenReordenar([]);
      await abrirResultado(salida);
    } catch (e) {
      setEstadoReordenar("error");
      const msg = String(e);
      if (msg.includes("Operación cancelada")) { anotar("info", "Reordenación cancelada"); }
      else { manejarErrorGs(e); }
    } finally {
      setProgresoReordenar(null);
    }
  }

  // Mover con teclado la página seleccionada (accesibilidad, y mucho más rápido que arrastrar en PDFs largos)
  useEffect(() => {
    if (seleccionReordenar === null || algoProcesando) return;
    function onKey(e: KeyboardEvent) {
      const objetivo = e.target as HTMLElement;
      if (objetivo && ["INPUT", "TEXTAREA"].includes(objetivo.tagName)) return;
      if (seleccionReordenar === null) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); moverPaginaA(seleccionReordenar, seleccionReordenar - 1); }
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); moverPaginaA(seleccionReordenar, seleccionReordenar + 1); }
      else if (e.key === "Home") { e.preventDefault(); moverPaginaA(seleccionReordenar, 0); }
      else if (e.key === "End") { e.preventDefault(); moverPaginaA(seleccionReordenar, paginasReordenar.length - 1); }
      else if (e.key === "Escape") { setSeleccionReordenar(null); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seleccionReordenar, paginasReordenar, algoProcesando]);


  // Atajos de teclado
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && algoProcesando) { cancelar(); return; }
      if (e.key === "Escape" && verAcerca) { setVerAcerca(false); return; }
      if (e.key === "Escape" && verManual) { setVerManual(false); return; }
      if (e.key === "Escape" && visorLog) { setVisorLog(null); return; }
      if (e.key === "Escape" && dialogoCierre) { setDialogoCierre(false); return; }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [algoProcesando, visorLog, dialogoCierre]);

  // Interceptar cierre de ventana
  useEffect(() => {
    const hayOrdenSinGuardar = paginasReordenar.some((p, i) => p.numeroOriginal !== ordenOriginalReordenar[i]);
    const p = listen("close-requested", () => {
      if (algoProcesando || hayOrdenSinGuardar) { setDialogoCierre(true); }
      else { invoke("cerrar_ventana"); }
    });
    return () => { p.then((c) => c()); };
  }, [algoProcesando, paginasReordenar, ordenOriginalReordenar]);

  const infoExtraer = entradaExtraer ? infosPdf[entradaExtraer] : null;
  const validacionRango = infoExtraer && !infoExtraer.protegido && infoExtraer.paginas > 0 && rangoExtraer.trim()
    ? validarRango(rangoExtraer, infoExtraer.paginas)
    : null;

  async function extraer() {
    if (!entradaExtraer || !rangoExtraer.trim()) return;
    await limpiarCancelacion();
    if (!await verificarProteccion([entradaExtraer])) return;
    const salidaBase = rutaConSufijo(entradaExtraer, `_pags_${rangoExtraer.replace(/\s/g, "").replace(/,/g, "-")}`);
    const salida = await rutaDisponible(salidaBase);
    if (!salida) return;
    setEstadoExtraer("procesando");
    anotar("info", `Extrayendo [${rangoExtraer}] de ${nombreArchivo(entradaExtraer)}`);
    try {
      await invoke("extraer_paginas", { entrada: entradaExtraer, rango: rangoExtraer, salida });
      setEstadoExtraer("hecho"); anotar("ok", `Generado: ${salida}`);
      guardarEnHistorial({ operacion: "extraer", archivos: [entradaExtraer!], resultado: salida, ok: true });
      await abrirResultado(salida);
    } catch (e) { setEstadoExtraer("error"); manejarErrorGs(e); }
  }

  useEffect(() => {
    document.documentElement.dataset.tema = tema;
    try { localStorage.setItem("pdftool_tema", tema); } catch { /* sin almacenamiento */ }
  }, [tema]);

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "b") { e.preventDefault(); alternarLateral(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletaAbierta((v) => !v); }
      const t = e.target as HTMLElement | null; const escribiendo = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); abrirPdfsVisor(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") { e.preventDefault(); window.dispatchEvent(new CustomEvent("pdftool-visor", { detail: "cerrar" })); }
      if (e.key === "?" && !escribiendo) { e.preventDefault(); setVerAtajos((v) => !v); }
      if (e.key === "Escape") setVerAtajos(false);
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  function anadirReciente(ruta: string) {
    if (!ruta.toLowerCase().endsWith(".pdf")) return;
    setRecientes((prev) => {
      const nuevo = [ruta, ...prev.filter((r) => r !== ruta)].slice(0, 8);
      try { localStorage.setItem("pdftool_recientes", JSON.stringify(nuevo)); } catch { /* sin almacenamiento */ }
      return nuevo;
    });
  }
  function borrarRecientes() {
    setRecientes([]);
    try { localStorage.removeItem("pdftool_recientes"); } catch { /* sin almacenamiento */ }
  }
  function abrirEnVisor(rutas: string[]) {
    setHerramienta("visor");
    setSolicitudVisor({ rutas, n: Date.now() });
  }

  // Recordar tamaño de la ventana entre sesiones
  useEffect(() => {
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    let desuscribir: (() => void) | undefined;
    (async () => {
      try {
        const v = JSON.parse(localStorage.getItem("pdftool_ventana") ?? "null");
        if (v && v.w >= 820 && v.h >= 700) await getCurrentWindow().setSize(new LogicalSize(v.w, v.h));
      } catch { /* sin permiso o sin datos: tamaño por defecto */ }
      try {
        desuscribir = await getCurrentWindow().onResized(async () => {
          clearTimeout(temporizador);
          temporizador = setTimeout(async () => {
            try {
              const w = getCurrentWindow();
              if (await w.isMaximized()) return;
              const t = await w.innerSize(); const f = await w.scaleFactor();
              localStorage.setItem("pdftool_ventana", JSON.stringify({ w: Math.round(t.width / f), h: Math.round(t.height / f) }));
            } catch { /* ignorar */ }
          }, 400);
        });
      } catch { /* ignorar */ }
    })();
    return () => { clearTimeout(temporizador); desuscribir?.(); };
  }, []);

  async function combinarMixto(rutas: string[]) {
    await limpiarCancelacion();
    const salida = await save({ defaultPath: leerUltimaCarpeta() ? `${leerUltimaCarpeta()}\\combinado.pdf` : "combinado.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!salida) return;
    if (!await comprobarYDesbloquear([salida])) { anotar("err", "Combinación cancelada: archivo en uso"); return; }
    setEstadoCombinar("procesando");
    anotar("info", `Convirtiendo y combinando ${rutas.length} archivos`);
    let dirTmp: string | null = null;
    try {
      const prep = await invoke<{ dir: string; rutas: string[] }>("preparar_mixto", { rutas });
      dirTmp = prep.dir;
      await invoke("combinar_pdfs", { rutas: prep.rutas, salida });
      setEstadoCombinar("hecho");
      guardarUltimaCarpeta(salida);
      anotar("ok", `Generado: ${salida}`);
      guardarEnHistorial({ operacion: "combinar", archivos: rutas, resultado: salida, ok: true });
      await abrirResultado(salida);
    } catch (e) { setEstadoCombinar("error"); manejarErrorGs(e); }
    finally { if (dirTmp) invoke("limpiar_carpeta_cola", { dir: dirTmp }).catch(() => {}); }
  }

  async function abrirPdfsVisor() {
    const rutas = await open({ multiple: true, defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!rutas) return;
    const lista = Array.isArray(rutas) ? rutas : [rutas];
    setHerramienta("visor");
    setSolicitudVisor({ rutas: lista, n: Date.now() });
  }

  async function seleccionarAnotar() {
    if (anotaciones.length > 0 && !(await confirmar({ titulo: "¿Descartar las anotaciones?", texto: "Hay anotaciones sin guardar. Si cambias de archivo se perderán.", ok: "Descartar", peligro: true }))) return;
    const ruta = await open({ defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!ruta || Array.isArray(ruta)) return;
    setEntradaAnotar(ruta); setAnotaciones([]); setEstadoAnotar("inactivo"); cargarInfoPdf([ruta]);
  }

  async function guardarAnotaciones() {
    if (!entradaAnotar || anotaciones.length === 0) return;
    await limpiarCancelacion();
    if (!await verificarProteccion([entradaAnotar])) return;
    const salida = await rutaDisponible(rutaConSufijo(entradaAnotar, "_anotado"));
    if (!salida) return;
    setEstadoAnotar("procesando");
    anotar("info", `Guardando ${anotaciones.length} anotación(es) en ${nombreArchivo(entradaAnotar)}`);
    try {
      await invoke("guardar_anotaciones", { entrada: entradaAnotar, salida, anotaciones });
      setEstadoAnotar("hecho"); anotar("ok", `Generado: ${salida}`);
      guardarEnHistorial({ operacion: "anotar", archivos: [entradaAnotar], resultado: salida, ok: true });
      await abrirResultado(salida);
    } catch (e) { setEstadoAnotar("error"); manejarErrorGs(e); }
  }

  async function abrirCarpetaSalida() {
    if (!ultimaSalida) return;
    try { await invoke("abrir_carpeta", { ruta: ultimaSalida }); } catch (e) { anotar("err", amigable(String(e))); }
  }
  // Ya no abre programas externos automáticamente: deja una barra con «Ver en el visor / Abrir / Abrir carpeta / Borrar copia».
  async function abrirResultado(ruta: string) {
    setUltimaSalida(ruta);
    anadirReciente(ruta);
  }

  async function abrirSalidaExterna() {
    if (!ultimaSalida) return;
    try { await invoke("abrir_archivo", { ruta: ultimaSalida }); } catch (e) { anotar("err", amigable(String(e))); }
  }

  async function borrarUltimaSalida() {
    if (!ultimaSalida) return;
    if (!(await confirmar({ titulo: "¿Borrar la copia generada?", texto: `${ultimaSalida}\n\nLos archivos originales no se tocan.`, ok: "Borrar copia", peligro: true }))) return;
    try {
      await invoke("eliminar_archivo", { ruta: ultimaSalida });
      anotar("ok", `Copia borrada: ${nombreArchivo(ultimaSalida)}`);
      setRecientes((prev) => { const n = prev.filter((r) => r !== ultimaSalida); try { localStorage.setItem("pdftool_recientes", JSON.stringify(n)); } catch { /* */ } return n; });
      setUltimaSalida(null);
    } catch (e) { anotar("err", amigable(String(e))); }
  }

  function claseTarjeta(zona: Zona, tieneContenido = false) {
    const activa = algoProcesando && (
      (zona === "imagenes" && estadoImagenes === "procesando") ||
      (zona === "combinar" && estadoCombinar === "procesando") ||
      (zona === "comprimir" && estadoComprimir === "procesando") ||
      (zona === "ocr" && estadoOcr === "procesando") ||
      (zona === "extraer" && estadoExtraer === "procesando") ||
      (zona === "anotar" && estadoAnotar === "procesando") ||
      (zona === "reordenar" && (estadoReordenar === "procesando" || cargandoMiniaturas)) ||
      (zona === "dividir" && estadoDividir === "procesando")
    );
    return `tarjeta${herramienta !== zona ? " oculta" : ""}${zonaActiva === zona ? " arrastrando" : ""}${tieneContenido ? " con-contenido" : ""}${activa ? " tarjeta-activa" : ""}`;
  }

  const pendientesComprimir = colaComprimir.filter((it) => it.estado === "pendiente").length;
  const pendientesOcr = colaOcr.filter((it) => it.estado === "pendiente").length;

  const enVisor = (detail: string) => { setHerramienta("visor"); setTimeout(() => window.dispatchEvent(new CustomEvent("pdftool-visor", { detail })), 0); };
  const gruposMenu: GrupoMenu[] = [
    { titulo: "Archivo", items: [
      { texto: "Abrir PDF…", atajo: "Ctrl+O", hacer: abrirPdfsVisor },
      { texto: "Abrir reciente", sub: recientes.map((r) => ({ texto: nombreArchivo(r), hacer: () => abrirEnVisor([r]) })) },
      { sep: true },
      { texto: "Cerrar documento", atajo: "Ctrl+W", hacer: () => enVisor("cerrar"), off: !estadoVisor },
      { sep: true },
      { texto: "Salir", atajo: "Alt+F4", hacer: () => { getCurrentWindow().close().catch(() => {}); } },
    ] },
    { titulo: "Edición", items: [
      { texto: "Deshacer", atajo: "Ctrl+Z", hacer: () => enVisor("deshacer"), off: !estadoVisor },
      { texto: "Rehacer", atajo: "Ctrl+Y", hacer: () => enVisor("rehacer"), off: !estadoVisor },
      { sep: true },
      { texto: "Buscar acción…", atajo: "Ctrl+K", hacer: () => setPaletaAbierta(true) },
    ] },
    { titulo: "Ver", items: [
      { texto: lateralCompacto ? "Ampliar panel lateral" : "Encoger panel lateral", atajo: "Ctrl+B", hacer: alternarLateral },
      { texto: tema === "oscuro" ? "Tema claro" : "Tema oscuro", hacer: () => setTema(tema === "oscuro" ? "claro" : "oscuro") },
    ] },
    { titulo: "Herramientas", items: HERRAMIENTAS.map((h) => ({ texto: h.etiqueta, hacer: () => setHerramienta(h.id) })) },
    { titulo: "Ayuda", items: [
      { texto: "Manual de usuario", hacer: () => setVerManual(true) },
      { texto: "Atajos de teclado", atajo: "?", hacer: () => setVerAtajos(true) },
      { texto: "Ver log", hacer: abrirLog },
      { sep: true },
      { texto: "Acerca de PDF Tool", hacer: () => setVerAcerca(true) },
    ] },
  ];

  return (
    <div className="shell">
      <div className="cabecera">
        <div className="marca">
          <div className="logo">PDF</div>
          <div>
            <h1>PDF Tool</h1>
            <span className="subtitulo">Combinar · Comprimir · OCR · Extraer · Imágenes</span>
          </div>
        </div>
        <MenuSuperior grupos={gruposMenu} />
        <div className="header-right">
          {utils && (utils.gs || utils.tesseract) && (
            <div className="utils-tags">
              {utils.version_gs && (
                <span className="utils-tag" title={`Ghostscript ${utils.version_gs} — necesario para Combinar, Comprimir, OCR y Extraer`}>
                  GS {utils.version_gs}
                </span>
              )}
              {utils.version_tesseract && (
                <span className="utils-tag" title={`${utils.version_tesseract} — necesario para OCR`}>
                  {utils.version_tesseract}
                </span>
              )}
            </div>
          )}
          <button className="btn-tema" onClick={() => setTema(tema === "oscuro" ? "claro" : "oscuro")} title="Cambiar tema claro / oscuro"><I n={tema === "oscuro" ? "sun" : "moon"} s={17} /></button>
          <button className="btn-tema" onClick={() => setVerAtajos(true)} title="Atajos de teclado (?)" aria-label="Atajos de teclado"><I n="help" s={17} /></button>
          <DonateButton compacto />
          <button className="version btn-acerca" onClick={() => setVerAcerca(true)} title="Acerca de PDF Tool">v{__APP_VERSION__}</button>
        </div>
      </div>

      {verAtajos && (
        <div className="modal-fondo" onClick={() => setVerAtajos(false)}>
          <div className="modal-caja" role="dialog" aria-modal="true" aria-label="Atajos de teclado" onClick={(e) => e.stopPropagation()}>
            <div className="modal-cab"><h3>Atajos de teclado</h3><button className="modal-x" onClick={() => setVerAtajos(false)} aria-label="Cerrar"><I n="x" /></button></div>
            <dl className="atajos">
              {([["Ctrl + K", "Buscar acción o archivo"], ["Ctrl + B", "Encoger o ampliar el panel izquierdo"], ["Ctrl + Z / Ctrl + Y", "Deshacer / rehacer (Organizar)"], ["Supr", "Eliminar páginas o anotación seleccionada"], ["← →", "Mover la página seleccionada"], ["?", "Mostrar esta ayuda"], ["Esc", "Cerrar diálogos"]] as const).map(([k, d]) => (
                <div key={k}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>
              ))}
            </dl>
          </div>
        </div>
      )}

      <div className="cuerpo">
      <nav className={`lateral${lateralCompacto ? " compacto" : ""}`}>
        <button className="lateral-alternar" onClick={alternarLateral} title={lateralCompacto ? "Mostrar el menú (Ctrl+B)" : "Ocultar el menú (Ctrl+B)"} aria-label="Mostrar u ocultar el menú lateral">{lateralCompacto ? "»" : "« Ocultar menú"}</button>
        {GRUPOS_HERRAMIENTAS.map((grupo) => (
          <div className="lateral-grupo" key={grupo}>
            <div className="lateral-titulo">{grupo}</div>
            {HERRAMIENTAS.filter((h) => h.grupo === grupo).map((h) => (
              <button key={h.id} className={`lateral-item${herramienta === h.id ? " activa" : ""}`} onClick={() => setHerramienta(h.id)} title={lateralCompacto ? h.etiqueta : undefined}>
                {h.icono}<span>{h.etiqueta}</span>
              </button>
            ))}
          </div>
        ))}
        <div className="lateral-pie">
          <button className="lateral-item" onClick={() => setPaletaAbierta(true)} title="Buscar herramientas y acciones">
            <span className="lateral-k"><I n="search" s={15} /></span><span>Buscar… <kbd>Ctrl+K</kbd></span>
          </button>
        </div>
      </nav>
      <div className="area">
      <div className={`visor-contenedor${herramienta !== "visor" ? " oculta" : ""}`} data-zona="visor">
        <Visor
          solicitud={solicitudVisor} ocupado={algoProcesando}
          herramientas={HERRAMIENTAS.filter((h) => h.id !== "visor").map((h) => ({ id: h.id, etiqueta: h.etiqueta, desc: h.desc, icono: h.icono }))}
          irHerramienta={(id) => setHerramienta(id as Zona)}
          abrirDialogo={abrirPdfsVisor}
          infoPdf={cargarInfoPdf}
          verificarProteccion={verificarProteccion}
          rutaDisponible={rutaDisponible} rutaConSufijo={rutaConSufijo} nombreArchivo={nombreArchivo}
          log={anotar} manejarError={manejarErrorGs}
          historial={(operacion, archivo, resultado) => guardarEnHistorial({ operacion, archivos: [archivo], resultado, ok: true })}
          recientes={recientes} alAbrir={anadirReciente} alEstado={setEstadoVisor} alGenerar={(r) => { setUltimaSalida(r); anadirReciente(r); }} abrirReciente={(r) => abrirEnVisor([r])} borrarRecientes={borrarRecientes}
        />
        {registro.length > 0 && (
          <div className={`ws-estado ${registro[registro.length - 1].tipo}`} onClick={abrirLog} title="Clic para ver el log completo">
            <span className="hora">{registro[registro.length - 1].hora}</span> {registro[registro.length - 1].texto}
          </div>
        )}
      </div>
      {(() => {
        if (!utils) return null;
        const faltaGs = !utils.gs && herramienta !== "imagenes";
        const faltaTess = !utils.tesseract && herramienta === "ocr";
        if (!faltaGs && !faltaTess) return null;
        const que = [faltaGs ? "Ghostscript" : "", faltaTess ? "Tesseract" : ""].filter(Boolean).join(" y ");
        return (
          <div className={`aviso-utils${avisoUtilsAbierto ? " abierto" : ""}`}>
            <button className="aviso-utils-cab" type="button" onClick={() => setAvisoUtilsAbierto(!avisoUtilsAbierto)} aria-expanded={avisoUtilsAbierto}>
              <span className="aviso-icono"><I n="warn" s={18} /></span>
              <span><b>Falta {que}</b> en la carpeta UTILS: esta herramienta no funcionará hasta instalarlo.</span>
              <span className="aviso-ver">{avisoUtilsAbierto ? "Ocultar" : "Ver cómo"} <I n={avisoUtilsAbierto ? "up" : "down"} s={13} /></span>
            </button>
            {avisoUtilsAbierto && (
              <div className="aviso-utils-det">
                <ul>
                  {faltaGs && <li><b>Ghostscript</b> (visor de páginas, Combinar, Comprimir, OCR y búsqueda): <code>UTILS\gs\bin\gswin64c.exe</code></li>}
                  {faltaTess && <li><b>Tesseract</b> (solo OCR): <code>UTILS\tesseract\tesseract.exe</code></li>}
                </ul>
                <div className="aviso-utils-ruta">Cópialos en <code>{utils.carpeta_local || "UTILS junto al programa"}</code>{utils.carpeta_red ? <> o en la carpeta de red <code>{utils.carpeta_red}</code></> : null}, y reinicia la aplicación.</div>
                <button className="btn-ver-log" onClick={() => invoke("abrir_carpeta_utils").catch(() => {})}>Abrir carpeta UTILS</button>
              </div>
            )}
          </div>
        );
      })()}

      {archivosSobre && archivosSobre.length > 0 && (() => {
        const z: Zona = zonaActiva ?? herramienta;
        const esPdf = (p: string) => p.toLowerCase().endsWith(".pdf");
        const esImg = (p: string) => /\.(jpe?g|png|bmp|tiff?|gif|webp|heic|heif)$/i.test(p);
        const admite = (p: string) => z === "imagenes" ? esImg(p) : z === "visor" ? esPdf(p) || esImg(p) : esPdf(p);
        const ok = archivosSobre.filter(admite).length, no = archivosSobre.length - ok;
        const etiqueta = HERRAMIENTAS.find((h) => h.id === z)?.etiqueta ?? z;
        const formatos = z === "imagenes" ? "imágenes (JPG, PNG, HEIC…)" : z === "visor" ? "PDF e imágenes" : "archivos PDF";
        return (
          <div className={`aviso-arrastre${ok === 0 ? " sin-validos" : ""}`}>
            <b>{ok > 0 ? `Suelta para añadir ${ok} archivo(s) a «${etiqueta}»` : `«${etiqueta}» no admite estos archivos`}</b>
            <span>Admite {formatos}{no > 0 && ok > 0 ? ` · se ignorarán ${no}` : ""}</span>
          </div>
        );
      })()}

      {flashCombinar && (
        <div className="flash-ok"><SvgCheck /> Combinado correctamente</div>
      )}

      {algoProcesando && (
        <div className="barra-cancelar">
          <div className="barra-cancelar-cuerpo">
          <div className="barra-cancelar-izq">
            <div className="cancel-dot" />
            <span className="cancel-label">
              {cargandoMiniaturas
                ? (progresoMiniaturas ? `Generando miniaturas… ${progresoMiniaturas.actual}/${progresoMiniaturas.total}` : "Generando miniaturas…")
                : estadoReordenar === "procesando"
                ? (progresoReordenar ? `Reordenando páginas… ${progresoReordenar.actual}/${progresoReordenar.total}` : "Reordenando páginas…")
                : estadoDividir === "procesando"
                ? (progresoDividir ? `Dividiendo… ${progresoDividir.actual}/${progresoDividir.total}` : "Dividiendo…")
                : "Procesando"}
            </span>
            {fraccionGlobal !== null && <span className="eta">· {Math.round(fraccionGlobal * 100)} %</span>}
            {eta && <span className="eta">· quedan {eta}</span>}
          </div>
          <div className="barra-progreso"><div className="barra-progreso-relleno" style={{ width: `${Math.max(4, (fraccionGlobal ?? 0) * 100)}%` }} /></div>
          </div>
          <button className="btn-cancelar" onClick={cancelar}>Cancelar operación</button>
        </div>
      )}

      {resumenUltimo && !algoProcesando && (resumenUltimo.ok + resumenUltimo.error) > 1 && (
        <div className={`barra-resumen ${resumenUltimo.error > 0 ? "con-errores" : ""}`}>
          {resumenUltimo.ok > 0 && <span><SvgCheck /> {resumenUltimo.ok} completado(s)</span>}
          {resumenUltimo.error > 0 && <span><SvgX /> {resumenUltimo.error} error(es)</span>}
        </div>
      )}

      <div className="grupo-seccion">
        <div className="titulo-seccion">Organizar páginas</div>
        <div className="tarjetas">
        {/* COMBINAR */}
        <div className={claseTarjeta("combinar", listaCombinar.length > 0)} data-zona="combinar">
          <div className="cabecera-tarjeta">
            <span className="icono azul"><SvgCombinar /></span>
            <div className="cab-texto">
              <h3>Combinar</h3>
              <div className="cab-desc">Une varios PDF · reordena con las flechas</div>
            </div>
            {estadoCombinar !== "inactivo" && <span className={`estado ${estadoCombinar}`}><span className="estado-dot"/>{textoEstado(estadoCombinar)}</span>}
          </div>

          {listaCombinar.length === 0 ? (
            <div className="zona-soltar">
              <span className="zona-icono"><SvgCombinar /></span>
              <span className="zona-titulo">Arrastra PDF aquí</span>
              <span className="zona-formatos">PDF</span>
              <span className="o">o</span>
              <button onClick={agregarArchivosCombinar} disabled={algoProcesando}>Elegir archivos</button>
            </div>
          ) : (
            <>
              <ul className="lista-archivos">
                {listaCombinar.map((ruta, i) => {
                  const info = infosPdf[ruta];
                  return (
                    <li key={`${ruta}-${i}`} draggable
                      onDragStart={() => onDragStartCombinar(i)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDropCombinar(i)}
                      className={erroresCombinar[ruta] ? "item-error" : ""}>
                      <span className="asa">⠿</span>
                      <span className="nombre" title={ruta}>{nombreArchivo(ruta)}</span>
                      {erroresCombinar[ruta]
                        ? <span className="mensaje-item" style={{ color: "var(--error)" }}><I n="warn" s={13} /> {erroresCombinar[ruta]}</span>
                        : <>
                          {info?.protegido && <span className="candado"><SvgCandado /></span>}
                          {cargandoInfos.has(ruta) && !info && <span className="cargando-info">···</span>}
                          {info && !info.protegido && info.paginas > 0 && <span className="num-paginas">{info.paginas}p</span>}
                          {info && info.tamano_bytes > 0 && <span className="tamano-archivo">{formatoTamano(info.tamano_bytes)}</span>}
                        </>
                      }
                      <span className="mover-orden">
                        <button title="Subir" aria-label="Subir" onClick={() => setListaCombinar((p) => moverEnLista(p, i, i - 1))} disabled={algoProcesando || i === 0}>↑</button>
                        <button title="Bajar" aria-label="Bajar" onClick={() => setListaCombinar((p) => moverEnLista(p, i, i + 1))} disabled={algoProcesando || i === listaCombinar.length - 1}>↓</button>
                      </span>
                      <button className="quitar" onClick={() => quitarDeCombinar(i)} disabled={algoProcesando}>×</button>
                    </li>
                  );
                })}
              </ul>
              <div className="fila-botones">
                <button className="secundario" onClick={agregarArchivosCombinar} disabled={algoProcesando}>+ Añadir más</button>
                <button className="secundario" onClick={() => { setListaCombinar([]); setInfosPdf({}); }} disabled={algoProcesando}>Limpiar</button>
                <button className="primario azul" onClick={combinar} disabled={algoProcesando}>
                  Combinar ({listaCombinar.length}{totalPaginasCombinar > 0 ? ` · ${totalPaginasCombinar}p` : ""})
                </button>
              </div>
            </>
          )}
        </div>


        {/* EXTRAER */}
        <div className={claseTarjeta("extraer", !!entradaExtraer)} data-zona="extraer">
          <div className="cabecera-tarjeta">
            <span className="icono morado"><SvgExtraer /></span>
            <div className="cab-texto">
              <h3>Extraer páginas</h3>
              <div className="cab-desc">Saca un rango de páginas como PDF nuevo</div>
            </div>
            {estadoExtraer !== "inactivo" && <span className={`estado ${estadoExtraer}`}><span className="estado-dot"/>{textoEstado(estadoExtraer)}</span>}
          </div>

          {!entradaExtraer ? (
            <div className="zona-soltar">
              <span className="zona-icono"><SvgExtraer /></span>
              <span className="zona-titulo">Arrastra un PDF aquí</span>
              <span className="zona-formatos">PDF</span>
              <span className="o">o</span>
              <button onClick={seleccionarExtraer} disabled={algoProcesando}>Elegir archivo</button>
            </div>
          ) : (
            <div className="chip-archivo">
              <span className="nombre" title={entradaExtraer}>{nombreArchivo(entradaExtraer)}</span>
              {infoExtraer?.protegido && <span className="candado"><SvgCandado /></span>}
              {infoExtraer && !infoExtraer.protegido && infoExtraer.paginas > 0 && <span className="num-paginas">{infoExtraer.paginas}p</span>}
              {infoExtraer && infoExtraer.tamano_bytes > 0 && <span className="tamano-archivo">{formatoTamano(infoExtraer.tamano_bytes)}</span>}
              <button className="quitar" onClick={() => { setEntradaExtraer(null); setEstadoExtraer("inactivo"); setRangoExtraer(""); }} disabled={algoProcesando}>×</button>
            </div>
          )}
          {entradaExtraer && infoExtraer && !infoExtraer.protegido && infoExtraer.paginas > 0 && (
            <VisorPdf
              ruta={entradaExtraer} total={infoExtraer.paginas} modo="extraer"
              marcadas={rangoAPaginas(rangoExtraer, infoExtraer.paginas)}
              deshabilitado={algoProcesando}
              onToggle={(n) => {
                const set = rangoAPaginas(rangoExtraer, infoExtraer.paginas);
                if (set.has(n)) set.delete(n); else set.add(n);
                setRangoExtraer(paginasARango(set));
              }}
            />
          )}

          <div className="grupo-rango">
            <input
              className={`input-rango${validacionRango ? (validacionRango.valido ? " rango-ok" : " rango-error") : ""}`}
              type="text"
              placeholder={infoExtraer && !infoExtraer.protegido ? `Ej: 1-3, 5, 7-9  (total: ${infoExtraer.paginas}p)` : "Ej: 1-3, 5, 7-9"}
              value={rangoExtraer}
              onChange={(e) => setRangoExtraer(e.target.value)}
              disabled={algoProcesando}
            />
            {validacionRango?.error && <span className="error-rango">{validacionRango.error}</span>}
            {validacionRango?.valido && <span className="exito-rango"><I n="check" s={13} /> {validacionRango.paginas} página(s) seleccionada(s)</span>}
            <div className="rango-ayuda">
              <span><strong>1-5</strong> páginas 1 a 5</span>
              <span><strong>3</strong> solo página 3</span>
              <span><strong>1-3, 7, 10-12</strong> combinado</span>
            </div>
          </div>

          <div className="fila-botones">
            <button className="secundario" onClick={seleccionarExtraer} disabled={algoProcesando || !entradaExtraer}>Cambiar archivo</button>
            <button className="primario morado" onClick={extraer}
              disabled={algoProcesando || !entradaExtraer || !rangoExtraer.trim() || (validacionRango !== null && !validacionRango.valido)}>
              Extraer páginas
            </button>
          </div>
        </div>

        <div className={claseTarjeta("marca", false)} data-zona="marca">
          <div className="cabecera-tarjeta">
            <span className="icono azul"><I n="stamp" s={20} /></span>
            <div className="cab-texto"><h3>Marca de agua y numeración</h3><div className="cab-desc">Texto en diagonal y números de página</div></div>
          </div>
          <MarcaPdf alGenerar={(r) => { setUltimaSalida(r); anadirReciente(r); }} registrar={anotar} zona="marca" />
        </div>

        <div className={claseTarjeta("formulario", false)} data-zona="formulario">
          <div className="cabecera-tarjeta">
            <span className="icono azul"><I n="form" s={20} /></span>
            <div className="cab-texto"><h3>Rellenar formulario</h3><div className="cab-desc">Rellena los campos y, si quieres, aplana el resultado</div></div>
          </div>
          <FormularioPdf alGenerar={(r) => { setUltimaSalida(r); anadirReciente(r); }} registrar={anotar} zona="formulario" />
        </div>

        <div className={claseTarjeta("metadatos", false)} data-zona="metadatos">
          <div className="cabecera-tarjeta">
            <span className="icono azul"><I n="shield" s={20} /></span>
            <div className="cab-texto"><h3>Metadatos y limpieza</h3><div className="cab-desc">Revisa y elimina autor, XMP, adjuntos y JavaScript</div></div>
          </div>
          <MetadatosPdf alGenerar={(r) => { setUltimaSalida(r); anadirReciente(r); }} registrar={anotar} zona="metadatos" />
        </div>

        <div className={claseTarjeta("lotes", false)} data-zona="lotes">
          <div className="cabecera-tarjeta">
            <span className="icono azul"><I n="layers" s={20} /></span>
            <div className="cab-texto"><h3>Lotes y perfiles</h3><div className="cab-desc">Aplica una cadena de pasos a carpetas completas</div></div>
          </div>
          <LotesPdf alGenerar={(r) => { setUltimaSalida(r); anadirReciente(r); }} registrar={anotar} zona="lotes" />
        </div>

        {/* DIVIDIR */}
        <div className={claseTarjeta("dividir", !!entradaDividir)} data-zona="dividir">
          <div className="cabecera-tarjeta">
            <span className="icono naranja"><SvgDividir /></span>
            <div className="cab-texto">
              <h3>Dividir PDF</h3>
              <div className="cab-desc">En varios archivos, cada N páginas o por puntos concretos</div>
            </div>
            {estadoDividir !== "inactivo" && <span className={`estado ${estadoDividir}`}><span className="estado-dot"/>{textoEstado(estadoDividir)}</span>}
          </div>

          {!entradaDividir ? (
            <div className="zona-soltar">
              <span className="zona-icono"><SvgDividir /></span>
              <span className="zona-titulo">Arrastra un PDF aquí</span>
              <span className="zona-formatos">PDF</span>
              <span className="o">o</span>
              <button onClick={seleccionarDividir} disabled={algoProcesando}>Elegir archivo</button>
            </div>
          ) : (
            <>
              <div className="chip-archivo">
                <span className="nombre" title={entradaDividir}>{nombreArchivo(entradaDividir)}</span>
                {infoDividir?.protegido && <span className="candado"><SvgCandado /></span>}
                {infoDividir && !infoDividir.protegido && infoDividir.paginas > 0 && <span className="num-paginas">{infoDividir.paginas}p</span>}
                <button className="quitar" onClick={() => { setEntradaDividir(null); setEstadoDividir("inactivo"); setPuntosDividir(""); }} disabled={algoProcesando}>×</button>
              </div>

              {infoDividir && !infoDividir.protegido && infoDividir.paginas > 0 && (
                <VisorPdf
                  ruta={entradaDividir} total={infoDividir.paginas} modo="dividir"
                  marcadas={new Set(calculoDividir.rangos.slice(1).map((r) => r[0]))}
                  deshabilitado={algoProcesando}
                  onToggle={(n) => {
                    const set = new Set(calculoDividir.rangos.slice(1).map((r) => r[0]));
                    if (set.has(n)) set.delete(n); else set.add(n);
                    setModoDividir("puntos");
                    setPuntosDividir([...set].sort((x, y) => x - y).join(", "));
                  }}
                />
              )}

              <div className="modo-dividir">
                <label className={`opcion-modo${modoDividir === "cada" ? " activa" : ""}`}>
                  <input type="radio" name="modoDividir" checked={modoDividir === "cada"} onChange={() => setModoDividir("cada")} disabled={algoProcesando} />
                  Cada N páginas
                </label>
                <label className={`opcion-modo${modoDividir === "puntos" ? " activa" : ""}`}>
                  <input type="radio" name="modoDividir" checked={modoDividir === "puntos"} onChange={() => setModoDividir("puntos")} disabled={algoProcesando} />
                  En páginas concretas
                </label>
              </div>

              {modoDividir === "cada" ? (
                <div className="grupo-rango">
                  <input
                    type="number" min={1} className="input-rango" style={{ maxWidth: 140 }}
                    value={cadaNDividir} onChange={(e) => setCadaNDividir(e.target.value)}
                    placeholder="Ej: 10" disabled={algoProcesando}
                  />
                </div>
              ) : (
                <div className="grupo-rango">
                  <input
                    className={`input-rango${puntosDividir.trim() ? (calculoDividir.error ? " rango-error" : " rango-ok") : ""}`}
                    value={puntosDividir} onChange={(e) => setPuntosDividir(e.target.value)}
                    placeholder={infoDividir && !infoDividir.protegido ? `Ej: 5, 12  (total: ${infoDividir.paginas}p)` : "Ej: 5, 12"}
                    disabled={algoProcesando}
                  />
                </div>
              )}

              {calculoDividir.error && <span className="error-rango">{calculoDividir.error}</span>}
              {!calculoDividir.error && calculoDividir.rangos.length > 0 && (
                <span className="exito-rango"><I n="check" s={13} /> Se generarán {calculoDividir.rangos.length} archivo(s): {calculoDividir.rangos.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(", ")}</span>
              )}

              {estadoDividir === "procesando" && progresoDividir && (
                <div className="progreso-ocr">
                  <div className="barra-progreso"><div className="barra-progreso-relleno" style={{ width: `${(progresoDividir.actual / Math.max(progresoDividir.total, 1)) * 100}%` }} /></div>
                  <span>Generando parte {progresoDividir.actual}/{progresoDividir.total}</span>
                </div>
              )}

              <div className="fila-botones">
                <button className="secundario" onClick={seleccionarDividir} disabled={algoProcesando || !entradaDividir}>Cambiar archivo</button>
                <button className="primario naranja" onClick={dividir}
                  disabled={algoProcesando || !entradaDividir || calculoDividir.rangos.length === 0 || !!calculoDividir.error}>
                  Dividir PDF
                </button>
              </div>
            </>
          )}
        </div>

        {/* REORDENAR */}
        <div className={`${claseTarjeta("reordenar", !!entradaReordenar)} tarjeta-ancha`} data-zona="reordenar">
          <div className="cabecera-tarjeta">
            <span className="icono azul"><SvgReordenar /></span>
            <div className="cab-texto">
              <h3>Reordenar páginas</h3>
              <div className="cab-desc">Arrastra las miniaturas, o selecciona una y usa las flechas del teclado</div>
            </div>
            {estadoReordenar !== "inactivo" && <span className={`estado ${estadoReordenar}`}><span className="estado-dot"/>{textoEstado(estadoReordenar)}</span>}
          </div>

          {!entradaReordenar ? (
            <div className="zona-soltar">
              <span className="zona-icono"><SvgReordenar /></span>
              <span className="zona-titulo">Arrastra un PDF aquí</span>
              <span className="zona-formatos">PDF</span>
              <span className="o">o</span>
              <button onClick={seleccionarReordenar} disabled={algoProcesando}>Elegir archivo</button>
            </div>
          ) : (
            <>
              <div className="chip-archivo">
                <span className="nombre" title={entradaReordenar}>{nombreArchivo(entradaReordenar)}</span>
                {paginasReordenar.length > 0 && <span className="num-paginas">{paginasReordenar.length}p</span>}
                <button className="quitar" onClick={limpiarReordenar} disabled={algoProcesando}>×</button>
              </div>

              {cargandoMiniaturas ? (
                <div className="cargando-miniaturas">
                  <div className="barra-progreso"><div className="barra-progreso-relleno" style={{ width: progresoMiniaturas ? `${(progresoMiniaturas.actual / Math.max(progresoMiniaturas.total, 1)) * 100}%` : "4%" }} /></div>
                  <span>{progresoMiniaturas ? `Generando miniaturas… ${progresoMiniaturas.actual}/${progresoMiniaturas.total}` : "Generando miniaturas…"}</span>
                </div>
              ) : (
                <>
                  {seleccionReordenar !== null && (
                    <div className="barra-seleccion">
                      <span>Página seleccionada: posición <strong>{seleccionReordenar + 1}</strong> (era {paginasReordenar[seleccionReordenar]?.numeroOriginal}) · usa ← → o arrástrala</span>
                      <div className="mover-a">
                        <span>Mover a</span>
                        <input
                          type="number" min={1} max={paginasReordenar.length}
                          className="input-posicion"
                          defaultValue={seleccionReordenar + 1}
                          key={seleccionReordenar}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            const destino = parseInt((e.target as HTMLInputElement).value, 10);
                            if (!isNaN(destino)) moverPaginaA(seleccionReordenar, Math.min(Math.max(destino - 1, 0), paginasReordenar.length - 1));
                          }}
                          disabled={algoProcesando}
                        />
                        <button className="secundario compacto" onClick={(e) => {
                          const input = (e.currentTarget.previousSibling as HTMLInputElement);
                          const destino = parseInt(input.value, 10);
                          if (!isNaN(destino)) moverPaginaA(seleccionReordenar, Math.min(Math.max(destino - 1, 0), paginasReordenar.length - 1));
                        }} disabled={algoProcesando}>Ir</button>
                      </div>
                    </div>
                  )}

                  <div className="miniaturas-grid">
                    {paginasReordenar.map((pagina, index) => {
                      const arrastrando = arrastreReordenar.origen === index;
                      const esObjetivo = arrastreReordenar.sobre === index && arrastreReordenar.origen !== index;
                      const movida = pagina.numeroOriginal !== ordenOriginalReordenar[index];
                      const seleccionada = seleccionReordenar === index;
                      return (
                        <div key={pagina.numeroOriginal} className="miniatura-envoltorio">
                          {esObjetivo && arrastreReordenar.posicion === "antes" && <div className="linea-insercion izquierda" />}
                          <div
                            className={`miniatura-pagina${arrastrando ? " arrastrando" : ""}${esObjetivo ? " objetivo" : ""}${seleccionada ? " seleccionada" : ""}`}
                            draggable={!algoProcesando}
                            tabIndex={0}
                            onClick={() => setSeleccionReordenar(index)}
                            onDragStart={() => onDragStartReordenar(index)}
                            onDragOver={(e) => onDragOverReordenar(index, e)}
                            onDragEnd={onDragEndReordenar}
                            onDrop={(e) => { e.preventDefault(); onDropReordenar(index); }}
                          >
                            <div className="miniatura-cab">
                              <SvgAsa />
                              {movida && <span className="miniatura-badge">era {pagina.numeroOriginal}</span>}
                              <span className="miniatura-acciones">
                                <button
                                  className="miniatura-zoom" title="Ampliar"
                                  onClick={(e) => { e.stopPropagation(); setZoomReordenar({ src: pagina.miniatura, numero: pagina.numeroOriginal }); }}
                                ><SvgZoom /></button>
                                <button
                                  className="miniatura-eliminar" title="Eliminar página"
                                  disabled={algoProcesando || paginasReordenar.length <= 1}
                                  onClick={(e) => { e.stopPropagation(); eliminarPaginaReordenar(index); }}
                                ><SvgX /></button>
                              </span>
                            </div>
                            <div className="miniatura-hoja">
                              <img src={pagina.miniatura} alt={`Página ${pagina.numeroOriginal}`} draggable={false} />
                            </div>
                            <div className="miniatura-num">{index + 1}</div>
                          </div>
                          {esObjetivo && arrastreReordenar.posicion === "despues" && <div className="linea-insercion derecha" />}
                        </div>
                      );
                    })}
                  </div>

                  {estadoReordenar === "procesando" && progresoReordenar && (
                    <div className="progreso-ocr">
                      <div className="barra-progreso"><div className="barra-progreso-relleno" style={{ width: `${(progresoReordenar.actual / Math.max(progresoReordenar.total, 1)) * 100}%` }} /></div>
                      <span>Reconstruyendo PDF · pág. {progresoReordenar.actual}/{progresoReordenar.total}</span>
                    </div>
                  )}

                  <div className="fila-botones">
                    <button className="secundario" onClick={cambiarArchivoReordenar} disabled={algoProcesando}>Cambiar archivo</button>
                    {historialOrdenReordenar.length > 0 && (
                      <button className="secundario" onClick={deshacerReordenar} disabled={algoProcesando}>Deshacer</button>
                    )}
                    {ordenCambiadoReordenar && (
                      <button className="secundario" onClick={restablecerReordenar} disabled={algoProcesando}>Restablecer orden</button>
                    )}
                    <button className="primario azul" onClick={guardarReordenar} disabled={algoProcesando || !ordenCambiadoReordenar}>
                      Guardar orden
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        </div>
      </div>

      <div className="grupo-seccion">
        <div className="titulo-seccion">Editar</div>
        <div className="tarjetas">
        {/* ANOTAR */}
        <div className={claseTarjeta("anotar", !!entradaAnotar)} data-zona="anotar">
          <div className="cabecera-tarjeta">
            <span className="icono azul"><SvgAnotar /></span>
            <div className="cab-texto">
              <h3>Anotar y resaltar</h3>
              <div className="cab-desc">Añade texto y resalta partes del PDF; se guarda como copia</div>
            </div>
            {estadoAnotar !== "inactivo" && <span className={`estado ${estadoAnotar}`}><span className="estado-dot"/>{textoEstado(estadoAnotar)}</span>}
          </div>

          {!entradaAnotar ? (
            <div className="zona-soltar">
              <span className="zona-icono"><SvgAnotar /></span>
              <span className="zona-titulo">Arrastra un PDF aquí</span>
              <span className="zona-formatos">PDF</span>
              <span className="o">o</span>
              <button onClick={seleccionarAnotar} disabled={algoProcesando}>Elegir archivo</button>
            </div>
          ) : (
            <>
              <div className="chip-archivo">
                <span className="nombre" title={entradaAnotar}>{nombreArchivo(entradaAnotar)}</span>
                {infosPdf[entradaAnotar]?.protegido && <span className="candado"><SvgCandado /></span>}
                {infosPdf[entradaAnotar] && !infosPdf[entradaAnotar].protegido && infosPdf[entradaAnotar].paginas > 0 && <span className="num-paginas">{infosPdf[entradaAnotar].paginas}p</span>}
                <button className="quitar" aria-label="Quitar archivo" onClick={async () => {
                  if (anotaciones.length > 0 && !(await confirmar({ titulo: "¿Descartar las anotaciones?", texto: "Hay anotaciones sin guardar.", ok: "Descartar", peligro: true }))) return;
                  setEntradaAnotar(null); setAnotaciones([]); setEstadoAnotar("inactivo");
                }} disabled={algoProcesando}>×</button>
              </div>
              {infosPdf[entradaAnotar] && !infosPdf[entradaAnotar].protegido && infosPdf[entradaAnotar].paginas > 0 && (
                <AnotadorPdf ruta={entradaAnotar} total={infosPdf[entradaAnotar].paginas}
                  anotaciones={anotaciones} setAnotaciones={setAnotaciones} deshabilitado={algoProcesando} />
              )}
              <div className="fila-botones">
                <button className="secundario" onClick={seleccionarAnotar} disabled={algoProcesando}>Cambiar archivo</button>
                <button className="secundario" onClick={() => setAnotaciones((p) => p.slice(0, -1))} disabled={algoProcesando || anotaciones.length === 0}>Deshacer última</button>
                <button className="primario azul" onClick={guardarAnotaciones} disabled={algoProcesando || anotaciones.length === 0}>
                  Guardar copia anotada{anotaciones.length > 0 ? ` (${anotaciones.length})` : ""}
                </button>
              </div>
            </>
          )}
        </div>
        </div>
      </div>

      <div className="grupo-seccion">
        <div className="titulo-seccion">Optimizar y convertir</div>
        <div className="tarjetas">
        {/* COMPRIMIR */}
        <div className={claseTarjeta("comprimir", colaComprimir.length > 0)} data-zona="comprimir">
          <div className="cabecera-tarjeta">
            <span className="icono naranja"><SvgComprimir /></span>
            <div className="cab-texto">
              <h3>Comprimir</h3>
              <div className="cab-desc">Reduce el tamaño · ideal para escaneos</div>
            </div>
            {estadoComprimir !== "inactivo" && (
              <span className={`estado ${estadoComprimir}`}><span className="estado-dot"/>
                {estadoComprimir === "procesando" && pendientesComprimir > 0
                  ? `${colaComprimir.length - pendientesComprimir}/${colaComprimir.length}`
                  : textoEstado(estadoComprimir)}
              </span>
            )}
          </div>

          {colaComprimir.length === 0 ? (
            <div className="zona-soltar">
              <span className="zona-icono"><SvgComprimir /></span>
              <span className="zona-titulo">Arrastra uno o varios PDF aquí</span>
              <span className="zona-formatos">PDF</span>
              <span className="o">o</span>
              <button onClick={agregarColaComprimir} disabled={algoProcesando}>Elegir archivos</button>
            </div>
          ) : (
            <ul className="lista-archivos">
              {colaComprimir.map((item, i) => (
                <li key={`${item.ruta}-${i}`} className={`item-${item.estado}`}
                  draggable={item.estado === "pendiente"}
                  onDragStart={() => onDragStartComprimir(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDropComprimir(i)}>
                  {item.estado === "pendiente" && <span className="asa">⠿</span>}
                  <span className="nombre" title={item.ruta}>{nombreArchivo(item.ruta)}</span>
                  {item.mensaje
                    ? <span className="mensaje-item">{item.mensaje}</span>
                    : infosPdf[item.ruta]?.tamano_bytes
                      ? <span className="tamano-archivo">{formatoTamano(infosPdf[item.ruta].tamano_bytes)}</span>
                      : null}
                  {item.estado === "pendiente" && (
                    <span className="mover-orden">
                      <button title="Subir" aria-label="Subir" onClick={() => setColaComprimir((p) => moverEnLista(p, i, i - 1))} disabled={algoProcesando || i === 0}>↑</button>
                      <button title="Bajar" aria-label="Bajar" onClick={() => setColaComprimir((p) => moverEnLista(p, i, i + 1))} disabled={algoProcesando || i === colaComprimir.length - 1}>↓</button>
                    </span>
                  )}
                  <button className="quitar" onClick={() => quitarDeColaComprimir(i)} disabled={algoProcesando}>×</button>
                </li>
              ))}
            </ul>
          )}

          <div className="modo-comp" role="tablist">
            <button type="button" className={modoComp === "nivel" ? "activo" : ""} onClick={() => setModoComp("nivel")} disabled={algoProcesando}>Por calidad</button>
            <button type="button" className={modoComp === "tamano" ? "activo" : ""} onClick={() => setModoComp("tamano")} disabled={algoProcesando}>Por tamaño máximo</button>
          </div>

          {modoComp === "tamano" ? (() => {
            const limite = Math.max(0, parseFloat(maxMB.replace(",", ".")) || 0) * 1024 * 1024;
            const pend = colaComprimir.filter((it) => it.estado === "pendiente" && analisis[it.ruta]);
            // niveles de mayor a menor calidad: printer, ebook, screen, extremo (≈ 60 % del Mínimo)
            const prevision = (a: AnalisisCompresion) => {
              if (a.tam <= limite) return { ok: true, txt: "ya cumple, no hace falta comprimir" };
              const e = [a.estimado[2], a.estimado[1], a.estimado[0], a.estimado[0] * 0.6];
              const nombres = ["Buena calidad", "Equilibrada", "Mínimo", "Compresión extrema"];
              const j = e.findIndex((v) => v <= limite * 1.15);
              return j === -1 ? { ok: false, txt: `puede que no se alcance (mínimo estimado ≈ ${formatoTamano(e[3])})` } : { ok: true, txt: `se conseguiría con «${nombres[j]}»` };
            };
            return (
              <div className="tamano-comp">
                <label>Cada archivo debe pesar como máximo
                  <input type="text" inputMode="decimal" value={maxMB} onChange={(e) => setMaxMB(e.target.value)} disabled={algoProcesando} /> MB
                </label>
                <div className="chips-tamano">
                  {["1", "2", "5", "10", "20"].map((v) => (
                    <button key={v} type="button" className={maxMB === v ? "activo" : ""} onClick={() => setMaxMB(v)} disabled={algoProcesando}>{v} MB</button>
                  ))}
                </div>
                {limite <= 0 && <div className="aviso-tamano">Escribe un tamaño máximo mayor que 0.</div>}
                {limite > 0 && pend.map((it) => { const a = analisis[it.ruta]!; const r = prevision(a); return (
                  <div key={it.ruta} className={`prev-tamano ${r.ok ? "ok" : "no"}`}><I n={r.ok ? "check" : "warn"} s={13} /> <b>{nombreArchivo(it.ruta)}</b> ({formatoTamano(a.tam)}): {r.txt}</div>
                ); })}
                <p className="nota-nivel">Se elige automáticamente el nivel de <b>mayor calidad</b> que cumpla el límite. Si no se puede alcanzar, se guarda el resultado más pequeño posible y se avisa. <i>Las previsiones son aproximadas; el resultado final se comprueba con el tamaño real.</i></p>
              </div>
            );
          })() : (() => {
            const pend = colaComprimir.filter((it) => it.estado === "pendiente" && analisis[it.ruta]);
            const base = pend.reduce((t, it) => t + (analisis[it.ruta]?.tam ?? 0), 0);
            const est = (k: number) => pend.reduce((t, it) => t + (analisis[it.ruta]?.estimado[k] ?? 0), 0);
            const k = ORDEN_NIVELES.indexOf(nivel);
            return (
              <>
                {base > 0 && <div className="resumen-comp">Tamaño actual: <b>{formatoTamano(base)}</b> · con «{NIVELES_COMPRESION[nivel].corto}» quedaría en unos <b>{formatoTamano(est(k))}</b>{est(k) < base ? ` (−${Math.round((1 - est(k) / base) * 100)} %)` : " (sin reducción apreciable)"}</div>}
                <div className="deslizador-nivel">
                  <div className="dn-extremos"><span>Archivo más pequeño</span><span>Mejor calidad</span></div>
                  <input type="range" min={0} max={3} step={1} value={k} disabled={algoProcesando}
                    onChange={(e) => setNivel(ORDEN_NIVELES[+e.target.value])} aria-label="Nivel de compresión" />
                  <div className="dn-paradas">
                    {ORDEN_NIVELES.map((n, j) => (
                      <button key={n} type="button" className={nivel === n ? "activo" : ""} disabled={algoProcesando} onClick={() => setNivel(n)} title={NIVELES_COMPRESION[n].desc}>
                        <span>{NIVELES_COMPRESION[n].corto}</span>
                        {base > 0 && <small>≈ {formatoTamano(est(j))}</small>}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            );
          })()}
          {modoComp === "nivel" && <p className="nota-nivel"><b>{NIVELES_COMPRESION[nivel].nombre}.</b> {NIVELES_COMPRESION[nivel].desc} <i>El tamaño indicado es una estimación aproximada.</i></p>}

          {colaComprimir.length > 0 && (
            <div className="fila-botones">
              <button className="secundario" onClick={agregarColaComprimir} disabled={algoProcesando}>+ Añadir</button>
              <button className="secundario" onClick={() => setColaComprimir((p) => p.filter((it) => it.estado !== "error"))} disabled={algoProcesando} title="Quitar solo los errores">Limpiar errores</button>
              <button className="secundario" onClick={() => setColaComprimir([])} disabled={algoProcesando} title="Limpiar toda la lista">Limpiar todo</button>
              <button className="primario naranja" onClick={procesarColaComprimir} disabled={algoProcesando || pendientesComprimir === 0}>
                Comprimir ({pendientesComprimir})
              </button>
            </div>
          )}
        </div>

        {/* OCR */}
        <div className={claseTarjeta("ocr", colaOcr.length > 0)} data-zona="ocr">
          <div className="cabecera-tarjeta">
            <span className="icono verde"><SvgOcr /></span>
            <div className="cab-texto">
              <h3>OCR</h3>
              <div className="cab-desc">Añade texto buscable a escaneos</div>
            </div>
            {estadoOcr !== "inactivo" && (
              <span className={`estado ${estadoOcr}`}><span className="estado-dot"/>
                {estadoOcr === "procesando" && pendientesOcr > 0
                  ? `${colaOcr.length - pendientesOcr}/${colaOcr.length}`
                  : textoEstado(estadoOcr)}
              </span>
            )}
          </div>

          {colaOcr.length === 0 ? (
            <div className="zona-soltar">
              <span className="zona-icono"><SvgOcr /></span>
              <span className="zona-titulo">Arrastra PDF escaneados aquí</span>
              <span className="zona-formatos">PDF</span>
              <span className="o">o</span>
              <button onClick={agregarColaOcr} disabled={algoProcesando}>Elegir archivos</button>
            </div>
          ) : (
            <ul className="lista-archivos">
              {colaOcr.map((item, i) => (
                <li key={`${item.ruta}-${i}`} className={`item-${item.estado}`}
                  draggable={item.estado === "pendiente"}
                  onDragStart={() => onDragStartOcr(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDropOcr(i)}>
                  {item.estado === "pendiente" && <span className="asa">⠿</span>}
                  <span className="nombre" title={item.ruta}>{nombreArchivo(item.ruta)}</span>
                  {item.estado === "procesando" && indiceOcrActual === i && progresoOcr
                    ? <span className="mensaje-item">pág. {progresoOcr.actual}/{progresoOcr.total}</span>
                    : item.mensaje
                      ? <span className="mensaje-item">{item.mensaje}</span>
                      : infosPdf[item.ruta]?.tamano_bytes
                        ? <span className="tamano-archivo">{formatoTamano(infosPdf[item.ruta].tamano_bytes)}</span>
                        : null}
                  {item.estado === "pendiente" && (
                    <span className="mover-orden">
                      <button title="Subir" aria-label="Subir" onClick={() => setColaOcr((p) => moverEnLista(p, i, i - 1))} disabled={algoProcesando || i === 0}>↑</button>
                      <button title="Bajar" aria-label="Bajar" onClick={() => setColaOcr((p) => moverEnLista(p, i, i + 1))} disabled={algoProcesando || i === colaOcr.length - 1}>↓</button>
                    </span>
                  )}
                  <button className="quitar" onClick={() => quitarDeColaOcr(i)} disabled={algoProcesando}>×</button>
                </li>
              ))}
            </ul>
          )}

          <div className="ocr-opciones-extra">
            <div className="opciones-nivel opciones-dpi">
              {([150, 300, 600] as const).map((d) => (
                <button key={d} className={dpiOcr === d ? "activo" : ""} onClick={() => setDpiOcr(d)} disabled={algoProcesando} type="button"
                  title={d === 150 ? "Rápido, calidad básica" : d === 300 ? "Estándar recomendado" : "Alta calidad, más lento"}>
                  {d} dpi
                </button>
              ))}
            </div>
            <label className="check-orientacion">
              <input type="checkbox" checked={corregirOrientacion} onChange={(e) => setCorregirOrientacion(e.target.checked)} disabled={algoProcesando} />
              Corregir orientación
            </label>
          </div>

          {progresoOcr && estadoOcr === "procesando" && (
            <div className="progreso-ocr">
              <div className="barra-progreso"><div className="barra-progreso-relleno" style={{ width: `${(progresoOcr.actual / progresoOcr.total) * 100}%` }} /></div>
              <span>Archivo {(indiceOcrActual ?? 0) + 1}/{colaOcr.length} · pág. {progresoOcr.actual}/{progresoOcr.total}</span>
            </div>
          )}

          {colaOcr.length > 0 && (
            <div className="fila-botones">
              <button className="secundario" onClick={agregarColaOcr} disabled={algoProcesando}>+ Añadir</button>
              <button className="secundario" onClick={() => setColaOcr((p) => p.filter((it) => it.estado !== "error"))} disabled={algoProcesando} title="Quitar solo los errores">Limpiar errores</button>
              <button className="secundario" onClick={() => setColaOcr([])} disabled={algoProcesando} title="Limpiar toda la lista">Limpiar todo</button>
              <button className="primario verde" onClick={procesarColaOcr} disabled={algoProcesando || pendientesOcr === 0}>
                Aplicar OCR ({pendientesOcr})
              </button>
            </div>
          )}
        </div>
        {/* IMÁGENES A PDF */}
        <div className={claseTarjeta("imagenes", listaImagenes.length > 0)} data-zona="imagenes">
          <div className="cabecera-tarjeta">
            <span className="icono verde"><SvgImagenes /></span>
            <div className="cab-texto">
              <h3>Imágenes a PDF</h3>
              <div className="cab-desc">Convierte JPG, PNG… a PDF tamaño A4</div>
            </div>
            {estadoImagenes !== "inactivo" && <span className={`estado ${estadoImagenes}`}><span className="estado-dot"/>{textoEstado(estadoImagenes)}</span>}
          </div>

          {listaImagenes.length === 0 ? (
            <div className="zona-soltar">
              <span className="zona-icono"><SvgImagenes /></span>
              <span className="zona-titulo">Arrastra imágenes aquí</span>
              <span className="zona-formatos">JPG · PNG · HEIC · TIFF · WEBP · BMP</span>
              <span className="o">JPG · PNG · BMP · TIFF</span>
              <button onClick={agregarImagenes} disabled={algoProcesando}>Elegir imágenes</button>
            </div>
          ) : (
            <ul className="lista-archivos">
              {listaImagenes.map((ruta, i) => (
                <li key={`${ruta}-${i}`} draggable
                  onDragStart={() => { arrastreOrigenImagenes.current = i; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    const o = arrastreOrigenImagenes.current; arrastreOrigenImagenes.current = null;
                    if (o === null || o === i) return;
                    setListaImagenes((p) => moverEnLista(p, o, i));
                  }}>
                  <span className="asa">⠿</span>
                  <span className="nombre" title={ruta}>{nombreArchivo(ruta)}</span>
                  <span className="mover-orden">
                    <button title="Subir" aria-label="Subir" onClick={() => setListaImagenes((p) => moverEnLista(p, i, i - 1))} disabled={algoProcesando || i === 0}>↑</button>
                    <button title="Bajar" aria-label="Bajar" onClick={() => setListaImagenes((p) => moverEnLista(p, i, i + 1))} disabled={algoProcesando || i === listaImagenes.length - 1}>↓</button>
                  </span>
                  <button className="quitar" onClick={() => setListaImagenes((p) => p.filter((_, j) => j !== i))} disabled={algoProcesando}>×</button>
                </li>
              ))}
            </ul>
          )}

          <div className="toggle-separados">
            <label className="check-orientacion">
              <input type="checkbox" checked={!imagenesSeparadas} onChange={() => setImagenesSeparadas(false)} disabled={algoProcesando} />
              Un único PDF con todas las imágenes
            </label>
            <label className="check-orientacion" style={{ color: imagenesSeparadas ? "var(--green)" : undefined }}>
              <input type="checkbox" checked={imagenesSeparadas} onChange={() => setImagenesSeparadas(true)} disabled={algoProcesando} />
              PDF separado por imagen
            </label>
          </div>

          {listaImagenes.length > 0 && (
            <div className="fila-botones">
              <button className="secundario" onClick={agregarImagenes} disabled={algoProcesando}>+ Añadir</button>
              <button className="secundario" onClick={() => setListaImagenes([])} disabled={algoProcesando}>Limpiar</button>
              <button className="primario verde" onClick={convertirImagenes} disabled={algoProcesando}>
                Convertir ({listaImagenes.length})
              </button>
            </div>
          )}
        </div>

      </div>
      </div>

      {ultimaSalida && !algoProcesando && (
        <div className="barra-resultado tarjeta-resultado">
          <div className="res-info">
            <span className="res-check"><SvgCheck /></span>
            <div className="res-texto">
              <b>{resumenUltimo && (resumenUltimo.ok + resumenUltimo.error) > 1 ? `${resumenUltimo.ok} archivo(s) procesados correctamente` : "Listo"}</b>
              <span className="res-nombre" title={ultimaSalida}>{nombreArchivo(ultimaSalida)}</span>
              <span className="res-carpeta" title={ultimaSalida}>{ultimaSalida.replace(/[\\/][^\\/]*$/, "")}</span>
            </div>
          </div>
          <span className="barra-resultado-botones">
            {ultimaSalida.toLowerCase().endsWith(".pdf")
              ? <button className="res-principal" onClick={() => abrirEnVisor([ultimaSalida])}>Ver en el visor</button>
              : <button className="res-principal" onClick={abrirSalidaExterna}>Abrir</button>}
            <button onClick={abrirCarpetaSalida}><SvgCarpeta /> Abrir carpeta</button>
            {ultimaSalida.toLowerCase().endsWith(".pdf") && <button onClick={abrirSalidaExterna}>Abrir con otro programa</button>}
            <button onClick={() => { navigator.clipboard?.writeText(ultimaSalida).then(() => anotar("info", "Ruta copiada al portapapeles")).catch(() => {}); }}>Copiar ruta</button>
            {ultimaSalida.toLowerCase().endsWith(".pdf") && <button className="peligro-suave" onClick={borrarUltimaSalida} title="Borra la copia recién generada (los originales no se tocan)">Borrar copia</button>}
          </span>
        </div>
      )}

      <div className={`registro${registroAbierto ? " abierto" : ""}`}>
        <button className="registro-cab" type="button" onClick={() => setRegistroAbierto(!registroAbierto)} aria-expanded={registroAbierto}>
          <span className="titulo-registro">Registro de actividad</span>
          {!registroAbierto && (
            registro.length === 0
              ? <span className="registro-resumen vacio">Sin actividad todavía</span>
              : <span className={`registro-resumen ${registro[registro.length - 1].tipo}`}><span className="hora">{registro[registro.length - 1].hora}</span> {registro[registro.length - 1].texto}</span>
          )}
          <span className="registro-flecha"><I n={registroAbierto ? "up" : "down"} s={14} /></span>
        </button>
        {registroAbierto && (
          <div className="registro-lista" ref={registroRef}>
            {registro.length === 0
              ? <div className="registro-vacio">Sin actividad todavía.</div>
              : registro.map((l, i) => (
                <div key={i} className={`registro-linea ${l.tipo}`}>
                  <span className="hora">{l.hora}</span><span>·</span><span>{l.texto}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="creditos">Servicio de Informática · CIS Guillermo Miranda · Murcia</div>

      {/* HISTORIAL */}
      {historial.length > 0 && (
        <details className="historial">
          <summary className="historial-titulo">Procesados esta sesión ({historial.length})</summary>
          <ul className="historial-lista">
            {historial.map((item) => (
              <li key={item.id} className={`historial-item ${item.ok ? "ok" : "err"}`}>
                <span className="historial-op">{item.operacion}</span>
                <span className="historial-nombre">{item.archivos.map(nombreArchivo).join(", ")}</span>
                <span className="historial-fecha">{item.fecha}</span>
                <button className="historial-abrir" onClick={() => invoke("abrir_archivo", { ruta: item.resultado }).catch(() => {})}>Abrir</button>
              </li>
            ))}
          </ul>

        </details>
      )}

      {/* Pie */}
      <footer className="pie-barra">
        <button className="pie-enlace" onClick={abrirLog}><I n="file" s={14} /> Ver log</button>
        <span className="pie-punto">·</span>
        <button className="pie-enlace" onClick={() => setVerManual(true)}><I n="book" s={14} /> Manual</button>
        <span className="pie-punto">·</span>
        <button className="pie-enlace" onClick={() => setVerAcerca(true)}><I n="info" s={14} /> Acerca de</button>
        <span className="pie-espacio" />
        <span className="pie-version">v{__APP_VERSION__}</span>
        <DonateButton />
      </footer>

      {/* DIÁLOGO CIERRE CON OPERACIÓN EN CURSO */}
      {dialogoCierre && (
        <div className="superposicion">
          <div className="dialogo">
            <h4>{algoProcesando ? "Hay una operación en curso" : "Tienes un orden de páginas sin guardar"}</h4>
            <p>
              {algoProcesando
                ? "Si cierras ahora, el proceso se interrumpirá y el archivo puede quedar incompleto."
                : "Si cierras ahora, perderás el nuevo orden de páginas que no has guardado en «Reordenar páginas»."}
            </p>
            <p className="aviso-pequeno" style={{ marginTop: 8 }}>Pulsa Escape para volver.</p>
            <div className="botones-dialogo">
              <button className="secundario" onClick={() => setDialogoCierre(false)}>Volver</button>
              <button className="primario peligro" onClick={() => invoke("cerrar_ventana")}>Cerrar de todas formas</button>
            </div>
          </div>
        </div>
      )}

      {/* VISOR DE LOG */}
      {visorLog !== null && (
        <div className="superposicion" onClick={() => setVisorLog(null)}>
          <div className="dialogo dialogo-log" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <h4>pdftool.log</h4>
              <button className="quitar" style={{ fontSize: 18 }} onClick={() => setVisorLog(null)}>×</button>
            </div>
            <pre className="log-contenido">{visorLog || "(El log está vacío)"}</pre>
          </div>
        </div>
      )}

      {/* MANUAL */}
      {verManual && (
        <div className="superposicion manual-overlay" onClick={() => setVerManual(false)}>
          <div className="manual-ventana" onClick={(e) => e.stopPropagation()}>
            <div className="manual-barra">
              <span className="manual-titulo">Manual de usuario — PDF Tool v{__APP_VERSION__}</span>
              <button className="manual-cerrar" onClick={() => setVerManual(false)}><I n="x" s={14} /> Cerrar</button>
            </div>
            <iframe
              className="manual-iframe"
              srcDoc={manualHtml}
              title="Manual de usuario"
              sandbox="allow-same-origin allow-scripts"
            />
          </div>
        </div>
      )}

      {/* DIÁLOGO ERROR DLL */}
      {dialogoDll && (
        <div className="superposicion">
          <div className="dialogo dialogo-dll">
            <div className="dll-icono">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <h4>Ghostscript no puede cargar su DLL</h4>
            <p className="dll-desc">
              Ghostscript necesita el <strong>Visual C++ Redistributable</strong> instalado en este equipo, o las DLLs junto a su ejecutable.
            </p>
            <div className="dll-opciones">
              <div className="dll-opcion">
                <div className="dll-opcion-num">1</div>
                <div>
                  <strong>Instalar el redistribuible</strong> (recomendado)<br/>
                  <span className="dll-ruta">https://aka.ms/vs/17/release/vc_redist.x64.exe</span>
                </div>
              </div>
              <div className="dll-opcion">
                <div className="dll-opcion-num">2</div>
                <div>
                  <strong>Copiar las DLLs</strong> desde un equipo donde funcione<br/>
                  <span className="dll-ruta">C:\Windows\System32\VCRUNTIME140.dll</span><br/>
                  <span className="dll-ruta">C:\Windows\System32\VCRUNTIME140_1.dll</span><br/>
                  <span className="dll-ruta">C:\Windows\System32\MSVCP140.dll</span><br/>
                  <span className="dll-dest">→ pegarlas en UTILS\gs\bin\</span>
                </div>
              </div>
            </div>
            <div className="botones-dialogo">
              <button className="primario azul" onClick={() => setDialogoDll(false)}>Entendido</button>
            </div>
          </div>
        </div>
      )}

      {/* DIÁLOGOS EXISTENTES */}
      {dialogoArchivosFallidos && (
        <div className="superposicion"><div className="dialogo">
          <h4>Archivos con problemas</h4>
          <p>Los siguientes archivos no se pueden combinar:</p>
          <ul className="lista-procesos lista-borrado">{dialogoArchivosFallidos.archivos.map((a, i) => <li key={i}>{a.nombre} — <span style={{ fontWeight: 400 }}>{a.motivo}</span></li>)}</ul>
          <p className="aviso-pequeno">¿Continuar con el resto de archivos válidos?</p>
          <div className="botones-dialogo">
            <button className="secundario" onClick={() => dialogoArchivosFallidos.resolver(false)}>Cancelar</button>
            <button className="primario azul" onClick={() => dialogoArchivosFallidos.resolver(true)}>Continuar sin ellos</button>
          </div>
        </div></div>
      )}

      {dialogoBloqueo && (
        <div className="superposicion">
          <div className="dialogo dialogo-bloqueo">
            <div className="bloqueo-icono">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <h4>El archivo está siendo usado</h4>
            <p className="bloqueo-desc">No se puede procesar porque está abierto en otro programa.<br/>Ciérralo manualmente o deja que la app lo cierre automáticamente.</p>
            <div className="bloqueo-programas-label">Programa(s) que lo tienen abierto:</div>
            <ul className="bloqueo-programas">
              {dialogoBloqueo.procesos.map((p) => (
                <li key={p.pid}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                  {p.nombre}
                </li>
              ))}
            </ul>
            <div className="bloqueo-aviso">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Si cierras el programa automáticamente, perderás los cambios que no hayas guardado en él.
            </div>
            <div className="botones-dialogo">
              <button className="secundario" onClick={() => dialogoBloqueo.resolver(false)}>Cancelar — lo cierro yo</button>
              <button className="primario peligro" onClick={() => dialogoBloqueo.resolver(true)}>Cerrar programa y continuar</button>
            </div>
          </div>
        </div>
      )}

      {dialogoSobrescritura && (
        <div className="superposicion"><div className="dialogo">
          <h4>El archivo ya existe</h4><p>Ya existe un archivo con ese nombre:</p>
          <ul className="lista-procesos lista-borrado"><li>{nombreArchivo(dialogoSobrescritura.ruta)}</li></ul>
          <div className="botones-dialogo tres">
            <button className="secundario" onClick={() => dialogoSobrescritura.resolver("cancelar")}>Cancelar</button>
            <button className="secundario" onClick={() => dialogoSobrescritura.resolver("renombrar")}>Renombrar (_2…)</button>
            <button className="primario peligro" onClick={() => dialogoSobrescritura.resolver("sobrescribir")}>Sobrescribir</button>
          </div>
        </div></div>
      )}

      <div className="barra-estado" role="status">
        <span className="be-est"><i className={`be-punto${algoProcesando ? " ocupado" : ""}`} />{algoProcesando ? "Procesando…" : "Listo"}</span>
        <span>{HERRAMIENTAS.find((h) => h.id === herramienta)?.etiqueta}</span>
        {herramienta === "visor" && estadoVisor && (<>
          <span className="be-nombre" title={estadoVisor.nombre}>{estadoVisor.nombre}</span>
          <span>{estadoVisor.paginas} {estadoVisor.paginas === 1 ? "página" : "páginas"}</span>
          {estadoVisor.cambios && <span className="be-cambios">Cambios sin guardar</span>}
        </>)}
        <span className="be-der">v{__APP_VERSION__}</span>
      </div>
      <AvisosHost />
      <ConfirmHost />

      {cola && (
        <ColaArchivos archivos={cola.archivos} ignorados={cola.ignorados} nombre={nombreArchivo} cerrar={() => setCola(null)}
          alAbrirVisor={(r) => abrirEnVisor(r)}
          alCombinar={(r) => {
            const nuevas = r.filter((x) => !listaCombinar.includes(x));
            setListaCombinar((p) => [...p, ...nuevas]); cargarInfoPdf(nuevas);
            setHerramienta("combinar"); anotar("info", `Añadidos ${nuevas.length} archivo(s) a Combinar`);
          }}
          alComprimir={(r) => { const { cola: c } = agregarAColaUnica(colaComprimir, r); setColaComprimir(c); setHerramienta("comprimir"); anotar("info", `Añadidos ${r.length} archivo(s) a Comprimir`); }}
          alOcr={(r) => { const { cola: c } = agregarAColaUnica(colaOcr, r); setColaOcr(c); setHerramienta("ocr"); anotar("info", `Añadidos ${r.length} archivo(s) a OCR`); }}
          alImagenes={(r) => { setListaImagenes((p) => [...new Set([...p, ...r])]); setHerramienta("imagenes"); anotar("info", `Añadidas ${r.length} imagen(es)`); }}
          alCombinarTodo={combinarMixto}
        />
      )}

      {verAcerca && <AboutDialog cerrar={() => setVerAcerca(false)} manual={() => setVerManual(true)} />}

      {paletaAbierta && (
        <Paleta cerrar={() => setPaletaAbierta(false)} items={[
          ...HERRAMIENTAS.map((h): ItemPaleta => ({ id: "h-" + h.id, titulo: h.etiqueta, grupo: "Herramienta", accion: () => setHerramienta(h.id) })),
          { id: "abrir", titulo: "Abrir PDF en el visor…", grupo: "Acción", accion: abrirPdfsVisor },
          { id: "tema", titulo: tema === "oscuro" ? "Cambiar a tema claro" : "Cambiar a tema oscuro", grupo: "Acción", accion: () => setTema(tema === "oscuro" ? "claro" : "oscuro") },
          { id: "log", titulo: "Ver log", grupo: "Acción", accion: abrirLog },
          { id: "manual", titulo: "Manual de usuario", grupo: "Acción", accion: () => setVerManual(true) },
          { id: "acerca", titulo: "Acerca de / Créditos", grupo: "Acción", accion: () => setVerAcerca(true) },
        ]} />
      )}

      {zoomReordenar && (
        <div className="superposicion" onClick={() => setZoomReordenar(null)}>
          <div className="zoom-ventana" onClick={(e) => e.stopPropagation()}>
            <div className="zoom-cabecera">
              <span>Página {zoomReordenar.numero}</span>
              <button className="quitar" onClick={() => setZoomReordenar(null)}>×</button>
            </div>
            <img src={zoomReordenar.src} alt={`Página ${zoomReordenar.numero} ampliada`} />
          </div>
        </div>
      )}

      {dialogoDescartarOrden && (
        <div className="superposicion"><div className="dialogo">
          <h4>Orden sin guardar</h4>
          <p>Has cambiado el orden de las páginas pero no lo has guardado. Si continúas, se perderá.</p>
          <div className="botones-dialogo">
            <button className="secundario" onClick={() => dialogoDescartarOrden.resolver(false)}>Volver</button>
            <button className="primario peligro" onClick={() => dialogoDescartarOrden.resolver(true)}>Descartar orden</button>
          </div>
        </div></div>
      )}

      {dialogoBorrado && (
        <div className="superposicion"><div className="dialogo">
          <h4>Borrar archivos originales</h4>
          <p>Se borrarán permanentemente {dialogoBorrado.rutas.length} archivo(s):</p>
          <ul className="lista-procesos lista-borrado">{dialogoBorrado.rutas.map((r) => <li key={r}>{nombreArchivo(r)}</li>)}</ul>
          <p className="aviso-pequeno">Esta acción no se puede deshacer.</p>
          <div className="botones-dialogo">
            <button className="secundario" onClick={() => dialogoBorrado.resolver(false)}>Conservar</button>
            <button className="primario peligro" onClick={() => dialogoBorrado.resolver(true)}>Borrar</button>
          </div>
        </div></div>
      )}
      </div>
      </div>
    </div>
  );
}
