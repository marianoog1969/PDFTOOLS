import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import VisorPdf from "./VisorPdf";
import AnotadorPdf, { type Anot } from "./AnotadorPdf";
import { I } from "./Icono";
import { aRango } from "./util";
import { avisar, confirmar } from "./Avisos";

interface InfoPdf { paginas: number; protegido: boolean; corrupto: boolean; error?: string; tamano_bytes: number; }
interface PagOrg { id: number; origen: number | null; rot: number; fuente?: string; mini?: string; }
type Modo = "leer" | "organizar" | "anotar";

interface Doc {
  ruta: string;
  hires?: boolean;
  total: number;
  minis: string[];
  cargandoMinis: boolean;
  paginas: PagOrg[];
  undo: PagOrg[][];
  redo: PagOrg[][];
  anot: Anot[];
  modo: Modo;
  sel: number[];
  irA: { pagina: number; n: number } | null;
}

export interface ToolInfo { id: string; etiqueta: string; desc: string; icono: ReactNode; }

interface Props {
  solicitud: { rutas: string[]; n: number } | null;
  ocupado: boolean;
  herramientas: ToolInfo[];
  irHerramienta: (id: string) => void;
  abrirDialogo: () => void;
  infoPdf: (rutas: string[]) => Promise<Record<string, InfoPdf>>;
  verificarProteccion: (rutas: string[]) => Promise<boolean>;
  rutaDisponible: (base: string) => Promise<string | null>;
  rutaConSufijo: (ruta: string, sufijo: string) => string;
  nombreArchivo: (ruta: string) => string;
  log: (tipo: "info" | "ok" | "err", texto: string) => void;
  manejarError: (e: unknown) => void;
  historial: (operacion: "organizar" | "anotar", archivo: string, resultado: string) => void;
  recientes: string[];
  alGenerar: (ruta: string) => void;         // un resultado nuevo (alimenta la tarjeta «Último resultado»)
  alAbrir: (ruta: string) => void;           // se llama al abrir una pestaña (para «recientes»)
  abrirReciente: (ruta: string) => void;
  borrarRecientes: () => void;
  alEstado?: (e: { ruta: string; nombre: string; paginas: number; cambios: boolean; modo: string } | null) => void;
  imprimir?: (ruta: string, conCambios: boolean, paginas?: string) => void;
}

interface Acierto { pagina: number; cuenta: number; fragmento: string; }
interface Busqueda { q: string; cargando: boolean; hayTexto: boolean; aciertos: Acierto[]; error?: string; }

const ident = (n: number): PagOrg[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, origen: i + 1, rot: 0 }));
const hayCambios = (d: Doc) => d.paginas.length !== d.total || d.paginas.some((p, i) => p.origen !== i + 1 || p.rot !== 0 || !!p.fuente);
let idBlanca = 100000;

function saludo() { const h = new Date().getHours(); return h < 6 ? "Buenas noches" : h < 14 ? "Buenos días" : h < 21 ? "Buenas tardes" : "Buenas noches"; }

