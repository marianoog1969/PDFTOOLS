// Piezas comunes de las herramientas de la zona de trabajo (Combinar, Extraer, Dividir, Comprimir, OCR, Imágenes, Office).
// Cada herramienta guarda su propio estado; lo que comparten con la ventana principal (diálogos, registro,
// resultado, barra de progreso) les llega a través de `CtxHerramientas`.
import { useEffect, useRef, type ReactNode } from "react";
import { I } from "../Icono";

export type EstadoTarjeta = "inactivo" | "procesando" | "hecho" | "error";
export type EstadoItem = "pendiente" | "procesando" | "hecho" | "error";
export type Zona = "marca" | "metadatos" | "formulario" | "lotes" | "combinar" | "comprimir" | "ocr" | "extraer" | "imagenes" | "dividir" | "office" | "visor";
export type ZonaTrabajo = "combinar" | "extraer" | "dividir" | "comprimir" | "ocr" | "imagenes" | "office";

export interface ItemCola { ruta: string; estado: EstadoItem; mensaje?: string; }
export interface Progreso { actual: number; total: number; }
export interface InfoPdf { paginas: number; protegido: boolean; corrupto: boolean; error?: string; tamano_bytes: number; }
export interface ResultadoValidacion { ruta: string; ok: boolean; protegido: boolean; corrupto: boolean; error?: string; }
export interface HistorialItem {
  id: string;
  operacion: "combinar" | "comprimir" | "ocr" | "extraer" | "imagenes" | "office" | "dividir" | "organizar" | "anotar" | "firmar";
  archivos: string[];
  resultado: string;
  fecha: string;
  ok: boolean;
}

/** Lo que cada herramienta cuenta a la ventana principal (menú lateral, barra de progreso, aviso al cerrar). */
export interface EstadoZona {
  procesando: boolean;
  /** archivos en espera (contador del menú lateral) */
  pendientes: number;
  /** 0..1 si se conoce el avance */
  fraccion: number | null;
  /** texto de la barra de progreso */
  etiqueta?: string;
}
export const ESTADO_ZONA_VACIO: EstadoZona = { procesando: false, pendientes: 0, fraccion: null };

export interface CtxHerramientas {
  /** Hay alguna operación en marcha en cualquier herramienta */
  ocupado: boolean;
  /** Zona sobre la que se arrastran archivos ahora mismo */
  zonaArrastre: Zona | null;
  herramienta: Zona;
  registrar: (tipo: "info" | "ok" | "err", texto: string) => void;
  infosPdf: Record<string, InfoPdf>;
  cargandoInfos: Set<string>;
  cargarInfoPdf: (rutas: string[]) => Promise<Record<string, InfoPdf>>;
  verificarProteccion: (rutas: string[]) => Promise<boolean>;
  /** Pregunta qué hacer si ya existe; null = cancelado */
  rutaDisponible: (base: string) => Promise<string | null>;
  /** Comprueba si otro programa tiene abiertos los archivos y ofrece cerrarlo */
  comprobarYDesbloquear: (rutas: string[]) => Promise<boolean>;
  manejarError: (e: unknown) => void;
  limpiarCancelacion: () => Promise<void>;
  /** Un resultado: tarjeta «Listo» + recientes */
  abrirResultado: (ruta: string) => void;
  /** Varios resultados: tarjeta con el último + abre la carpeta */
  resultadosVarios: (ultima: string) => void;
  guardarEnHistorial: (item: Omit<HistorialItem, "id" | "fecha">) => void;
  setResumen: (r: { ok: number; error: number } | null) => void;
  /** Tras combinar: ofrecer «Borrar originales» */
  ofrecerBorrarOriginales: (salida: string, rutas: string[]) => void;
  reportar: (zona: ZonaTrabajo, e: EstadoZona) => void;
}

export interface PropsZona { ctx: CtxHerramientas; }

export function textoEstado(e: EstadoTarjeta): string { return { inactivo: "", procesando: "Procesando", hecho: "Listo", error: "Error" }[e]; }

/** Clase de la tarjeta según esté visible, recibiendo archivos o trabajando. */
export function claseTarjeta(ctx: CtxHerramientas, zona: Zona, tieneContenido: boolean, activa: boolean, extra = ""): string {
  return `tarjeta${ctx.herramienta !== zona ? " oculta" : ""}${ctx.zonaArrastre === zona ? " arrastrando" : ""}${tieneContenido ? " con-contenido" : ""}${activa ? " tarjeta-activa" : ""}${extra ? " " + extra : ""}`;
}

/** Recibe los archivos soltados (o enviados desde la cola) para una zona. */
export function useSoltar(zona: Zona, alRecibir: (rutas: string[]) => void) {
  useEffect(() => {
    const f = (e: Event) => { const d = (e as CustomEvent<{ zona: string; rutas: string[] }>).detail; if (d.zona === zona && d.rutas.length) alRecibir(d.rutas); };
    window.addEventListener("pdftool-soltar", f);
    return () => window.removeEventListener("pdftool-soltar", f);
  });
}

