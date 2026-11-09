import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { I } from "./Icono";

export interface Anot {
  id: number;
  pagina: number;
  tipo: "texto" | "resaltado" | "tachar";
  x: number; y: number; w: number; h: number;   // fracciones de la página visible (desde arriba-izquierda)
  texto?: string;
  tam?: number;                                   // texto: alto de fuente como fracción del ancho
  color: [number, number, number];
}

interface Props {
  ruta: string;
  total: number;
  minis?: string[];
  anotaciones: Anot[];
  setAnotaciones: (f: (prev: Anot[]) => Anot[]) => void;
  deshabilitado?: boolean;
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const COL_TEXTO: [number, number, number][] = [[0, 0, 0], [0.85, 0.1, 0.1], [0.1, 0.25, 0.85], [0.1, 0.55, 0.2]];
const COL_RESALTADO: [number, number, number][] = [[1, 0.92, 0.2], [0.4, 1, 0.4], [1, 0.55, 0.8], [1, 0.65, 0.2], [0.55, 0.85, 1]];
const TAMS: [string, number][] = [["S", 0.015], ["M", 0.022], ["L", 0.032]];
type Herr = "texto" | "resaltado" | "seleccion" | "tachar";

const css = (c: [number, number, number]) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
let contador = 1;

export default function AnotadorPdf({ ruta, total, minis: minisExt, anotaciones, setAnotaciones, deshabilitado }: Props) {
  const [minisProp, setMinis] = useState<string[]>([]);
  const minis = minisExt ?? minisProp;
  const [actual, setActual] = useState(1);
  const [zi, setZi] = useState(2);
  const [img, setImg] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [herr, setHerr] = useState<Herr>("resaltado");
  const [colTexto, setColTexto] = useState(0);
  const [colRes, setColRes] = useState(0);
  const [tam, setTam] = useState(1);
  const [seleccionada, setSeleccionada] = useState<number | null>(null);
  const [arrastre, setArrastre] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [editando, setEditando] = useState<{ id: number | null; x: number; y: number; texto: string; tam: number; color: [number, number, number] } | null>(null);
  const hojaRef = useRef<HTMLDivElement | null>(null);
  const capaRef = useRef<HTMLDivElement | null>(null);

  // Solo importa si las miniaturas vienen de fuera o no, no su contenido: así no se recargan en cada render.
  const hayMinisExt = !!minisExt;
  useEffect(() => {
    if (hayMinisExt) { setActual(1); setImg(null); setError(null); setSeleccionada(null); setEditando(null); return; }
    let vivo = true;
    setMinis([]); setActual(1); setImg(null); setError(null); setSeleccionada(null); setEditando(null);
    invoke<string[]>("miniaturas_visor", { entrada: ruta, dpi: 36 })
      .then((m) => { if (vivo) setMinis(m); })
      .catch((e) => { if (vivo) setError(String(e)); });
    return () => { vivo = false; };
  }, [ruta, hayMinisExt]);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    const t = setTimeout(() => {
      invoke<string>("renderizar_pagina", { entrada: ruta, pagina: actual, dpi: Math.round(80 * ZOOMS[zi]) })
        .then((d) => { if (vivo) { setImg(d); setError(null); } })
        .catch((e) => { if (vivo) setError(String(e)); })
        .finally(() => { if (vivo) setCargando(false); });
    }, 140);
    return () => { vivo = false; clearTimeout(t); };
  }, [ruta, actual, zi]);

  const ir = (n: number) => { setActual(Math.min(total, Math.max(1, n))); setSeleccionada(null); setEditando(null); };
  const delPagina = anotaciones.filter((a) => a.pagina === actual);

  function frac(e: React.MouseEvent) {
    const r = capaRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  }

  function alPulsar(e: React.MouseEvent) {
    if (deshabilitado || editando) return;
    if (e.target !== capaRef.current) return;       // clic sobre una anotación lo gestiona la propia anotación
    const p = frac(e);
    if (herr === "resaltado" || herr === "tachar") setArrastre({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    else if (herr === "texto") { e.preventDefault(); setEditando({ id: null, x: p.x, y: p.y, texto: "", tam: TAMS[tam][1], color: COL_TEXTO[colTexto] }); }
    else setSeleccionada(null);
  }
  function alMover(e: React.MouseEvent) { if (arrastre) { const p = frac(e); setArrastre({ ...arrastre, x1: p.x, y1: p.y }); } }
  function alSoltar() {
    if (!arrastre) return;
    const x = Math.min(arrastre.x0, arrastre.x1), y = Math.min(arrastre.y0, arrastre.y1);
    const w = Math.abs(arrastre.x1 - arrastre.x0), h = Math.abs(arrastre.y1 - arrastre.y0);
    setArrastre(null);
    if (w < 0.008 || h < 0.004) return;
    setAnotaciones((p) => [...p, { id: contador++, pagina: actual, tipo: herr === "tachar" ? "tachar" : "resaltado", x, y, w, h, color: herr === "tachar" ? [0, 0, 0] : COL_RESALTADO[colRes] }]);
  }

  function confirmarTexto() {
    if (!editando) return;
    const t = editando.texto.trim();
    if (t) {
      if (editando.id !== null) setAnotaciones((p) => p.map((a) => a.id === editando.id ? { ...a, texto: editando.texto } : a));
      else setAnotaciones((p) => [...p, { id: contador++, pagina: actual, tipo: "texto", x: editando.x, y: editando.y, w: 0, h: 0, texto: editando.texto, tam: editando.tam, color: editando.color }]);
    } else if (editando.id !== null) {
      setAnotaciones((p) => p.filter((a) => a.id !== editando.id));
    }
    setEditando(null);
  }

  function borrarSeleccionada() {
    if (seleccionada === null) return;
    setAnotaciones((p) => p.filter((a) => a.id !== seleccionada));
    setSeleccionada(null);
  }

  function teclas(e: React.KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); borrarSeleccionada(); }
    else if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); ir(actual + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); ir(actual - 1); }
  }

  const cursor = herr === "resaltado" || herr === "tachar" ? "crosshair" : herr === "texto" ? "text" : "default";
  const colores = herr === "texto" ? COL_TEXTO : COL_RESALTADO;
  const colIdx = herr === "texto" ? colTexto : colRes;

  return (
    <div className="visor anotador" tabIndex={0} onKeyDown={teclas}>
      <div className="visor-minis">
        {minis.map((m, i) => {
          const n = i + 1;
          const cuenta = anotaciones.filter((a) => a.pagina === n).length;
          return (
            <button key={n} className={`visor-mini${n === actual ? " actual" : ""}`} onClick={() => ir(n)}>
              <img src={m} alt={`Página ${n}`} draggable={false} />
              <span className="visor-num">{n}</span>
              {cuenta > 0 && <span className="visor-marca">{cuenta}</span>}
            </button>
          );
        })}
      </div>

      <div className="visor-principal">
        <div className="visor-barra">
          <div className="grupo-herr">
            <button className={herr === "resaltado" ? "on" : ""} onClick={() => { setHerr("resaltado"); setSeleccionada(null); }} title="Resaltar: arrastra sobre el texto"><I n="highlight" /> Resaltar</button>
            <button className={herr === "tachar" ? "on" : ""} onClick={() => { setHerr("tachar"); setSeleccionada(null); }} title="Tachar de verdad: arrastra sobre lo que quieres eliminar. La página se convierte en imagen y el texto tapado desaparece"><I n="shield" /> Tachar</button>
            <button className={herr === "texto" ? "on" : ""} onClick={() => { setHerr("texto"); setSeleccionada(null); }} title="Texto: clic donde escribir">T Texto</button>
            <button className={herr === "seleccion" ? "on" : ""} onClick={() => setHerr("seleccion")} title="Seleccionar / editar / borrar"><I n="pointer" /> Seleccionar</button>
          </div>
          {herr !== "seleccion" && herr !== "tachar" && (
            <div className="colores">
              {colores.map((c, i) => (
                <button key={i} className={`color${i === colIdx ? " on" : ""}`} style={{ background: css(c) }}
                  onClick={() => (herr === "texto" ? setColTexto(i) : setColRes(i))} title="Color" />
              ))}
            </div>
          )}
          {herr === "texto" && (
            <div className="grupo-herr">
              {TAMS.map(([n], i) => <button key={n} className={i === tam ? "on" : ""} onClick={() => setTam(i)} title="Tamaño de letra">{n}</button>)}
            </div>
          )}
          {herr === "seleccion" && (
            <button onClick={borrarSeleccionada} disabled={seleccionada === null} title="Borrar la anotación seleccionada (Supr)"><I n="trash" /> Borrar</button>
          )}
          <span className="visor-espacio" />
          <div className="nav-visor">
          <button onClick={() => ir(actual - 1)} disabled={actual <= 1} aria-label="Página anterior"><I n="left" /></button>
          <span className="visor-pag">
            <input type="number" min={1} max={total} value={actual}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) ir(v); }} /> / {total}
          </span>
          <button onClick={() => ir(actual + 1)} disabled={actual >= total} aria-label="Página siguiente"><I n="right" /></button>
          <span className="visor-sep" />
          <button onClick={() => setZi((z) => Math.max(0, z - 1))} disabled={zi === 0}>−</button>
          <span className="visor-zoom">{Math.round(ZOOMS[zi] * 100)}%</span>
          <button onClick={() => setZi((z) => Math.min(ZOOMS.length - 1, z + 1))} disabled={zi === ZOOMS.length - 1}>+</button>
          </div>
        </div>

        <div className="visor-hoja" ref={hojaRef}>
          {error && <div className="visor-error">{error}</div>}
          {!img && !error && <div className="visor-vacio">Dibujando página…</div>}
          {img && (
            <div className={`anot-pagina${cargando ? " cargando" : ""}`}>
              <img src={img} alt={`Página ${actual}`} draggable={false} />
              <div className="anot-capa" ref={capaRef} style={{ cursor }}
                onMouseDown={alPulsar} onMouseMove={alMover} onMouseUp={alSoltar} onMouseLeave={alSoltar}>
                {delPagina.map((a) => a.tipo === "resaltado" || a.tipo === "tachar" ? (
                  <div key={a.id} className={`anot-res${a.tipo === "tachar" ? " tachar" : ""}${seleccionada === a.id ? " sel" : ""}`}
                    style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${a.w * 100}%`, height: `${a.h * 100}%`, background: css(a.color), pointerEvents: herr === "seleccion" ? "auto" : "none" }}
                    onMouseDown={(e) => { if (herr === "seleccion") { e.stopPropagation(); setSeleccionada(a.id); } }} />
                ) : (editando?.id === a.id ? null : (
                  <div key={a.id} className={`anot-txt${seleccionada === a.id ? " sel" : ""}`}
                    style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%`, fontSize: `${(a.tam ?? 0.02) * 100}cqw`, color: css(a.color), pointerEvents: herr === "seleccion" ? "auto" : "none" }}
                    onMouseDown={(e) => { if (herr === "seleccion") { e.stopPropagation(); setSeleccionada(a.id); } }}
                    onDoubleClick={() => { if (herr === "seleccion") setEditando({ id: a.id, x: a.x, y: a.y, texto: a.texto ?? "", tam: a.tam ?? 0.02, color: a.color }); }}>
                    {a.texto}
                  </div>
                )))}
                {arrastre && (
                  <div className="anot-res" style={{
                    left: `${Math.min(arrastre.x0, arrastre.x1) * 100}%`, top: `${Math.min(arrastre.y0, arrastre.y1) * 100}%`,
                    width: `${Math.abs(arrastre.x1 - arrastre.x0) * 100}%`, height: `${Math.abs(arrastre.y1 - arrastre.y0) * 100}%`,
                    background: herr === "tachar" ? "rgba(0,0,0,.75)" : css(COL_RESALTADO[colRes]), pointerEvents: "none" }} />
                )}
                {editando && (
                  <textarea autoFocus className="anot-edit"
                    style={{ left: `${editando.x * 100}%`, top: `${editando.y * 100}%`, fontSize: `${editando.tam * 100}cqw`, color: css(editando.color) }}
                    value={editando.texto} placeholder="Escribe…"
                    onChange={(e) => setEditando({ ...editando, texto: e.target.value })}
                    onBlur={confirmarTexto}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Escape") setEditando(null);
                      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); confirmarTexto(); }
                    }}
                    rows={Math.max(1, editando.texto.split("\n").length)} />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
