import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { I } from "./Icono";
import { PropsHerramienta, hexARgb, leerLS, guardarLS, nombreArchivo, rutaSalida } from "./util";

const CLAVE = "pdftool_marca_cfg";
const CFG0 = {
  marcaOn: true, texto: "CONFIDENCIAL", tam: 64, opacidad: 0.25, color: "#cc0000", angulo: 45,
  numOn: true, formato: "Página {n} de {total}", posicion: "pie-derecha", tamNum: 10, inicio: 1, paginas: "todas",
};
type Cfg = typeof CFG0;

export function construirDecorado(c: Cfg) {
  return {
    marca: c.marcaOn && c.texto.trim() ? { texto: c.texto, tam: c.tam, opacidad: c.opacidad, color: hexARgb(c.color), angulo: c.angulo } : null,
    numeracion: c.numOn ? { formato: c.formato, posicion: c.posicion, tam: c.tamNum, inicio: c.inicio, color: [0, 0, 0] } : null,
    paginas: c.paginas.trim() || "todas",
  };
}

export default function MarcaPdf({ alGenerar, registrar, zona }: PropsHerramienta) {
  const [cfg, setCfg] = useState<Cfg>(() => leerLS(CLAVE, CFG0));
  const [archivos, setArchivos] = useState<string[]>([]);
  const [vista, setVista] = useState<string | null>(null);
  const [errVista, setErrVista] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const [res, setRes] = useState<{ ruta: string; ok: boolean; texto: string }[] | null>(null);
  const seq = useRef(0);
  const cambia = <K extends keyof Cfg>(k: K, v: Cfg[K]) => setCfg((c) => ({ ...c, [k]: v }));

  useEffect(() => { guardarLS(CLAVE, cfg); }, [cfg]);
  useEffect(() => {
    const f = (e: Event) => { const d = (e as CustomEvent).detail; if (d.zona === zona) setArchivos((p) => [...new Set([...p, ...d.rutas.filter((r: string) => /\.pdf$/i.test(r))])]); };
    window.addEventListener("pdftool-soltar", f); return () => window.removeEventListener("pdftool-soltar", f);
  }, [zona]);

  const nada = !cfg.marcaOn && !cfg.numOn;
  useEffect(() => {
    if (!archivos.length || nada) { setVista(null); return; }
    const mi = ++seq.current;
    const t = setTimeout(async () => {
      try { const v = await invoke<string>("vista_previa_decorado", { entrada: archivos[0], decorado: construirDecorado(cfg) }); if (mi === seq.current) { setVista(v); setErrVista(""); } }
      catch (e) { if (mi === seq.current) { setVista(null); setErrVista(String(e)); } }
    }, 450);
    return () => clearTimeout(t);
  }, [archivos, cfg, nada]);

  async function elegir() {
    const r = await open({ multiple: true, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!r) return; const l = Array.isArray(r) ? r : [r];
    setArchivos((p) => [...new Set([...p, ...l])]); setRes(null);
  }
  async function aplicar() {
    setTrabajando(true); setRes(null);
    const out: { ruta: string; ok: boolean; texto: string }[] = []; let ultima = "";
    for (const e of archivos) {
      try {
        const salida = await rutaSalida(e, cfg.marcaOn && cfg.numOn ? "_marcado" : cfg.marcaOn ? "_marca" : "_numerado");
        await invoke("decorar_pdf", { entrada: e, salida, decorado: construirDecorado(cfg) });
        out.push({ ruta: e, ok: true, texto: nombreArchivo(salida) }); ultima = salida; registrar("ok", `Generado: ${salida}`);
      } catch (err) { out.push({ ruta: e, ok: false, texto: String(err) }); registrar("err", `${nombreArchivo(e)}: ${String(err)}`); }
    }
    setRes(out); setTrabajando(false);
    if (ultima) alGenerar(ultima);
  }

  return (
    <div className="ed-doble">
      <div className="ed-col">
        <div className="ed-fila">
          <button className="secundario" onClick={elegir} disabled={trabajando}><I n="plus" /> Elegir PDF…</button>
          {archivos.length > 0 && <button className="secundario" onClick={() => { setArchivos([]); setRes(null); }} disabled={trabajando}>Quitar todos</button>}
          <small>{archivos.length === 0 ? "Elige o arrastra uno o varios PDF" : `${archivos.length} archivo(s)`}</small>
        </div>
        {archivos.length > 0 && <ul className="ed-lista">{archivos.map((a) => (
          <li key={a}><span title={a}>{nombreArchivo(a)}</span><button onClick={() => setArchivos((p) => p.filter((x) => x !== a))} aria-label="Quitar" disabled={trabajando}><I n="x" s={13} /></button></li>
        ))}</ul>}

        <details className="sec" open>
          <summary><label className="ed-check" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={cfg.marcaOn} onChange={(e) => cambia("marcaOn", e.target.checked)} /> Marca de agua</label><I n="down" s={14} className="sec-flecha" /></summary>
          <div className="sec-cuerpo">
            <label>Texto<input type="text" value={cfg.texto} onChange={(e) => cambia("texto", e.target.value)} disabled={!cfg.marcaOn} /></label>
            <div className="ed-rejilla">
              <label>Tamaño ({cfg.tam} pt)<input type="range" min={20} max={160} value={cfg.tam} onChange={(e) => cambia("tam", +e.target.value)} disabled={!cfg.marcaOn} /></label>
              <label>Opacidad ({Math.round(cfg.opacidad * 100)} %)<input type="range" min={5} max={100} value={Math.round(cfg.opacidad * 100)} onChange={(e) => cambia("opacidad", +e.target.value / 100)} disabled={!cfg.marcaOn} /></label>
              <label>Ángulo<select value={cfg.angulo} onChange={(e) => cambia("angulo", +e.target.value)} disabled={!cfg.marcaOn}><option value={45}>Diagonal ↗</option><option value={0}>Horizontal</option><option value={-45}>Diagonal ↘</option><option value={90}>Vertical</option></select></label>
              <label>Color<input type="color" value={cfg.color} onChange={(e) => cambia("color", e.target.value)} disabled={!cfg.marcaOn} /></label>
            </div>
            <div className="ed-presets">{["CONFIDENCIAL", "COPIA", "BORRADOR", "NO VÁLIDO", "USO INTERNO"].map((t) => <button key={t} className="secundario" onClick={() => cambia("texto", t)} disabled={!cfg.marcaOn}>{t}</button>)}</div>
          </div>
        </details>

        <details className="sec" open>
          <summary><label className="ed-check" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={cfg.numOn} onChange={(e) => cambia("numOn", e.target.checked)} /> Numeración de páginas</label><I n="down" s={14} className="sec-flecha" /></summary>
          <div className="sec-cuerpo">
            <div className="ed-rejilla">
              <label>Formato<select value={cfg.formato} onChange={(e) => cambia("formato", e.target.value)} disabled={!cfg.numOn}>
                <option value="Página {n} de {total}">Página 1 de 10</option><option value="{n} / {total}">1 / 10</option><option value="{n}">1</option><option value="- {n} -">- 1 -</option>
              </select></label>
              <label>Posición<select value={cfg.posicion} onChange={(e) => cambia("posicion", e.target.value)} disabled={!cfg.numOn}>
                <option value="pie-derecha">Pie · derecha</option><option value="pie-centro">Pie · centro</option><option value="pie-izquierda">Pie · izquierda</option>
                <option value="cab-derecha">Cabecera · derecha</option><option value="cab-centro">Cabecera · centro</option><option value="cab-izquierda">Cabecera · izquierda</option>
              </select></label>
              <label>Tamaño ({cfg.tamNum} pt)<input type="range" min={7} max={18} value={cfg.tamNum} onChange={(e) => cambia("tamNum", +e.target.value)} disabled={!cfg.numOn} /></label>
              <label>Empezar en<input type="number" min={1} value={cfg.inicio} onChange={(e) => cambia("inicio", Math.max(1, +e.target.value || 1))} disabled={!cfg.numOn} /></label>
            </div>
          </div>
        </details>

        <label className="ed-linea">Páginas afectadas <input type="text" value={cfg.paginas} onChange={(e) => cambia("paginas", e.target.value)} placeholder="todas · 1-3,5 · 2-" /></label>

        <div className="ed-fila">
          <button className="primario azul" onClick={aplicar} disabled={trabajando || !archivos.length || nada}>{trabajando ? "Aplicando…" : `Crear copia${archivos.length > 1 ? "s" : ""} con ${cfg.marcaOn && cfg.numOn ? "marca y numeración" : cfg.marcaOn ? "marca de agua" : "numeración"}`}</button>
        </div>
        {res && <ul className="ed-res">{res.map((r) => <li key={r.ruta} className={r.ok ? "ok" : "err"}><I n={r.ok ? "check" : "warn"} s={14} /> <b>{nombreArchivo(r.ruta)}</b> → {r.texto}</li>)}</ul>}
      </div>
      <div className="ed-vista">
        {vista ? <img src={vista} alt="Vista previa de la primera página" /> : <div className="ed-vacio">{errVista ? <span className="firma-error">{errVista}</span> : archivos.length ? "Generando vista previa…" : "La vista previa aparecerá al elegir un PDF"}</div>}
        {vista && <small>Vista previa de la primera página afectada</small>}
      </div>
    </div>
  );
}
