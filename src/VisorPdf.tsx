import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { I } from "./Icono";

interface Props {
  ruta: string;
  total: number;
  modo: "extraer" | "dividir" | "leer";
  minis?: string[];               // si se pasan, no se vuelven a generar
  marcadas: Set<number>;          // extraer: páginas elegidas · dividir: páginas donde empieza una parte nueva
  onToggle?: (pagina: number) => void;
  deshabilitado?: boolean;
  irA?: { pagina: number; n: number } | null;   // navegación desde fuera (p. ej. resultados de búsqueda)
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5];
// Índice del siguiente nivel de zoom por encima / por debajo del zoom efectivo actual
function siguienteZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) { const i = ZOOMS.findIndex((v) => v > z + 0.01); return i === -1 ? ZOOMS.length - 1 : i; }
  for (let i = ZOOMS.length - 1; i >= 0; i--) if (ZOOMS[i] < z - 0.01) return i;
  return 0;
}

export default function VisorPdf({ ruta, total, modo, minis: minisExt, marcadas, onToggle = () => {}, deshabilitado, irA }: Props) {
  const [minisProp, setMinis] = useState<string[]>([]);
  const minis = minisExt ?? minisProp;
  const [cargandoMinis, setCargandoMinis] = useState(false);
  const [actual, setActual] = useState(1);
  const [zi, setZi] = useState(1);
  const [img, setImg] = useState<string | null>(null);
  const [img2, setImg2] = useState<string | null>(null);
  const [ajuste, setAjuste] = useState<"manual" | "ancho" | "pagina">("manual");
  const [dos, setDos] = useState(false);
  const [caja, setCaja] = useState({ w: 800, h: 600 });
  const [pts, setPts] = useState({ w: 595, h: 842 }); // tamaño de página en puntos (se calcula de la imagen)
  const hojaRef = useRef<HTMLDivElement | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activaRef = useRef<HTMLButtonElement | null>(null);

  // Miniaturas: una sola llamada por archivo
  useEffect(() => {
    if (minisExt) { setActual(1); setImg(null); setError(null); return; }
    let vivo = true;
    setMinis([]); setActual(1); setImg(null); setError(null); setCargandoMinis(true);
    invoke<string[]>("miniaturas_visor", { entrada: ruta, dpi: 36 })
      .then((m) => { if (vivo) setMinis(m); })
      .catch((e) => { if (vivo) setError(String(e)); })
      .finally(() => { if (vivo) setCargandoMinis(false); });
    return () => { vivo = false; };
  }, [ruta, !!minisExt]);

  // Tamaño disponible de la hoja (para «ajustar a ancho / página»)
  useEffect(() => {
    const el = hojaRef.current; if (!el) return;
    const medir = () => setCaja({ w: Math.max(200, el.clientWidth - 40), h: Math.max(200, el.clientHeight - 40) });
    medir();
    const ro = new ResizeObserver(medir); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dosPag = dos && modo === "leer";
  const dpiAncho = (caja.w - (dosPag ? 16 : 0)) * 72 / (pts.w * (dosPag ? 2 : 1));
  const dpiPagina = Math.min(dpiAncho, caja.h * 72 / pts.h);
  const dpi = Math.max(30, Math.min(300, Math.round(ajuste === "ancho" ? dpiAncho : ajuste === "pagina" ? dpiPagina : 80 * ZOOMS[zi])));
  const zoomEf = dpi / 80;
  const base = dosPag && actual % 2 === 0 ? actual - 1 : actual; // en vista doble la hoja izquierda es impar
  const izq = dosPag ? base : actual;
  const der = dosPag && izq + 1 <= total ? izq + 1 : null;

  // Página grande: con un pequeño retardo para no lanzar Ghostscript en cada clic de zoom/navegación rápida
  useEffect(() => {
    let vivo = true;
    setCargando(true);
    const t = setTimeout(() => {
      const a = invoke<string>("renderizar_pagina", { entrada: ruta, pagina: izq, dpi })
        .then((d) => { if (vivo) { setImg(d); setError(null); } });
      const b = der ? invoke<string>("renderizar_pagina", { entrada: ruta, pagina: der, dpi })
        .then((d) => { if (vivo) setImg2(d); }) : Promise.resolve(setImg2(null));
      Promise.all([a, b])
        .catch((e) => { if (vivo) setError(String(e)); })
        .finally(() => { if (vivo) setCargando(false); });
    }, 140);
    return () => { vivo = false; clearTimeout(t); };
  }, [ruta, izq, der, dpi]);

  useEffect(() => { activaRef.current?.scrollIntoView({ block: "nearest" }); }, [actual]);

  useEffect(() => { if (irA) setActual(Math.min(total, Math.max(1, irA.pagina))); }, [irA?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // Al cargar la imagen se conoce el tamaño real de la página en puntos
  function alCargar(e: React.SyntheticEvent<HTMLImageElement>) {
    const i = e.currentTarget;
    if (!i.naturalWidth) return;
    const w = i.naturalWidth * 72 / dpi, h = i.naturalHeight * 72 / dpi;
    setPts((p) => (Math.abs(p.w - w) > 2 || Math.abs(p.h - h) > 2 ? { w, h } : p));
  }
  const paso = dosPag ? 2 : 1;
  const ir = (n: number) => setActual(Math.min(total, Math.max(1, n)));
  const marcada = marcadas.has(actual);

  function teclas(e: React.KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); ir(actual + paso); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); ir(actual - paso); }
    else if (e.key === " " && !deshabilitado) { e.preventDefault(); if (modo === "extraer" || actual > 1) onToggle(actual); }
  }

  const textoBoton = modo === "extraer"
    ? (marcada ? "Página seleccionada" : "Seleccionar esta página")
    : (actual === 1 ? "La primera página no se puede cortar" : marcada ? "Quitar corte antes de esta página" : "Cortar antes de esta página");

  return (
    <div className="visor" tabIndex={0} onKeyDown={teclas}>
      <div className="visor-minis">
        {(cargandoMinis && !minisExt) && <div className="visor-vacio">Cargando…</div>}
        {minis.map((m, i) => {
          const n = i + 1;
          const sel = marcadas.has(n);
          return (
            <button
              key={n}
              ref={n === actual ? activaRef : null}
              className={`visor-mini${n === actual ? " actual" : ""}${sel ? (modo === "extraer" ? " sel" : modo === "leer" ? " acierto" : " corte") : ""}`}
              onClick={() => ir(n)}
              onDoubleClick={() => { if (!deshabilitado && (modo === "extraer" || n > 1)) onToggle(n); }}
              title={modo === "extraer" ? "Clic: ver · Doble clic: seleccionar" : "Clic: ver · Doble clic: cortar antes de esta página"}
            >
              <img src={m} alt={`Página ${n}`} draggable={false} />
              <span className="visor-num">{n}</span>
              {sel && modo === "extraer" && <span className="visor-marca"><I n="check" s={12} /></span>}
              {sel && modo === "dividir" && <span className="visor-tijera"><I n="scissors" s={13} /></span>}
              {sel && modo === "leer" && <span className="visor-marca acierto-marca" />}
            </button>
          );
        })}
      </div>

      <div className="visor-principal">
        <div className="visor-barra">
          <button onClick={() => ir(actual - paso)} disabled={actual <= 1} title="Página anterior" aria-label="Página anterior"><I n="left" /></button>
          <span className="visor-pag">
            <input
              type="number" min={1} max={total} value={actual}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) ir(v); }}
            /> / {total}
          </span>
          <button onClick={() => ir(actual + paso)} disabled={actual >= total} title="Página siguiente" aria-label="Página siguiente"><I n="right" /></button>
          <span className="visor-sep" />
          <button onClick={() => { setZi(Math.max(0, siguienteZoom(zoomEf, -1))); setAjuste("manual"); }} disabled={ajuste === "manual" && zi === 0} title="Alejar">−</button>
          <span className="visor-zoom">{Math.round(zoomEf * 100)}%</span>
          <button onClick={() => { setZi(Math.min(ZOOMS.length - 1, siguienteZoom(zoomEf, 1))); setAjuste("manual"); }} disabled={ajuste === "manual" && zi === ZOOMS.length - 1} title="Acercar">+</button>
          <button className={ajuste === "ancho" ? "on" : ""} onClick={() => setAjuste(ajuste === "ancho" ? "manual" : "ancho")} title="Ajustar al ancho de la ventana"><I n="fit" /> Ancho</button>
          <button className={ajuste === "pagina" ? "on" : ""} onClick={() => setAjuste(ajuste === "pagina" ? "manual" : "pagina")} title="Ver la página completa">⤢ Página</button>
          {modo === "leer" && <button className={dos ? "on" : ""} onClick={() => setDos(!dos)} title="Ver dos páginas enfrentadas"><I n="pages2" /> Dos páginas</button>}
          <span className="visor-espacio" />
          {modo !== "leer" && <button
            className={`visor-accion${marcada ? " activa" : ""}`}
            onClick={() => onToggle(actual)}
            disabled={deshabilitado || (modo === "dividir" && actual === 1)}
          >{textoBoton}</button>}
        </div>
        <div className={`visor-hoja${dosPag ? " dos" : ""}`} ref={hojaRef}>
          {error && <div className="visor-error">{error}</div>}
          {img && <img src={img} alt={`Página ${izq}`} className={cargando ? "cargando" : ""} draggable={false} onLoad={alCargar} />}
          {dosPag && img2 && <img src={img2} alt={`Página ${der}`} className={cargando ? "cargando" : ""} draggable={false} />}
          {!img && !error && <div className="visor-vacio">Dibujando página…</div>}
        </div>
      </div>
    </div>
  );
}