/** Informa a la ventana principal cada vez que cambia el estado de la herramienta. */
export function useReportar(ctx: CtxHerramientas, zona: ZonaTrabajo, e: EstadoZona) {
  const { procesando, pendientes, fraccion, etiqueta } = e;
  useEffect(() => { ctx.reportar(zona, { procesando, pendientes, fraccion, etiqueta }); },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx cambia en cada render; solo importan los valores
    [zona, procesando, pendientes, fraccion, etiqueta]);
}

export function CabeceraTarjeta({ icono, color, titulo, desc, estado, textoEstadoExtra }: { icono: ReactNode; color: string; titulo: string; desc: string; estado: EstadoTarjeta; textoEstadoExtra?: string }) {
  return (
    <div className="cabecera-tarjeta">
      <span className={`icono ${color}`}>{icono}</span>
      <div className="cab-texto">
        <h3>{titulo}</h3>
        <div className="cab-desc">{desc}</div>
      </div>
      {estado !== "inactivo" && <span className={`estado ${estado}`}><span className="estado-dot" />{textoEstadoExtra ?? textoEstado(estado)}</span>}
    </div>
  );
}

export function ZonaSoltar({ icono, titulo, formatos, boton, alPulsar, deshabilitado }: { icono: ReactNode; titulo: string; formatos: string; boton: string; alPulsar: () => void; deshabilitado: boolean }) {
  return (
    <div className="zona-soltar">
      <span className="zona-icono">{icono}</span>
      <span className="zona-titulo">{titulo}</span>
      <span className="zona-formatos">{formatos}</span>
      <span className="o">o</span>
      <button onClick={alPulsar} disabled={deshabilitado}>{boton}</button>
    </div>
  );
}

/** Botones ↑ ↓ para reordenar una lista sin arrastrar. */
export function MoverOrden({ i, n, mover, deshabilitado }: { i: number; n: number; mover: (de: number, a: number) => void; deshabilitado: boolean }) {
  return (
    <span className="mover-orden">
      <button title="Subir" aria-label="Subir" onClick={() => mover(i, i - 1)} disabled={deshabilitado || i === 0}>↑</button>
      <button title="Bajar" aria-label="Bajar" onClick={() => mover(i, i + 1)} disabled={deshabilitado || i === n - 1}>↓</button>
    </span>
  );
}

export function Candado() { return <span className="candado"><I n="lock" s={12} /></span>; }

/** Añade rutas a una cola sin repetir. */
export function agregarAColaUnica(prev: ItemCola[], rutas: string[]): { cola: ItemCola[]; duplicados: string[] } {
  const existentes = new Set(prev.map((it) => it.ruta));
  const nuevos = rutas.filter((r) => !existentes.has(r));
  const duplicados = rutas.filter((r) => existentes.has(r));
  return { cola: [...prev, ...nuevos.map((r): ItemCola => ({ ruta: r, estado: "pendiente" }))], duplicados };
}

/** Lista de archivos en cola (Comprimir, OCR): reordenable mientras están pendientes. */
export function ListaCola({ cola, setCola, ocupado, detalle }: {
  cola: ItemCola[];
  setCola: (f: (p: ItemCola[]) => ItemCola[]) => void;
  ocupado: boolean;
  /** Texto a la derecha del nombre (mensaje, tamaño, progreso…) */
  detalle: (it: ItemCola, i: number) => ReactNode;
}) {
  const arrastre = useRef<number | null>(null);
  const mover = (de: number, a: number) => setCola((p) => (a < 0 || a >= p.length ? p : (() => { const c = [...p]; const [x] = c.splice(de, 1); c.splice(a, 0, x); return c; })()));
  return (
    <ul className="lista-archivos">
      {cola.map((item, i) => (
        <li key={`${item.ruta}-${i}`} className={`item-${item.estado}`} draggable={item.estado === "pendiente"}
          onDragStart={() => { arrastre.current = i; }} onDragOver={(e) => e.preventDefault()}
          onDrop={() => { const o = arrastre.current; arrastre.current = null; if (o !== null && o !== i) mover(o, i); }}>
          {item.estado === "pendiente" && <span className="asa">⠿</span>}
          <span className="nombre" title={item.ruta}>{item.ruta.split(/[\\/]/).pop()}</span>
          {detalle(item, i)}
          {item.estado === "pendiente" && <MoverOrden i={i} n={cola.length} mover={mover} deshabilitado={ocupado} />}
          <button className="quitar" onClick={() => setCola((p) => p.filter((_, j) => j !== i))} disabled={ocupado} aria-label="Quitar">×</button>
        </li>
      ))}
    </ul>
  );
}
