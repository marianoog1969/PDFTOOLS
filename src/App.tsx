import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
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
import manualHtml from "./assets/manual.html?raw";
import { I } from "./Icono";
import { AvisosHost, ConfirmHost, avisar, confirmar } from "./Avisos";
import MenuSuperior, { type GrupoMenu } from "./MenuSuperior";
import ImprimirDialogo, { type PropsImprimir } from "./ImprimirDialogo";
import { LogoApp, SvgCarpeta, SvgCheck, SvgCombinar, SvgComprimir, SvgDividir, SvgExtraer, SvgImagenes, SvgOcr, SvgOffice, SvgReordenar, SvgX } from "./iconos";
import { amigable, esErrorDll, esImagen, esOffice, esPdf, guardarUltimaCarpeta, leerUltimaCarpeta, nombreArchivo, rutaConSufijo } from "./util";
import { ESTADO_ZONA_VACIO, type CtxHerramientas, type EstadoZona, type HistorialItem, type InfoPdf, type Zona, type ZonaTrabajo } from "./herramientas/comun";
import Combinar from "./herramientas/Combinar";
import Extraer from "./herramientas/Extraer";
import Dividir from "./herramientas/Dividir";
import Comprimir from "./herramientas/Comprimir";
import Ocr from "./herramientas/Ocr";
import Imagenes from "./herramientas/Imagenes";
import Office from "./herramientas/Office";

interface LineaRegistro { hora: string; tipo: "info" | "ok" | "err"; texto: string; }
interface ProcesoBloqueo { nombre: string; pid: number; }
interface EstadoUtils { gs: boolean; tesseract: boolean; version_gs?: string; version_tesseract?: string; carpeta_local?: string; carpeta_red?: string; }
interface ResumenProceso { ok: number; error: number; }
const ZONAS_TRABAJO: ZonaTrabajo[] = ["combinar", "extraer", "dividir", "comprimir", "ocr", "imagenes", "office"];

function horaActual(): string { return new Date().toLocaleTimeString("es-ES", { hour12: false }); }

const HERRAMIENTAS: { id: Zona; etiqueta: string; desc: string; grupo: string; icono: ReactNode }[] = [
  { id: "visor", etiqueta: "Visor y organizar", desc: "Lee, organiza, anota y firma PDF en pestañas", grupo: "Documento", icono: <SvgReordenar /> },
  { id: "combinar", etiqueta: "Combinar", desc: "Une varios PDF en uno", grupo: "Organizar páginas", icono: <SvgCombinar /> },
  { id: "extraer", etiqueta: "Extraer páginas", desc: "Saca un rango como PDF nuevo", grupo: "Organizar páginas", icono: <SvgExtraer /> },
  { id: "dividir", etiqueta: "Dividir", desc: "Parte un PDF en varios", grupo: "Organizar páginas", icono: <SvgDividir /> },
  { id: "comprimir", etiqueta: "Comprimir", desc: "Reduce el tamaño del archivo", grupo: "Optimizar y convertir", icono: <SvgComprimir /> },
  { id: "ocr", etiqueta: "OCR", desc: "Hace buscable un PDF escaneado", grupo: "Optimizar y convertir", icono: <SvgOcr /> },
  { id: "imagenes", etiqueta: "Imágenes a PDF", desc: "Convierte fotos y escaneos en PDF", grupo: "Optimizar y convertir", icono: <SvgImagenes /> },
  { id: "office", etiqueta: "Office a PDF", desc: "Convierte Word, Excel y PowerPoint en PDF", grupo: "Optimizar y convertir", icono: <SvgOffice /> },
  { id: "marca", etiqueta: "Marca de agua", desc: "Marca de agua y numeración de páginas", grupo: "Editar contenido", icono: <I n="stamp" s={20} /> },
  { id: "formulario", etiqueta: "Rellenar formulario", desc: "Rellena y aplana campos", grupo: "Editar contenido", icono: <I n="form" s={20} /> },
  { id: "metadatos", etiqueta: "Metadatos", desc: "Revisa y elimina datos ocultos", grupo: "Editar contenido", icono: <I n="shield" s={20} /> },
  { id: "lotes", etiqueta: "Lotes", desc: "Aplica perfiles a carpetas enteras", grupo: "Automatizar", icono: <I n="layers" s={20} /> },
];
const GRUPOS_HERRAMIENTAS = ["Documento", "Organizar páginas", "Optimizar y convertir", "Editar contenido", "Automatizar"];