export default function Visor(P: Props) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [activa, setActiva] = useState<string | null>(null);
  const [tam, setTamEstado] = useState<number>(() => { try { const v = parseInt(localStorage.getItem("pdftool_tam_mini") ?? "", 10); return v >= 50 && v <= 400 ? v : 100; } catch { return 100; } });
  const setTam = (v: number) => { setTamEstado(v); try { localStorage.setItem("pdftool_tam_mini", String(v)); } catch { /* sin almacenamiento */ } };
  const [busquedas, setBusquedas] = useState<Record<string, Busqueda>>({});
  const [consulta, setConsulta] = useState("");
  const [panelBusqueda, setPanelBusqueda] = useState(false);
  const [minisOcultas, setMinisOcultas] = useState<boolean>(() => { try { return localStorage.getItem("pdftool_minis_ocultas") === "1"; } catch { return false; } });
  const alternarMinis = () => setMinisOcultas((o) => { const n = !o; try { localStorage.setItem("pdftool_minis_ocultas", n ? "1" : "0"); } catch { /* */ } return n; });
  useEffect(() => { document.body.classList.toggle("minis-ocultas", minisOcultas); return () => document.body.classList.remove("minis-ocultas"); }, [minisOcultas]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [arrastrando, setArrastrando] = useState<number[] | null>(null);
  const [tabDestino, setTabDestino] = useState<string | null>(null);
  const [fantasma, setFantasma] = useState<{ x: number; y: number; txt: string } | null>(null);
  const [destino, setDestino] = useState<number | null>(null);
  const ancla = useRef<number | null>(null);
  const docsRef = useRef<Doc[]>([]);
  docsRef.current = docs;
  const activaRef = useRef<string | null>(null);
  const modoPendiente = useRef<Modo | null>(null);
  activaRef.current = activa;

  const doc = docs.find((d) => d.ruta === activa) ?? null;
  const upd = (ruta: string, f: (d: Doc) => Doc) => setDocs((p) => p.map((d) => (d.ruta === ruta ? f(d) : d)));

  async function cargarMinis(ruta: string, nuevaRuta = ruta, dpi = 36) {
    try {
      const m = await invoke<string[]>("miniaturas_visor", { entrada: nuevaRuta, dpi });
      upd(nuevaRuta, (d) => ({ ...d, minis: m, cargandoMinis: false, hires: dpi > 36 }));
    } catch (e) {
      upd(nuevaRuta, (d) => ({ ...d, cargandoMinis: false }));
      P.log("err", `Miniaturas: ${e}`);
    }
    void ruta;
  }

  async function abrir(ruta: string) {
    if (docsRef.current.some((d) => d.ruta === ruta)) { setActiva(ruta); return; }
    const info = (await P.infoPdf([ruta]))[ruta];
    if (!info || info.corrupto || info.paginas === 0) { P.log("err", `No se puede abrir ${P.nombreArchivo(ruta)}: PDF dañado o vacío`); return; }
    if (info.protegido) { P.log("err", `${P.nombreArchivo(ruta)} está protegido con contraseña; quítale la protección para abrirlo`); return; }
    const nuevo: Doc = { ruta, total: info.paginas, minis: [], cargandoMinis: true, paginas: ident(info.paginas), undo: [], redo: [], anot: [], modo: "leer", sel: [], irA: null };
    P.alAbrir(ruta);
    setDocs((p) => [...p, nuevo]);
    setActiva(ruta);
    cargarMinis(ruta);
  }

  useEffect(() => {
    if (!P.solicitud) return;
    (async () => { for (const r of P.solicitud!.rutas) await abrir(r); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [P.solicitud?.n]);

  async function cerrar(ruta: string) {
    const d = docsRef.current.find((x) => x.ruta === ruta);
    if (d && (hayCambios(d) || d.anot.length > 0) && !(await confirmar({ titulo: `¿Cerrar «${P.nombreArchivo(ruta)}»?`, texto: "Tiene cambios sin guardar. Si lo cierras se descartarán.", ok: "Cerrar y descartar", peligro: true }))) return;
    const resto = docsRef.current.filter((x) => x.ruta !== ruta);
    setDocs(resto);
    if (activa === ruta) setActiva(resto.length ? resto[resto.length - 1].ruta : null);
  }

  // ── Organizar ────────────────────────────────────────────────
  function cambiar(f: (p: PagOrg[], sel: number[]) => { paginas: PagOrg[]; sel?: number[] }) {
    if (!doc) return;
    upd(doc.ruta, (d) => {
      const r = f(d.paginas, d.sel);
      return { ...d, paginas: r.paginas, sel: r.sel ?? d.sel, undo: [...d.undo, d.paginas], redo: [] };
    });
  }
  const deshacer = () => doc && doc.undo.length && upd(doc.ruta, (d) => ({ ...d, paginas: d.undo[d.undo.length - 1], undo: d.undo.slice(0, -1), redo: [...d.redo, d.paginas], sel: [] }));
  const rehacer = () => doc && doc.redo.length && upd(doc.ruta, (d) => ({ ...d, paginas: d.redo[d.redo.length - 1], redo: d.redo.slice(0, -1), undo: [...d.undo, d.paginas], sel: [] }));

  const rotar = (delta: number) => doc?.sel.length && cambiar((p, s) => ({ paginas: p.map((x) => (s.includes(x.id) ? { ...x, rot: (x.rot + delta + 360) % 360 } : x)) }));
  async function eliminar() {
    if (!doc?.sel.length) return;
    if (doc.sel.length >= doc.paginas.length) { avisar({ tipo: "info", titulo: "No se pueden eliminar todas las páginas" }); return; }
    if (doc.sel.length >= 3) {
      const nums = doc.paginas.map((x, i) => (doc.sel.includes(x.id) ? i + 1 : 0)).filter(Boolean);
      const lista = nums.length <= 6 ? nums.join(", ") : nums.slice(0, 5).join(", ") + "…";
      if (!(await confirmar({ titulo: `¿Eliminar ${doc.sel.length} páginas?`, texto: `Se quitarán las páginas ${lista} del documento. Podrás deshacerlo con Ctrl+Z hasta que guardes los cambios.`, ok: "Eliminar páginas", peligro: true }))) return;
    }
    cambiar((p, s) => ({ paginas: p.filter((x) => !s.includes(x.id)), sel: [] }));
  }
  function blanca() {
    cambiar((p, s) => {
      const nueva: PagOrg = { id: idBlanca++, origen: null, rot: 0 };
      const pos = s.length ? Math.max(...s.map((id) => p.findIndex((x) => x.id === id))) + 1 : p.length;
      return { paginas: [...p.slice(0, pos), nueva, ...p.slice(pos)], sel: [nueva.id] };
    });
  }
  function mover(dir: -1 | 1) {
    if (!doc?.sel.length) return;
    cambiar((p, s) => {
      const a = [...p];
      if (dir === -1) { for (let i = 1; i < a.length; i++) if (s.includes(a[i].id) && !s.includes(a[i - 1].id)) [a[i - 1], a[i]] = [a[i], a[i - 1]]; }
      else { for (let i = a.length - 2; i >= 0; i--) if (s.includes(a[i].id) && !s.includes(a[i + 1].id)) [a[i + 1], a[i]] = [a[i], a[i + 1]]; }
      return { paginas: a };
    });
  }
  function alExtremo(inicio: boolean) {
    if (!doc?.sel.length) return;
    cambiar((p, s) => {
      const elegidas = p.filter((x) => s.includes(x.id)), resto = p.filter((x) => !s.includes(x.id));
      return { paginas: inicio ? [...elegidas, ...resto] : [...resto, ...elegidas] };
    });
  }
  function duplicar() {
    if (!doc?.sel.length) return;
    const nuevas: number[] = [];
    cambiar((p, s) => ({
      paginas: p.flatMap((x) => {
        if (!s.includes(x.id)) return [x];
        const c: PagOrg = { ...x, id: idBlanca++ };
        nuevas.push(c.id);
        return [x, c];
      }),
      sel: s,
    }));
  }
  function seleccionar(modo: "pares" | "impares" | "invertir") {
    if (!doc) return;
    upd(doc.ruta, (d) => ({
      ...d,
      sel: d.paginas.filter((x, i) => modo === "pares" ? (i + 1) % 2 === 0 : modo === "impares" ? (i + 1) % 2 === 1 : !d.sel.includes(x.id)).map((x) => x.id),
    }));
  }
  // Selección con rectángulo: arrastra sobre el fondo de la cuadrícula (Ctrl/Mayús suma a la selección actual).
  const [marco, setMarco] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  function empezarMarco(e: React.PointerEvent) {
    if (e.button !== 0 || bloqueado || !doc) return;
    if ((e.target as HTMLElement).closest(".org-item")) return;
    const x0 = e.clientX, y0 = e.clientY;
    const ruta = doc.ruta;
    const base = e.ctrlKey || e.metaKey || e.shiftKey ? [...doc.sel] : [];
    let movido = false;
    const mover = (ev: PointerEvent) => {
      if (!movido && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      movido = true;
      const r = { x: Math.min(x0, ev.clientX), y: Math.min(y0, ev.clientY), w: Math.abs(ev.clientX - x0), h: Math.abs(ev.clientY - y0) };
      setMarco(r);
      const dentro: number[] = [];
      document.querySelectorAll<HTMLElement>(".org-grid .org-item").forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.right >= r.x && b.left <= r.x + r.w && b.bottom >= r.y && b.top <= r.y + r.h) {
          const d = docsRef.current.find((q) => q.ruta === ruta);
          const idx = Number(el.dataset.idx);
          const pg = d?.paginas[idx];
          if (pg) dentro.push(pg.id);
        }
      });
      upd(ruta, (d) => ({ ...d, sel: Array.from(new Set([...base, ...dentro])) }));
    };
    const fin = () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", fin);
      setMarco(null);
      if (!movido && base.length === 0) upd(ruta, (d) => ({ ...d, sel: [] }));
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", fin);
  }
  // Arrastre con eventos de puntero (el DnD HTML5 no funciona en Tauri/WebView2
  // porque el manejador nativo de arrastre de archivos lo intercepta).
  // Se puede soltar en la cuadrícula (reordenar / insertar copia) o sobre otra pestaña.
  type Arr = { ruta: string; paginas: PagOrg[]; x: number; y: number; activo: boolean; destino: number | null; tab: string | null; timer: number | null };
  const dragRef = useRef<Arr | null>(null);
  const evitarClic = useRef(false);
  const soltarRef = useRef<(a: Arr) => void>(() => {});
  soltarRef.current = (a) => {
    const dest = a.tab ?? activa;
    if (!dest) return;
    const hacia = docsRef.current.find((d) => d.ruta === dest);
    if (!hacia) return;
    setArrastrando(null); setDestino(null); setTabDestino(null); setFantasma(null);
    if (dest === a.ruta) {
      if (a.tab) return;
      const ids = a.paginas.map((x) => x.id);
      const indice = a.destino;
      if (indice === null) return;
      upd(dest, (d) => {
        const p = d.paginas;
        const movidas = p.filter((x) => ids.includes(x.id));
        const resto = p.filter((x) => !ids.includes(x.id));
        const antes = p.slice(0, indice).filter((x) => !ids.includes(x.id)).length;
        return { ...d, paginas: [...resto.slice(0, antes), ...movidas, ...resto.slice(antes)], undo: [...d.undo, d.paginas], redo: [] };
      });
      return;
    }
    // Otra pestaña: se COPIAN las páginas (el PDF de origen no se toca)
    const origen = docsRef.current.find((d) => d.ruta === a.ruta);
    const copias: PagOrg[] = a.paginas.map((x) => x.origen === null
      ? { id: idBlanca++, origen: null, rot: x.rot }
      : { id: idBlanca++, origen: x.origen, rot: x.rot, fuente: x.fuente ?? a.ruta,
          mini: x.fuente ? x.mini : origen?.minis[x.origen - 1] });
    const pos = a.tab ? hacia.paginas.length : Math.min(a.destino ?? hacia.paginas.length, hacia.paginas.length);
    upd(dest, (d) => ({ ...d, paginas: [...d.paginas.slice(0, pos), ...copias, ...d.paginas.slice(pos)],
      sel: copias.map((c) => c.id), modo: "organizar", undo: [...d.undo, d.paginas], redo: [] }));
    setActiva(dest);
    P.log("ok", `${copias.length} página(s) copiadas de ${P.nombreArchivo(a.ruta)} a ${P.nombreArchivo(dest)} (guarda una copia para aplicar)`);
  };
  function iniciarArrastre(e: React.PointerEvent, id: number, sel: boolean) {
    if (e.button !== 0 || bloqueado || !doc) return;
    const paginas = sel ? doc.paginas.filter((x) => doc.sel.includes(x.id)) : doc.paginas.filter((x) => x.id === id);
    dragRef.current = { ruta: doc.ruta, paginas, x: e.clientX, y: e.clientY, activo: false, destino: null, tab: null, timer: null };
    const limpiarTimer = (d: Arr) => { if (d.timer !== null) { window.clearTimeout(d.timer); d.timer = null; } };
    const mover = (ev: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      if (!d.activo) {
        if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 6) return;
        d.activo = true; setArrastrando(d.paginas.map((x) => x.id));
      }
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const tabEl = el?.closest("[data-tabruta]") as HTMLElement | null;
      const tab = tabEl?.dataset.tabruta ?? null;
      const txt = `${d.paginas.length} pág.` + (tab && tab !== d.ruta ? ` → ${P.nombreArchivo(tab)}` : "");
      setFantasma({ x: ev.clientX, y: ev.clientY, txt });
      if (tab !== d.tab) {
        limpiarTimer(d);
        d.tab = tab; setTabDestino(tab);
        // Al mantener sobre otra pestaña se abre, para elegir la posición exacta en su cuadrícula
        if (tab && tab !== activaRef.current) d.timer = window.setTimeout(() => { setActiva(tab); d.tab = null; setTabDestino(null); }, 700);
      }
      if (!tab) {
        const it = el?.closest("[data-idx]") as HTMLElement | null;
        if (it) {
          const r = it.getBoundingClientRect();
          let i = +(it.dataset.idx as string);
          if (!it.classList.contains("org-fin") && ev.clientX > r.left + r.width / 2) i += 1;
          d.destino = i; setDestino(i);
        }
      } else setDestino(null);
      const g = document.querySelector(".org-grid") as HTMLElement | null;
      if (g) {
        const r = g.getBoundingClientRect();
        if (ev.clientY > r.top && ev.clientY < r.top + 40) g.scrollTop -= 18;
        else if (ev.clientY < r.bottom && ev.clientY > r.bottom - 40) g.scrollTop += 18;
      }
    };
    const fin = () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", fin);
      window.removeEventListener("pointercancel", fin);
      const d = dragRef.current; dragRef.current = null;
      if (!d) return;
      limpiarTimer(d);
      if (d.activo) {
        evitarClic.current = true;
        setTimeout(() => { evitarClic.current = false; }, 0);
        if (d.tab || d.destino !== null) soltarRef.current(d);
        else { setArrastrando(null); setDestino(null); setTabDestino(null); setFantasma(null); }
      }
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", fin);
    window.addEventListener("pointercancel", fin);
  }
  function clicMini(e: React.MouseEvent, id: number, indice: number) {
    if (!doc) return;
    if (e.shiftKey && ancla.current !== null) {
      const [a, b] = [Math.min(ancla.current, indice), Math.max(ancla.current, indice)];
      upd(doc.ruta, (d) => ({ ...d, sel: d.paginas.slice(a, b + 1).map((x) => x.id) }));
    } else if (e.ctrlKey || e.metaKey) {
      upd(doc.ruta, (d) => ({ ...d, sel: d.sel.includes(id) ? d.sel.filter((x) => x !== id) : [...d.sel, id] }));
      ancla.current = indice;
    } else { upd(doc.ruta, (d) => ({ ...d, sel: [id] })); ancla.current = indice; }
  }
  function teclasOrg(e: React.KeyboardEvent) {
    if (!doc) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); deshacer(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); rehacer(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); upd(doc.ruta, (d) => ({ ...d, sel: d.paginas.map((x) => x.id) })); }
    else if (e.key === "Delete") { e.preventDefault(); eliminar(); }
    else if (e.key === "Escape") upd(doc.ruta, (d) => ({ ...d, sel: [] }));
  }

  async function recargar(viejo: string, nuevo: string) {
    const info = (await P.infoPdf([nuevo]))[nuevo];
    setDocs((p) => p.filter((d) => d.ruta !== nuevo).map((d) => d.ruta === viejo
      ? { ...d, ruta: nuevo, total: info?.paginas ?? d.total, minis: [], cargandoMinis: true, paginas: ident(info?.paginas ?? d.total), undo: [], redo: [], anot: [], sel: [], irA: null } : d));
    setBusquedas((b) => { const c = { ...b }; delete c[viejo]; return c; });
    setActiva(nuevo);
    cargarMinis(nuevo);
  }

  async function aplicarOrg() {
    if (!doc || !hayCambios(doc)) return;
    if (!await P.verificarProteccion([doc.ruta])) return;
    const salida = await P.rutaDisponible(P.rutaConSufijo(doc.ruta, "_editado"));
    if (!salida) return;
    setGuardando(true);
    P.log("info", `Aplicando cambios de páginas a ${P.nombreArchivo(doc.ruta)}`);
    try {
      await invoke("aplicar_organizacion", { entrada: doc.ruta, salida, paginas: doc.paginas.map((p) => ({ origen: p.origen, rot: p.rot, fuente: p.fuente ?? null })) });
      P.log("ok", `Generado: ${salida}`);
      P.historial("organizar", doc.ruta, salida);
      await recargar(doc.ruta, salida);
    } catch (e) { P.manejarError(e); }
    setGuardando(false);
  }

  async function guardarAnot() {
    if (!doc || doc.anot.length === 0) return;
    const salida = await P.rutaDisponible(P.rutaConSufijo(doc.ruta, "_anotado"));
    if (!salida) return;
    setGuardando(true);
    P.log("info", `Guardando ${doc.anot.length} anotación(es) en ${P.nombreArchivo(doc.ruta)}`);
    try {
      await invoke("guardar_anotaciones", { entrada: doc.ruta, salida, anotaciones: doc.anot });
      P.log("ok", `Generado: ${salida}`);
      P.historial("anotar", doc.ruta, salida);
      await recargar(doc.ruta, salida);
    } catch (e) { P.manejarError(e); }
    setGuardando(false);
  }

  async function buscar() {
    if (!doc || !consulta.trim()) return;
    const ruta = doc.ruta, q = consulta.trim();
    setPanelBusqueda(true);
    setBusquedas((b) => ({ ...b, [ruta]: { q, cargando: true, hayTexto: true, aciertos: [] } }));
    try {
      const r = await invoke<{ hay_texto: boolean; aciertos: Acierto[] }>("buscar_texto", { entrada: ruta, consulta: q });
      setBusquedas((b) => ({ ...b, [ruta]: { q, cargando: false, hayTexto: r.hay_texto, aciertos: r.aciertos } }));
    } catch (e) {
      setBusquedas((b) => ({ ...b, [ruta]: { q, cargando: false, hayTexto: true, aciertos: [], error: String(e) } }));
    }
  }
  function irAPagina(pagina: number) {
    if (!doc) return;
    upd(doc.ruta, (d) => ({ ...d, modo: "leer", irA: { pagina, n: Date.now() } }));
    setPanelBusqueda(false);
  }

  async function extraerSeleccion() {
    if (!doc || !doc.sel.length) return;
    const elegidas = doc.paginas.filter((p) => doc.sel.includes(p.id));
    if (!await P.verificarProteccion([doc.ruta])) return;
    const salida = await P.rutaDisponible(P.rutaConSufijo(doc.ruta, "_extracto"));
    if (!salida) return;
    setGuardando(true);
    try {
      await invoke("aplicar_organizacion", { entrada: doc.ruta, salida, paginas: elegidas.map((p) => ({ origen: p.origen, rot: p.rot, fuente: p.fuente ?? null })) });
      P.log("ok", `Extraídas ${elegidas.length} página(s): ${salida}`);
      P.abrirReciente(salida);
    } catch (e) { P.manejarError(e); }
    setGuardando(false);
  }

  const bloqueado = P.ocupado || guardando;

  // Miniaturas grandes: se regeneran con más resolución para que no se vean borrosas
  useEffect(() => {
    if (!doc || doc.modo !== "organizar" || doc.cargandoMinis) return;
    const quiere = tam > 160;
    if (quiere === !!doc.hires) return;
    const t = setTimeout(() => {
      upd(doc.ruta, (d) => ({ ...d, cargandoMinis: true }));
      cargarMinis(doc.ruta, doc.ruta, quiere ? 110 : 36);
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tam, doc?.ruta, doc?.modo, doc?.hires, doc?.cargandoMinis]);
  const busq = doc ? busquedas[doc.ruta] : undefined;

  useEffect(() => {
    P.alEstado?.(doc ? { ruta: doc.ruta, nombre: P.nombreArchivo(doc.ruta), paginas: doc.paginas.length, cambios: hayCambios(doc) || doc.anot.length > 0, modo: doc.modo } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.ruta, doc?.paginas.length, doc?.anot.length, doc?.modo, doc && hayCambios(doc)]);
  useEffect(() => {
    const f = (e: Event) => {
      const a = (e as CustomEvent<string>).detail;
      if (a === "cerrar" && activa) cerrar(activa);
      else if (a === "deshacer" && doc) deshacer();
      else if (a === "rehacer" && doc) rehacer();
      else if (a.startsWith("modo:")) irAModo(a.slice(5) as Modo);
    };
    window.addEventListener("pdftool-visor", f); return () => window.removeEventListener("pdftool-visor", f);
  });

  /** Páginas seleccionadas en Organizar, como rango del archivo guardado (sin las páginas en blanco ni las de otros PDF). */
  function rangoSeleccion(): string | undefined {
    if (!doc || doc.modo !== "organizar" || !doc.sel.length) return undefined;
    const nums = doc.paginas.filter((p) => doc.sel.includes(p.id) && p.origen != null && !p.fuente).map((p) => p.origen as number);
    return nums.length ? aRango(nums) : undefined;
  }

  // Ir a un modo (Anotar, Organizar…). Sin documento abierto, pide el PDF y entra en ese modo al abrirlo.
  function irAModo(m: Modo) {
    if (doc) { upd(doc.ruta, (d) => ({ ...d, modo: m })); return; }
    modoPendiente.current = m; P.abrirDialogo();
  }
  useEffect(() => {
    if (doc && modoPendiente.current) { const m = modoPendiente.current; modoPendiente.current = null; upd(doc.ruta, (d) => ({ ...d, modo: m })); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.ruta]);

  // ── Pantalla de inicio ───────────────────────────────────────
  if (!doc) {
    return (
      <div className="visor-ws">
        {docs.length > 0 && <TabBar tabDestino={tabDestino} docs={docs} activa={activa} setActiva={setActiva} cerrar={cerrar} abrir={P.abrirDialogo} nombre={P.nombreArchivo} />}
        <div className="inicio">
          <div className="inicio-hero">
            <h2>{saludo()}</h2>
            <p className="inicio-sub">¿Qué quieres hacer con tus PDF?</p>
            <div className="inicio-acciones">
              <button className="primario azul inicio-abrir" onClick={P.abrirDialogo} disabled={bloqueado}><I n="file" s={17} /> Abrir PDF…</button>
              <button className="secundario inicio-rapida" onClick={() => irAModo("anotar")} disabled={bloqueado}><I n="highlight" s={15} /> Anotar</button>
              <button className="secundario inicio-rapida" onClick={() => irAModo("organizar")} disabled={bloqueado}><I n="pages2" s={15} /> Organizar páginas</button>
            </div>
            <div className="inicio-ayuda">También puedes arrastrar archivos a la ventana · <kbd>Ctrl</kbd>+<kbd>K</kbd> busca cualquier herramienta</div>
          </div>
          {P.recientes.length > 0 && (
            <div className="inicio-recientes">
              <div className="inicio-recientes-cab"><span>Recientes</span><button onClick={P.borrarRecientes}>Borrar lista</button></div>
              <div className="inicio-recientes-lista">
                {P.recientes.map((r) => (
                  <button key={r} className="reciente" onClick={() => P.abrirReciente(r)} title={r}>
                    <span className="reciente-pdf">PDF</span><span className="reciente-nombre">{P.nombreArchivo(r)}</span>
                    <span className="reciente-ruta">{r.slice(0, Math.max(0, r.length - P.nombreArchivo(r).length - 1))}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="inicio-subtit">Herramientas</div>
          <div className="inicio-rejilla">
            {P.herramientas.map((h) => (
              <button key={h.id} className="inicio-tarjeta" onClick={() => P.irHerramienta(h.id)}>
                <span className="inicio-icono">{h.icono}</span>
                <span className="inicio-titulo">{h.etiqueta}</span>
                <span className="inicio-desc">{h.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const cambios = hayCambios(doc);
  const mw = Math.round(90 * tam / 100);


  return (
    <div className="visor-ws">
      {fantasma && <div className="arr-fantasma" style={{ left: fantasma.x + 14, top: fantasma.y + 14 }}>{fantasma.txt}</div>}
      <TabBar tabDestino={tabDestino} docs={docs} activa={activa} setActiva={setActiva} cerrar={cerrar} abrir={P.abrirDialogo} nombre={P.nombreArchivo} />

      <div className="ws-modos">
        <button className="ws-alternar-minis" onClick={alternarMinis} title="Mostrar u ocultar las miniaturas de página" aria-label="Mostrar u ocultar miniaturas"><I n="panel" s={16} /></button>
        {(["leer", "organizar", "anotar"] as Modo[]).map((m) => (
          <button key={m} className={doc.modo === m ? "on" : ""} onClick={() => upd(doc.ruta, (d) => ({ ...d, modo: m }))}>
            {m === "leer" ? "Leer" : m === "organizar" ? "Organizar páginas" : "Anotar"}
          </button>
        ))}
        <span className="visor-espacio" />
        {P.imprimir && <button className="ws-imprimir" onClick={() => P.imprimir!(doc.ruta, cambios || doc.anot.length > 0, rangoSeleccion())} disabled={bloqueado}
          title={rangoSeleccion() ? `Imprimir las páginas seleccionadas: ${rangoSeleccion()} (Ctrl+P)` : "Imprimir (Ctrl+P)"}><I n="printer" s={16} /> {rangoSeleccion() ? "Imprimir selección" : "Imprimir"}</button>}
        <form className="ws-buscar" onSubmit={(e) => { e.preventDefault(); buscar(); }}>
          <input value={consulta} onChange={(e) => setConsulta(e.target.value)} placeholder="Buscar texto en el documento…" onFocus={() => busq && setPanelBusqueda(true)} />
          <button type="submit" disabled={!consulta.trim() || busq?.cargando}>{busq?.cargando ? "…" : "Buscar"}</button>
        </form>
        {cambios && <span className="ws-aviso">Cambios de páginas sin aplicar</span>}
        {doc.modo === "anotar" && doc.anot.length > 0 && <span className="ws-aviso">{doc.anot.length} anotación(es) sin guardar</span>}
      </div>

      {panelBusqueda && busq && (
        <div className="busq-panel">
          <div className="busq-cab">
            <span>{busq.cargando ? "Buscando…" : busq.error ? "Error al buscar" : !busq.hayTexto ? "Sin resultados" : `${busq.aciertos.reduce((n, a) => n + a.cuenta, 0)} coincidencia(s) en ${busq.aciertos.length} página(s) para «${busq.q}»`}</span>
            <button onClick={() => setPanelBusqueda(false)} title="Cerrar">×</button>
          </div>
          {busq.error && <div className="busq-vacio">{busq.error}</div>}
          {!busq.cargando && !busq.error && !busq.hayTexto && <div className="busq-vacio">Este PDF no tiene texto seleccionable (probablemente es un escaneo). Pásalo antes por OCR para poder buscar en él.</div>}
          {!busq.cargando && busq.hayTexto && busq.aciertos.length === 0 && !busq.error && <div className="busq-vacio">No se ha encontrado «{busq.q}».</div>}
          <div className="busq-lista">
            {busq.aciertos.map((a) => (
              <button key={a.pagina} className="busq-item" onClick={() => irAPagina(a.pagina)}>
                <span className="busq-pag">Pág. {a.pagina}{a.cuenta > 1 ? ` (${a.cuenta})` : ""}</span>
                <span className="busq-frag">{a.fragmento}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {doc.modo === "leer" && (
        <VisorPdf ruta={doc.ruta} total={doc.total} modo="leer" minis={doc.minis} irA={doc.irA}
          marcadas={new Set((busq?.aciertos ?? []).map((a) => a.pagina))} deshabilitado />
      )}

      {doc.modo === "anotar" && (cambios ? (
        <div className="ws-bloqueo">
          <p>Hay cambios de páginas sin aplicar. Aplícalos primero para poder anotar sobre el resultado.</p>
          <button className="primario azul" onClick={aplicarOrg} disabled={bloqueado}>Aplicar cambios de páginas</button>
        </div>
      ) : (
        <>
          <AnotadorPdf ruta={doc.ruta} total={doc.total} minis={doc.minis} anotaciones={doc.anot} deshabilitado={bloqueado}
            setAnotaciones={(f) => upd(doc.ruta, (d) => ({ ...d, anot: f(d.anot) }))} />
          <div className="ws-pie">
            <button className="secundario" onClick={() => upd(doc.ruta, (d) => ({ ...d, anot: d.anot.slice(0, -1) }))} disabled={bloqueado || doc.anot.length === 0}>Deshacer última</button>
            <button className="primario azul" onClick={guardarAnot} disabled={bloqueado || doc.anot.length === 0}>
              Guardar copia anotada{doc.anot.length ? ` (${doc.anot.length})` : ""}
            </button>
          </div>
        </>
      ))}

      {doc.modo === "organizar" && (
        <div className="org" tabIndex={0} onKeyDown={teclasOrg}>
          <div className="org-barra">
            <button onClick={deshacer} disabled={!doc.undo.length || bloqueado} title="Deshacer (Ctrl+Z)"><I n="undo" /> Deshacer <kbd>Ctrl+Z</kbd></button>
            <button onClick={rehacer} disabled={!doc.redo.length || bloqueado} title="Rehacer (Ctrl+Y)"><I n="redo" /> Rehacer <kbd>Ctrl+Y</kbd></button>
            <span className="visor-sep" />
            <button onClick={() => rotar(-90)} disabled={!doc.sel.length || bloqueado} title="Rotar a la izquierda">⟲ Izq.</button>
            <button onClick={() => rotar(90)} disabled={!doc.sel.length || bloqueado} title="Rotar a la derecha">⟳ Der.</button>
            <button onClick={() => mover(-1)} disabled={!doc.sel.length || bloqueado} title="Mover antes"><I n="left" /> Mover</button>
            <button onClick={() => mover(1)} disabled={!doc.sel.length || bloqueado} title="Mover después">Mover <I n="right" /></button>
            <button onClick={() => alExtremo(true)} disabled={!doc.sel.length || bloqueado} title="Llevar la selección al principio">⤒ Al inicio</button>
            <button onClick={() => alExtremo(false)} disabled={!doc.sel.length || bloqueado} title="Llevar la selección al final">⤓ Al final</button>
            <button onClick={duplicar} disabled={!doc.sel.length || bloqueado} title="Duplicar las páginas seleccionadas (copia justo detrás de cada una)">⧉ Duplicar</button>
            <button onClick={blanca} disabled={bloqueado} title="Insertar página en blanco después de la selección (o al final)"><I n="plus" /> En blanco</button>
            <button className="peligro-suave" onClick={eliminar} disabled={!doc.sel.length || bloqueado} title="Eliminar (Supr)"><I n="trash" /> Eliminar <kbd>Supr</kbd></button>
            <button onClick={extraerSeleccion} disabled={!doc.sel.length || bloqueado} title="Guardar las páginas seleccionadas como un PDF nuevo">⤓ Extraer a PDF nuevo</button>
            <span className="visor-espacio" />
            <span className="org-sel-grupo" title="Selección rápida">
              <button onClick={() => upd(doc.ruta, (d) => ({ ...d, sel: d.paginas.map((x) => x.id) }))} disabled={bloqueado} title="Ctrl+A">Todo</button>
              <button onClick={() => seleccionar("impares")} disabled={bloqueado} title="Páginas 1, 3, 5…">Impares</button>
              <button onClick={() => seleccionar("pares")} disabled={bloqueado} title="Páginas 2, 4, 6…">Pares</button>
              <button onClick={() => seleccionar("invertir")} disabled={bloqueado} title="Invertir la selección">Invertir</button>
            </span>
            <label className="org-tam" title="Tamaño de miniaturas">
              <span className="tam-ico"><I n="imgsmall" s={12} /></span><input type="range" min={50} max={400} step={10} value={tam} onChange={(e) => setTam(+e.target.value)} /><span className="tam-ico"><I n="imgbig" s={16} /></span>
            </label>
          </div>

          <div className="org-grid" style={{ ["--mw" as string]: `${mw}px` }} onPointerDown={empezarMarco}>
            {doc.cargandoMinis && <div className="visor-vacio">Cargando miniaturas…</div>}
            {doc.paginas.map((p, i) => {
              const sel = doc.sel.includes(p.id);
              return (
                <div key={p.id}
                  className={`org-item${sel ? " sel" : ""}${destino === i ? " destino" : ""}${arrastrando?.includes(p.id) && !p.fuente ? " arrastrada" : ""}`}
                  data-idx={i}
                  onPointerDown={(e) => iniciarArrastre(e, p.id, sel)}
                  onClick={(e) => { if (evitarClic.current) return; setMenu(null); clicMini(e, p.id, i); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!doc.sel.includes(p.id)) upd(doc.ruta, (d) => ({ ...d, sel: [p.id] }));
                    setMenu({ x: e.clientX, y: e.clientY });
                  }}>
                  <div className="org-caja">
                    {p.origen === null
                      ? <div className="org-blanca">En blanco</div>
                      : (p.fuente ? p.mini : doc.minis[p.origen - 1])
                        ? <img src={(p.fuente ? p.mini : doc.minis[p.origen - 1]) as string} alt={`Página ${p.origen}`} draggable={false}
                            style={{ transform: `rotate(${p.rot}deg)${p.rot % 180 ? " scale(.72)" : ""}` }} />
                        : <div className="org-blanca">…</div>}
                  </div>
                  <span className="org-num">{i + 1}</span>
                  {p.rot !== 0 && <span className="org-rot">{p.rot}°</span>}
                  {p.fuente && <span className="org-orig" title={p.fuente}>{P.nombreArchivo(p.fuente)} · {p.origen}</span>}
                  {!p.fuente && p.origen !== null && p.origen !== i + 1 && <span className="org-orig">pág. {p.origen}</span>}
                </div>
              );
            })}
            <div className={`org-fin${destino === doc.paginas.length ? " destino" : ""}`} data-idx={doc.paginas.length} />
          </div>

          {marco && <div className="marco-seleccion" style={{ left: marco.x, top: marco.y, width: marco.w, height: marco.h }} />}
          {menu && (
            <>
              <div className="menu-fondo" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
              <div className="menu-ctx" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 250) }}>
                {([
                  ["⟲ Rotar a la izquierda", () => rotar(-90)],
                  ["⟳ Rotar a la derecha", () => rotar(90)],
                  ["⤒ Llevar al inicio", () => alExtremo(true)],
                  ["Mover antes", () => mover(-1)],
                  ["Mover después", () => mover(1)],
                  ["⤓ Llevar al final", () => alExtremo(false)],
                  ["⧉ Duplicar", duplicar],
                  ["Insertar página en blanco después", blanca],
                  ["⤓ Extraer a PDF nuevo", extraerSeleccion],
                  ...(P.imprimir && rangoSeleccion() ? [["Imprimir selección…", () => P.imprimir!(doc.ruta, cambios || doc.anot.length > 0, rangoSeleccion())]] : []),
                  ["Eliminar", eliminar],
                ] as [string, () => void][]).map(([t, f]) => (
                  <button key={t} className={t === "Eliminar" ? "peligro" : ""} onClick={() => { setMenu(null); f(); }}>{t}</button>
                ))}
              </div>
            </>
          )}

          <div className="ws-pie">
            <span className="ws-info">{doc.paginas.length} página(s){doc.sel.length ? ` · ${doc.sel.length} seleccionada(s)` : ""} · clic para seleccionar, Ctrl/Mayús para varias, arrastra sobre el fondo para seleccionar con rectángulo, arrastra una miniatura para mover; suéltalas sobre otra pestaña para copiarlas</span>
            <span className="visor-espacio" />
            <button className="secundario" onClick={() => upd(doc.ruta, (d) => ({ ...d, paginas: ident(d.total), undo: [], redo: [], sel: [] }))} disabled={!cambios || bloqueado}>Restablecer</button>
            <button className="primario azul" onClick={aplicarOrg} disabled={!cambios || bloqueado}>Guardar copia con los cambios</button>
          </div>
        </div>
      )}
    </div>
  );
}

function TabBar({ tabDestino, docs, activa, setActiva, cerrar, abrir, nombre }: {
  tabDestino: string | null; docs: Doc[]; activa: string | null; setActiva: (r: string) => void; cerrar: (r: string) => void; abrir: () => void; nombre: (r: string) => string;
}) {
  return (
    <div className="ws-tabs">
      {docs.map((d) => (
        <div key={d.ruta} data-tabruta={d.ruta} className={`ws-tab${d.ruta === activa ? " on" : ""}${d.ruta === tabDestino ? " destino" : ""}`} onClick={() => setActiva(d.ruta)} title={d.ruta}
          onAuxClick={(e) => { if (e.button === 1) cerrar(d.ruta); }}>
          <span className="ws-tab-nombre">{nombre(d.ruta)}</span>
          {(hayCambios(d) || d.anot.length > 0) && <span className="ws-tab-punto" title="Cambios sin guardar" />}
          <button className="ws-tab-x" onClick={(e) => { e.stopPropagation(); cerrar(d.ruta); }} title="Cerrar">×</button>
        </div>
      ))}
      <button className="ws-tab-mas" onClick={abrir} title="Abrir PDF" aria-label="Abrir PDF"><I n="plus" s={15} /></button>
    </div>
  );
}