export default function App() {
  const [registro, setRegistro] = useState<LineaRegistro[]>([]);
  const [registroAbierto, setRegistroAbierto] = useState(false);
  const [avisoUtilsAbierto, setAvisoUtilsAbierto] = useState(false);
  const registroRef = useRef<HTMLDivElement>(null);
  const [solicitudVisor, setSolicitudVisor] = useState<{ rutas: string[]; n: number } | null>(null);
  const [paletaAbierta, setPaletaAbierta] = useState(false);
  const [cola, setCola] = useState<{ archivos: ArchivoCola[]; ignorados: string[] } | null>(null);
  const [recientes, setRecientes] = useState<string[]>(() => { try { const v = JSON.parse(localStorage.getItem("pdftool_recientes") ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 8) : []; } catch { return []; } });
  const [tema, setTema] = useState<"claro" | "oscuro">(() => { let g: string | null = null; try { g = localStorage.getItem("pdftool_tema"); } catch { /* sin almacenamiento */ } if (g === "oscuro" || g === "claro") return g; try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "oscuro" : "claro"; } catch { return "claro"; } });
  const [verAtajos, setVerAtajos] = useState(false);
  const [estadoVisor, setEstadoVisor] = useState<{ ruta: string; nombre: string; paginas: number; cambios: boolean; modo: string } | null>(null);
  const [impresion, setImpresion] = useState<Omit<PropsImprimir, "cerrar" | "registrar"> | null>(null);
  const [ultimaSalida, setUltimaSalida] = useState<string | null>(null);
  useEffect(() => {
    if (!ultimaSalida) return;
    const ruta = ultimaSalida;
    // En las herramientas ya se ve la tarjeta de resultado; el aviso flotante solo hace falta en el visor.
    if (herramientaRef.current !== "visor") return;
    avisar({ tipo: "ok", titulo: "Archivo guardado", texto: ruta.split(/[\\/]/).pop(), acciones: [
      { texto: "Abrir", principal: true, hacer: () => abrirEnVisor([ruta]) },
      { texto: "Abrir carpeta", hacer: () => { invoke("abrir_carpeta", { ruta }).catch(() => {}); } },
    ] });
  }, [ultimaSalida]);
  const [originalesCombinados, setOriginalesCombinados] = useState<{ salida: string; rutas: string[] } | null>(null);
  async function borrarOriginalesCombinados() {
    if (!originalesCombinados) return;
    const { rutas } = originalesCombinados;
    if (!(await confirmar({ titulo: `¿Borrar los ${rutas.length} archivos originales?`, texto: `${rutas.map(nombreArchivo).join("\n")}\n\nEl PDF combinado se conserva. Esta acción no se puede deshacer.`, ok: "Borrar originales", peligro: true }))) return;
    try {
      const errores = await invoke<string[]>("borrar_archivos", { rutas });
      if (errores.length === 0) anotar("ok", `Borrados ${rutas.length} archivo(s) originales`); else errores.forEach((e) => anotar("err", e));
      setRecientes((prev) => { const n = prev.filter((r) => !rutas.includes(r)); try { localStorage.setItem("pdftool_recientes", JSON.stringify(n)); } catch { /* */ } return n; });
      setOriginalesCombinados(null);
    } catch (e) { anotar("err", amigable(String(e))); }
  }
  const [resumenUltimo, setResumenUltimo] = useState<ResumenProceso | null>(null);
  const [infosPdf, setInfosPdf] = useState<Record<string, InfoPdf>>({});
  const [zonaActiva, setZonaActiva] = useState<Zona | null>(null);
  const [herramienta, setHerramienta] = useState<Zona>("visor");
  const herramientaRef = useRef<Zona>("visor");
  herramientaRef.current = herramienta;
  const [utils, setUtils] = useState<EstadoUtils | null>(null);
  const [dialogoBloqueo, setDialogoBloqueo] = useState<{ procesos: ProcesoBloqueo[]; resolver: (v: boolean) => void } | null>(null);
  const [dialogoSobrescritura, setDialogoSobrescritura] = useState<{ ruta: string; resolver: (v: "sobrescribir" | "renombrar" | "cancelar") => void } | null>(null);
  const [dialogoDll, setDialogoDll] = useState(false);
  const [verManual, setVerManual] = useState(false);
  const [verAcerca, setVerAcerca] = useState(false);
  const [lateralCompacto, setLateralCompacto] = useState<boolean>(() => { try { return localStorage.getItem("pdftool_lateral_compacto") === "1"; } catch { return false; } });
  const alternarLateral = () => setLateralCompacto((v) => { const n = !v; try { localStorage.setItem("pdftool_lateral_compacto", n ? "1" : "0"); } catch { /* */ } return n; });
  const [dialogoCierre, setDialogoCierre] = useState(false);
  const [visorLog, setVisorLog] = useState<string | null>(null);
  const [historial, setHistorial] = useState<HistorialItem[]>([]);
  const [cargandoInfos, setCargandoInfos] = useState<Set<string>>(new Set());
  const [eta, setEta] = useState<string | null>(null);
  const [archivosSobre, setArchivosSobre] = useState<string[] | null>(null);
  const [estadosZona, setEstadosZona] = useState<Record<ZonaTrabajo, EstadoZona>>(() => Object.fromEntries(ZONAS_TRABAJO.map((z) => [z, ESTADO_ZONA_VACIO])) as Record<ZonaTrabajo, EstadoZona>);

  // Estado global derivado de lo que cuenta cada herramienta
  const zonaProcesando: ZonaTrabajo | null = ZONAS_TRABAJO.find((z) => estadosZona[z].procesando) ?? null;
  // «Combinar todo» desde la cola de archivos soltados (PDF e imágenes mezclados)
  const [combinandoMixto, setCombinandoMixto] = useState(false);
  const algoProcesando = zonaProcesando !== null || combinandoMixto;
  const fraccionGlobal: number | null = zonaProcesando ? estadosZona[zonaProcesando].fraccion : null;
  const etiquetaProceso = zonaProcesando ? estadosZona[zonaProcesando].etiqueta ?? "Procesando…" : combinandoMixto ? "Convirtiendo y combinando…" : "";

  useEffect(() => { if (registroRef.current) registroRef.current.scrollTop = registroRef.current.scrollHeight; }, [registro, registroAbierto]);
  // Si aparece un error, el registro se despliega solo
  useEffect(() => { if (registro.length && registro[registro.length - 1].tipo === "err") setRegistroAbierto(true); }, [registro]);

  const fechaLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

  const opIni = useRef<number | null>(null);
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
      let todas = ev.payload.paths;
      if (algoProcesando) return;

      // Los documentos de Office van siempre a «Office a PDF», se suelten donde se suelten
      const deOffice = zona === "office" || zona === "lotes" ? [] : todas.filter(esOffice);
      if (deOffice.length) {
        const resto = todas.filter((p) => !esOffice(p));
        const aceptaResto = zona === "visor" ? resto.some((p) => esPdf(p) || esImagen(p)) : resto.some(zona === "imagenes" ? esImagen : esPdf);
        if (!aceptaResto) setHerramienta("office");
        anotar("info", `${deOffice.length} documento(s) de Office enviados a «Office a PDF»`);
        enviarAZona("office", deOffice);
        if (!resto.length) return;
        todas = resto;
      }

      if (zona === "visor") {
        const archivos: ArchivoCola[] = todas.filter((p) => esPdf(p) || esImagen(p)).map((p) => ({ ruta: p, tipo: esPdf(p) ? "pdf" : "imagen" }));
        const ignorados = todas.filter((p) => !esPdf(p) && !esImagen(p));
        if (ignorados.length) anotar("info", `${ignorados.length} archivo(s) ignorado(s) (no son PDF ni imágenes): ${ignorados.slice(0, 3).map(nombreArchivo).join(", ")}${ignorados.length > 3 ? "…" : ""}`);
        if (archivos.length === 0) return;
        if (archivos.length === 1 && archivos[0].tipo === "pdf") setSolicitudVisor({ rutas: [archivos[0].ruta], n: Date.now() });
        else setCola({ archivos, ignorados });
        return;
      }
      // Cada herramienta recibe solo los archivos que admite (imágenes en «Imágenes a PDF»; PDF en el resto)
      const admite = zona === "imagenes" ? esImagen : zona === "office" ? esOffice : zona === "lotes" ? (p: string) => esPdf(p) || esOffice(p) : esPdf;
      const rutas = todas.filter(admite);
      const ignorados = todas.length - rutas.length;
      if (ignorados > 0) anotar("info", `${ignorados} archivo(s) ignorado(s): solo se aceptan ${zona === "imagenes" ? "imágenes" : zona === "office" ? "documentos de Office" : zona === "lotes" ? "PDF y documentos de Office" : "PDF"} aquí`);
      if (rutas.length) enviarAZona(zona, rutas);
    });
    return () => { promesa.then((c) => c()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- se vuelve a suscribir solo si cambia si hay algo en proceso
  }, [algoProcesando]);

  /** Envía archivos a una herramienta (la escucha con useSoltar). */
  function enviarAZona(zona: Zona, rutas: string[]) {
    window.dispatchEvent(new CustomEvent("pdftool-soltar", { detail: { zona, rutas } }));
  }


  function preguntarBloqueo(procesos: ProcesoBloqueo[]): Promise<boolean> { return new Promise((r) => setDialogoBloqueo({ procesos, resolver: r })); }
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

  async function abrirErrores() {
    try {
      const contenido = await invoke<string>("leer_errores");
      setVisorLog(contenido || "(No hay errores registrados)");
    } catch (e) { anotar("err", amigable(String(e))); }
  }

  // Solo resetea el flag de cancelación en el backend, sin tocar ETA/contadores.
  // Necesario en toda operación de un solo disparo (combinar, extraer, imágenes
  // combinadas, miniaturas, reordenar): si el usuario canceló una operación anterior,
  // el flag se queda en "true" en el backend hasta que alguien lo resetea explícitamente,
  // y si nadie lo hace la siguiente operación fallaría de inmediato como si ya estuviese cancelada.
  async function limpiarCancelacion() {
    try { await invoke("resetear_cancelacion"); } catch { /* no crítico */ }
  }

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
  }, [algoProcesando, verAcerca, verManual, visorLog, dialogoCierre]); // eslint-disable-line react-hooks/exhaustive-deps -- «cancelar» se recrea en cada render y no cambia la lógica

  // Interceptar cierre de ventana: avisa si hay una operación en curso o cambios sin guardar en el visor
  useEffect(() => {
    const p = listen("close-requested", () => {
      if (algoProcesando || estadoVisor?.cambios) { setDialogoCierre(true); }
      else { invoke("cerrar_ventana"); }
    });
    return () => { p.then((c) => c()); };
  }, [algoProcesando, estadoVisor?.cambios]);


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
      // Ctrl+P: nuestro panel de impresión (si no, WebView2 imprimiría la propia interfaz de la app)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); atajoImprimir.current(); }
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
  /** Abre el panel de impresión. Sin ruta, pide elegir el PDF. */
  async function pedirImpresion(ruta?: string, conCambios = false, paginas?: string) {
    if (!ruta) {
      const r = await open({ defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
      if (!r || Array.isArray(r)) return;
      ruta = r;
    }
    const info = (await cargarInfoPdf([ruta]))[ruta];
    if (info?.protegido) { anotar("err", `PDF protegido con contraseña: ${nombreArchivo(ruta)}`); return; }
    setImpresion({ ruta, total: info?.paginas ?? 0, paginasIniciales: paginas, aviso: conCambios ? "Se imprime el archivo tal como está guardado: los cambios de páginas y anotaciones sin aplicar no saldrán." : undefined });
  }
  // El atajo Ctrl+P se registra una sola vez: llama siempre a la versión actual a través de esta referencia.
  const atajoImprimir = useRef<() => void>(() => {});
  atajoImprimir.current = () => { if (!impresion) imprimirActual(); };
  function imprimirActual() {
    if (herramientaRef.current === "visor" && estadoVisor) pedirImpresion(estadoVisor.ruta, estadoVisor.cambios);
    else if (ultimaSalida?.toLowerCase().endsWith(".pdf")) pedirImpresion(ultimaSalida);
    else pedirImpresion();
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
    setCombinandoMixto(true);
    anotar("info", `Convirtiendo y combinando ${rutas.length} archivos`);
    let dirTmp: string | null = null;
    try {
      const prep = await invoke<{ dir: string; rutas: string[] }>("preparar_mixto", { rutas });
      dirTmp = prep.dir;
      await invoke("combinar_pdfs", { rutas: prep.rutas, salida });
      setCombinandoMixto(false);
      guardarUltimaCarpeta(salida);
      anotar("ok", `Generado: ${salida}`);
      guardarEnHistorial({ operacion: "combinar", archivos: rutas, resultado: salida, ok: true });
      await abrirResultado(salida);
    } catch (e) { setCombinandoMixto(false); manejarErrorGs(e); }
    finally { if (dirTmp) invoke("limpiar_carpeta_cola", { dir: dirTmp }).catch(() => {}); }
  }

  async function abrirPdfsVisor() {
    const rutas = await open({ multiple: true, defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!rutas) return;
    const lista = Array.isArray(rutas) ? rutas : [rutas];
    setHerramienta("visor");
    setSolicitudVisor({ rutas: lista, n: Date.now() });
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

  const ultimoRegistro = registro.length ? registro[registro.length - 1] : null;

  // Lo que comparten todas las herramientas de la zona de trabajo
  const ctx: CtxHerramientas = {
    ocupado: algoProcesando, zonaArrastre: zonaActiva, herramienta, registrar: anotar,
    infosPdf, cargandoInfos, cargarInfoPdf, verificarProteccion, rutaDisponible, comprobarYDesbloquear,
    manejarError: manejarErrorGs, limpiarCancelacion,
    abrirResultado: (ruta) => { abrirResultado(ruta); },
    resultadosVarios: (ultima) => { setUltimaSalida(ultima); invoke("abrir_carpeta", { ruta: ultima }).catch(() => anotar("info", "No se pudo abrir la carpeta de resultados")); },
    guardarEnHistorial, setResumen: setResumenUltimo,
    ofrecerBorrarOriginales: (salida, rutas) => setOriginalesCombinados({ salida, rutas }),
    reportar: (zona, e) => setEstadosZona((p) => {
      const a = p[zona];
      return a.procesando === e.procesando && a.pendientes === e.pendientes && a.fraccion === e.fraccion && a.etiqueta === e.etiqueta ? p : { ...p, [zona]: e };
    }),
  };


  const enVisor = (detail: string) => { setHerramienta("visor"); setTimeout(() => window.dispatchEvent(new CustomEvent("pdftool-visor", { detail })), 0); };
  const gruposMenu: GrupoMenu[] = [
    { titulo: "Archivo", items: [
      { texto: "Abrir PDF…", atajo: "Ctrl+O", hacer: abrirPdfsVisor },
      { texto: "Abrir reciente", sub: recientes.map((r) => ({ texto: nombreArchivo(r), hacer: () => abrirEnVisor([r]) })) },
      { sep: true },
      { texto: estadoVisor ? `Imprimir «${estadoVisor.nombre}»…` : "Imprimir un PDF…", atajo: "Ctrl+P", hacer: () => { if (estadoVisor) pedirImpresion(estadoVisor.ruta, estadoVisor.cambios); else pedirImpresion(); } },
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
    { titulo: "Herramientas", items: [
      { texto: "Firmar PDF", hacer: () => enVisor("modo:firmar") },
      { texto: "Anotar", hacer: () => enVisor("modo:anotar") },
      { texto: "Organizar páginas", hacer: () => enVisor("modo:organizar") },
      { sep: true },
      ...HERRAMIENTAS.filter((h) => h.id !== "visor").map((h) => ({ texto: h.etiqueta, hacer: () => setHerramienta(h.id) })),
    ] },
    { titulo: "Ayuda", items: [
      { texto: "Manual de usuario", hacer: () => setVerManual(true) },
      { texto: "Atajos de teclado", atajo: "?", hacer: () => setVerAtajos(true) },
      { texto: "Ver log", hacer: abrirLog },
      { texto: "Ver log de errores", hacer: abrirErrores },
      { sep: true },
      { texto: "Acerca de PDF Tool", hacer: () => setVerAcerca(true) },
    ] },
  ];

  return (
    <div className="shell">
      <div className="cabecera">
        <div className="marca">
          <LogoApp tam={30} />
          <div>
            <h1>PDF Tool</h1>
            <span className="subtitulo">Combinar · Comprimir · OCR · Extraer · Imágenes</span>
          </div>
        </div>
        <MenuSuperior grupos={gruposMenu} />
        <div className="header-right">
          <button className="btn-cab-buscar" onClick={() => setPaletaAbierta(true)} title="Buscar herramientas y acciones (Ctrl+K)">
            <I n="search" s={14} /><span>Buscar…</span><kbd>Ctrl K</kbd>
          </button>
          <button className="btn-tema" onClick={() => setTema(tema === "oscuro" ? "claro" : "oscuro")} title={tema === "oscuro" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"} aria-label="Cambiar tema"><I n={tema === "oscuro" ? "sun" : "moon"} s={17} /></button>
          <button className="btn-tema" onClick={() => setVerAtajos(true)} title="Atajos de teclado (?)" aria-label="Atajos de teclado"><I n="help" s={17} /></button>
          <DonateButton compacto />
        </div>
      </div>

      {verAtajos && (
        <div className="modal-fondo" onClick={() => setVerAtajos(false)}>
          <div className="modal-caja" role="dialog" aria-modal="true" aria-label="Atajos de teclado" onClick={(e) => e.stopPropagation()}>
            <div className="modal-cab"><h3>Atajos de teclado</h3><button className="modal-x" onClick={() => setVerAtajos(false)} aria-label="Cerrar"><I n="x" /></button></div>
            <dl className="atajos">
              {([["Ctrl + K", "Buscar acción o archivo"], ["Ctrl + P", "Imprimir el documento abierto"], ["Ctrl + B", "Encoger o ampliar el panel izquierdo"], ["Ctrl + Z / Ctrl + Y", "Deshacer / rehacer (Organizar)"], ["Supr", "Eliminar páginas o anotación seleccionada"], ["← →", "Mover la página seleccionada"], ["?", "Mostrar esta ayuda"], ["Esc", "Cerrar diálogos"]] as const).map(([k, d]) => (
                <div key={k}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>
              ))}
            </dl>
          </div>
        </div>
      )}

      <div className="cuerpo">
      <nav className={`lateral${lateralCompacto ? " compacto" : ""}`}>
        {GRUPOS_HERRAMIENTAS.map((grupo) => (
          <div className="lateral-grupo" key={grupo}>
            <div className="lateral-titulo">{grupo}</div>
            {HERRAMIENTAS.filter((h) => h.grupo === grupo).map((h) => {
              const ocupada = zonaProcesando === h.id;
              const pendientes = (ZONAS_TRABAJO as string[]).includes(h.id) ? estadosZona[h.id as ZonaTrabajo].pendientes : 0;
              return (
                <button key={h.id} className={`lateral-item${herramienta === h.id ? " activa" : ""}`} onClick={() => setHerramienta(h.id)}
                  title={`${h.etiqueta} — ${h.desc}`} aria-current={herramienta === h.id ? "page" : undefined}>
                  {h.icono}<span className="lateral-txt">{h.etiqueta}</span>
                  {ocupada ? <i className="lateral-ocupada" aria-label="Procesando" /> : pendientes > 0 ? <b className="lateral-cuenta" aria-label={`${pendientes} en espera`}>{pendientes}</b> : null}
                </button>
              );
            })}
          </div>
        ))}
        <div className="lateral-pie">
          <button className="lateral-item lateral-alternar" onClick={alternarLateral} title={lateralCompacto ? "Ampliar el menú (Ctrl+B)" : "Contraer el menú (Ctrl+B)"} aria-label={lateralCompacto ? "Ampliar el menú lateral" : "Contraer el menú lateral"}>
            <I n={lateralCompacto ? "right" : "left"} s={16} /><span className="lateral-txt">Contraer menú</span>
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
          recientes={recientes} alAbrir={anadirReciente} alEstado={setEstadoVisor} imprimir={(r, c, pags) => pedirImpresion(r, c, pags)} alGenerar={(r) => { setUltimaSalida(r); anadirReciente(r); }} abrirReciente={(r) => abrirEnVisor([r])} borrarRecientes={borrarRecientes}
        />
      </div>
      {(() => {
        if (!utils) return null;
        const faltaGs = !utils.gs && herramienta !== "imagenes" && herramienta !== "office";
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
        const admite = (p: string) => z === "imagenes" ? esImg(p) : z === "office" ? esOffice(p) : z === "lotes" ? esPdf(p) || esOffice(p) : z === "visor" ? esPdf(p) || esImg(p) : esPdf(p);
        const of = z === "office" || z === "lotes" ? 0 : archivosSobre.filter(esOffice).length;
        const ok = archivosSobre.filter(admite).length, no = archivosSobre.length - ok - of;
        const etiqueta = HERRAMIENTAS.find((h) => h.id === z)?.etiqueta ?? z;
        const formatos = z === "imagenes" ? "imágenes (JPG, PNG, HEIC…)" : z === "office" ? "documentos de Word, Excel y PowerPoint" : z === "lotes" ? "PDF y documentos de Office" : z === "visor" ? "PDF e imágenes" : "archivos PDF";
        return (
          <div className={`aviso-arrastre${ok + of === 0 ? " sin-validos" : ""}`}>
            <b>{ok > 0 ? `Suelta para añadir ${ok} archivo(s) a «${etiqueta}»` : of > 0 ? `Suelta para convertir ${of} documento(s) de Office a PDF` : `«${etiqueta}» no admite estos archivos`}</b>
            <span>{of > 0 && ok > 0 ? `Los ${of} de Office irán a «Office a PDF»` : `Admite ${formatos}`}{no > 0 && ok + of > 0 ? ` · se ignorarán ${no}` : ""}</span>
          </div>
        );
      })()}

      {algoProcesando && (
        <div className="barra-cancelar">
          <div className="barra-cancelar-cuerpo">
          <div className="barra-cancelar-izq">
            <div className="cancel-dot" />
            <span className="cancel-label">{etiquetaProceso}</span>
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

      <div className="tarjetas">
        <Combinar ctx={ctx} />
        <Extraer ctx={ctx} />
        <Dividir ctx={ctx} />
        <Comprimir ctx={ctx} />
        <Ocr ctx={ctx} />
        <Imagenes ctx={ctx} />
        <Office ctx={ctx} />

        <div className={`tarjeta${herramienta !== "marca" ? " oculta" : ""}${zonaActiva === "marca" ? " arrastrando" : ""}`} data-zona="marca">
          <div className="cabecera-tarjeta">
            <span className="icono azul"><I n="stamp" s={20} /></span>
            <div className="cab-texto"><h3>Marca de agua y numeración</h3><div className="cab-desc">Texto en diagonal y números de página</div></div>
          </div>
          <MarcaPdf alGenerar={(r) => { setUltimaSalida(r); anadirReciente(r); }} registrar={anotar} zona="marca" />
        </div>

        <div className={`tarjeta${herramienta !== "formulario" ? " oculta" : ""}${zonaActiva === "formulario" ? " arrastrando" : ""}`} data-zona="formulario">
          <div className="cabecera-tarjeta">
            <span className="icono azul"><I n="form" s={20} /></span>
            <div className="cab-texto"><h3>Rellenar formulario</h3><div className="cab-desc">Rellena los campos y, si quieres, aplana el resultado</div></div>
          </div>
          <FormularioPdf alGenerar={(r) => { setUltimaSalida(r); anadirReciente(r); }} registrar={anotar} zona="formulario" />
        </div>

        <div className={`tarjeta${herramienta !== "metadatos" ? " oculta" : ""}${zonaActiva === "metadatos" ? " arrastrando" : ""}`} data-zona="metadatos">
          <div className="cabecera-tarjeta">
            <span className="icono azul"><I n="shield" s={20} /></span>
            <div className="cab-texto"><h3>Metadatos y limpieza</h3><div className="cab-desc">Revisa y elimina autor, XMP, adjuntos y JavaScript</div></div>
          </div>
          <MetadatosPdf alGenerar={(r) => { setUltimaSalida(r); anadirReciente(r); }} registrar={anotar} zona="metadatos" />
        </div>

        <div className={`tarjeta${herramienta !== "lotes" ? " oculta" : ""}${zonaActiva === "lotes" ? " arrastrando" : ""}`} data-zona="lotes">
          <div className="cabecera-tarjeta">
            <span className="icono azul"><I n="layers" s={20} /></span>
            <div className="cab-texto"><h3>Lotes y perfiles</h3><div className="cab-desc">Aplica una cadena de pasos a carpetas completas</div></div>
          </div>
          <LotesPdf alGenerar={(r) => { setUltimaSalida(r); anadirReciente(r); }} registrar={anotar} zona="lotes" />
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
            {ultimaSalida.toLowerCase().endsWith(".pdf") && <button onClick={() => pedirImpresion(ultimaSalida)}><I n="printer" s={15} /> Imprimir</button>}
            <button onClick={abrirCarpetaSalida}><SvgCarpeta /> Abrir carpeta</button>
            {ultimaSalida.toLowerCase().endsWith(".pdf") && <button onClick={abrirSalidaExterna} title="Abrir con el programa predeterminado de Windows">Abrir con…</button>}
            <button onClick={() => { navigator.clipboard?.writeText(ultimaSalida).then(() => anotar("info", "Ruta copiada al portapapeles")).catch(() => {}); }}>Copiar ruta</button>
            {originalesCombinados?.salida === ultimaSalida && <button className="peligro-suave" onClick={borrarOriginalesCombinados} title="Borra los PDF que se usaron para combinar (el combinado se conserva)">Borrar originales ({originalesCombinados.rutas.length})</button>}
            {ultimaSalida.toLowerCase().endsWith(".pdf") && <button className="peligro-suave" onClick={borrarUltimaSalida} title="Borra la copia recién generada (los originales no se tocan)">Borrar copia</button>}
          </span>
        </div>
      )}

      {registro.length > 0 && <div className={`registro${registroAbierto ? " abierto" : ""}`}>
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
      </div>}


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
        <span className="be-espacio" />
        {ultimoRegistro && (
          <button type="button" className={`be-msg ${ultimoRegistro.tipo}`} onClick={abrirLog} title={`${ultimoRegistro.hora} · ${ultimoRegistro.texto}\n\nClic para ver el log completo`}>
            <I n={ultimoRegistro.tipo === "err" ? "warn" : ultimoRegistro.tipo === "ok" ? "check" : "info"} s={13} />
            <span>{ultimoRegistro.texto}</span>
          </button>
        )}
        {utils && (
          utils.gs && utils.tesseract
            ? <span className="be-comp ok" title={`Componentes instalados\nGhostscript ${utils.version_gs ?? ""}\n${utils.version_tesseract ?? "Tesseract"}`}><i className="be-punto" />Componentes</span>
            : <button type="button" className="be-comp falta" onClick={() => invoke("abrir_carpeta_utils").catch(() => {})}
                title={`Falta ${[!utils.gs && "Ghostscript", !utils.tesseract && "Tesseract"].filter(Boolean).join(" y ")} en la carpeta UTILS.\nClic para abrir la carpeta.`}>
                <I n="warn" s={13} />Falta {[!utils.gs && "Ghostscript", !utils.tesseract && "Tesseract"].filter(Boolean).join(" y ")}
              </button>
        )}
        <button type="button" className="be-der" onClick={() => setVerAcerca(true)} title="Acerca de PDF Tool">v{__APP_VERSION__}</button>
      </div>
      {impresion && <ImprimirDialogo {...impresion} cerrar={() => setImpresion(null)} registrar={anotar} />}
      <AvisosHost />
      <ConfirmHost />

      {cola && (
        <ColaArchivos archivos={cola.archivos} ignorados={cola.ignorados} nombre={nombreArchivo} cerrar={() => setCola(null)}
          alAbrirVisor={(r) => abrirEnVisor(r)}
          alCombinar={(r) => { setHerramienta("combinar"); enviarAZona("combinar", r); }}
          alComprimir={(r) => { setHerramienta("comprimir"); enviarAZona("comprimir", r); }}
          alOcr={(r) => { setHerramienta("ocr"); enviarAZona("ocr", r); }}
          alImagenes={(r) => { setHerramienta("imagenes"); enviarAZona("imagenes", r); }}
          alCombinarTodo={combinarMixto}
        />
      )}

      {verAcerca && <AboutDialog cerrar={() => setVerAcerca(false)} manual={() => setVerManual(true)} />}

      {paletaAbierta && (
        <Paleta cerrar={() => setPaletaAbierta(false)} items={[
          ...HERRAMIENTAS.map((h): ItemPaleta => ({ id: "h-" + h.id, titulo: h.etiqueta, grupo: "Herramienta", accion: () => setHerramienta(h.id) })),
          { id: "abrir", titulo: "Abrir PDF en el visor…", grupo: "Acción", accion: abrirPdfsVisor },
          { id: "imprimir", titulo: estadoVisor ? `Imprimir «${estadoVisor.nombre}»` : "Imprimir un PDF…", grupo: "Acción", accion: () => { if (estadoVisor) pedirImpresion(estadoVisor.ruta, estadoVisor.cambios); else pedirImpresion(); } },
          { id: "m-firmar", titulo: "Firmar PDF (certificado / DNIe) y validar firmas", grupo: "Visor", accion: () => enVisor("modo:firmar") },
          { id: "m-anotar", titulo: "Anotar, resaltar o tachar", grupo: "Visor", accion: () => enVisor("modo:anotar") },
          { id: "m-organizar", titulo: "Organizar páginas (girar, mover, eliminar)", grupo: "Visor", accion: () => enVisor("modo:organizar") },
          { id: "tema", titulo: tema === "oscuro" ? "Cambiar a tema claro" : "Cambiar a tema oscuro", grupo: "Acción", accion: () => setTema(tema === "oscuro" ? "claro" : "oscuro") },
          { id: "log", titulo: "Ver log", grupo: "Acción", accion: abrirLog },
          { id: "manual", titulo: "Manual de usuario", grupo: "Acción", accion: () => setVerManual(true) },
          { id: "acerca", titulo: "Acerca de / Créditos", grupo: "Acción", accion: () => setVerAcerca(true) },
          ...recientes.map((r): ItemPaleta => ({ id: "r-" + r, titulo: nombreArchivo(r), grupo: "Reciente", accion: () => abrirEnVisor([r]) })),
        ]} />
      )}

      </div>
      </div>
    </div>
  );
}
