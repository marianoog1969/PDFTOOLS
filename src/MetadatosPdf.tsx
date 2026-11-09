import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { I } from "./Icono";
import { PropsHerramienta, nombreArchivo, rutaSalida } from "./util";

interface Meta { titulo: string; autor: string; asunto: string; claves: string; creador: string; productor: string; creado: string; modificado: string; xmp: boolean; marcadores: boolean; adjuntos: number; javascript: boolean; comentarios: number; cifrado: boolean; paginas: number; }
const CAMPOS: [keyof Meta, string][] = [["titulo", "Título"], ["autor", "Autor"], ["asunto", "Asunto"], ["claves", "Palabras clave"], ["creador", "Creado con"], ["productor", "Productor"]];
const LIMPIEZA0 = { borrar_info: false, quitar_xmp: false, quitar_marcadores: false, quitar_adjuntos: false, quitar_javascript: false, quitar_comentarios: false };

export default function MetadatosPdf({ alGenerar, registrar, zona }: PropsHerramienta) {
  const [archivos, setArchivos] = useState<string[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [lim, setLim] = useState(LIMPIEZA0);
  const [err, setErr] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const [res, setRes] = useState<{ ruta: string; ok: boolean; texto: string }[] | null>(null);
  const uno = archivos.length === 1;

  useEffect(() => {
    const f = (e: Event) => { const d = (e as CustomEvent).detail; if (d.zona === zona) setArchivos((p) => [...new Set([...p, ...d.rutas.filter((r: string) => /\.pdf$/i.test(r))])]); };
    window.addEventListener("pdftool-soltar", f); return () => window.removeEventListener("pdftool-soltar", f);
  }, [zona]);
  useEffect(() => {
    setMeta(null); setEdit({}); setErr(""); setRes(null);
    if (archivos.length !== 1) return;
    invoke<Meta>("leer_metadatos", { ruta: archivos[0] }).then((m) => { setMeta(m); setEdit({ titulo: m.titulo, autor: m.autor, asunto: m.asunto, claves: m.claves, creador: m.creador, productor: m.productor }); })
      .catch((e) => setErr(String(e)));
  }, [archivos]);

  async function elegir() {
    const r = await open({ multiple: true, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!r) return; setArchivos((p) => [...new Set([...p, ...(Array.isArray(r) ? r : [r])])]);
  }
  const todo = () => setLim({ borrar_info: true, quitar_xmp: true, quitar_marcadores: true, quitar_adjuntos: true, quitar_javascript: true, quitar_comentarios: true });
  const hayAlgo = Object.values(lim).some(Boolean) || (uno && meta && CAMPOS.some(([k]) => (edit[k] ?? "") !== (meta[k] as string)));

  async function aplicar() {
    setTrabajando(true); setRes(null);
    const out: { ruta: string; ok: boolean; texto: string }[] = []; let ultima = "";
    for (const e of archivos) {
      const campos: Record<string, string> = {};
      if (uno && meta) for (const [k] of CAMPOS) if ((edit[k] ?? "") !== (meta[k] as string)) campos[k as string] = edit[k] ?? "";
      try {
        const salida = await rutaSalida(e, "_limpio");
        await invoke("limpiar_metadatos", { entrada: e, salida, opciones: { ...lim, campos } });
        out.push({ ruta: e, ok: true, texto: nombreArchivo(salida) }); ultima = salida; registrar("ok", `Generado: ${salida}`);
      } catch (x) { out.push({ ruta: e, ok: false, texto: String(x) }); registrar("err", `${nombreArchivo(e)}: ${String(x)}`); }
    }
    setRes(out); setTrabajando(false); if (ultima) alGenerar(ultima);
  }
  const marca = (k: keyof typeof LIMPIEZA0, t: string, hay?: string) => (
    <label key={k} className="ed-check"><input type="checkbox" checked={lim[k]} onChange={(e) => setLim((l) => ({ ...l, [k]: e.target.checked }))} /> {t}{hay && <span className="ed-chip">{hay}</span>}</label>
  );

  return (
    <div className="ed-col ed-ancho">
      <div className="ed-fila">
        <button className="secundario" onClick={elegir} disabled={trabajando}><I n="plus" /> Elegir PDF…</button>
        {archivos.length > 0 && <button className="secundario" onClick={() => setArchivos([])} disabled={trabajando}>Quitar todos</button>}
        <small>{archivos.length === 0 ? "Elige o arrastra uno o varios PDF" : uno ? nombreArchivo(archivos[0]) : `${archivos.length} archivos (solo se aplica la limpieza, no la edición de campos)`}</small>
      </div>
      {err && <div className="firma-error">{err}</div>}

      {uno && meta && (
        <details className="sec" open>
          <summary><span>Datos del documento</span><I n="down" s={14} className="sec-flecha" /></summary>
          <div className="sec-cuerpo">
            <div className="ed-rejilla">{CAMPOS.map(([k, t]) => <label key={k}>{t}<input type="text" value={edit[k] ?? ""} onChange={(e) => setEdit((x) => ({ ...x, [k]: e.target.value }))} disabled={lim.borrar_info && false} /></label>)}</div>
            <small>Creado: {meta.creado || "—"} · Modificado: {meta.modificado || "—"} · {meta.paginas} página(s)</small>
            {meta.cifrado && <div className="firma-error">El PDF está protegido con contraseña: no se puede modificar.</div>}
          </div>
        </details>
      )}

      <details className="sec" open>
        <summary><span>Qué limpiar</span><I n="down" s={14} className="sec-flecha" /></summary>
        <div className="sec-cuerpo">
          <div className="ed-fila"><button className="secundario" onClick={todo}><I n="shield" /> Limpieza completa para enviar fuera</button><button className="secundario" onClick={() => setLim(LIMPIEZA0)}>Nada</button></div>
          {marca("borrar_info", "Borrar todos los datos del documento (autor, título, programa…)")}
          {marca("quitar_xmp", "Quitar metadatos XMP", uno && meta ? (meta.xmp ? "presente" : "no hay") : undefined)}
          {marca("quitar_marcadores", "Quitar marcadores (índice lateral)", uno && meta ? (meta.marcadores ? "presente" : "no hay") : undefined)}
          {marca("quitar_adjuntos", "Quitar archivos adjuntos", uno && meta ? `${meta.adjuntos}` : undefined)}
          {marca("quitar_javascript", "Quitar JavaScript y acciones automáticas", uno && meta ? (meta.javascript ? "presente" : "no hay") : undefined)}
          {marca("quitar_comentarios", "Quitar comentarios y notas", uno && meta ? `${meta.comentarios}` : undefined)}
          <small>Se crea una copia «_limpio»; el original no se toca. La firma digital de un PDF firmado dejaría de ser válida.</small>
        </div>
      </details>

      <div className="ed-fila"><button className="primario azul" onClick={aplicar} disabled={trabajando || !archivos.length || !hayAlgo || (uno && !meta && !err)}>{trabajando ? "Procesando…" : "Crear copia limpia"}</button></div>
      {res && <ul className="ed-res">{res.map((r) => <li key={r.ruta} className={r.ok ? "ok" : "err"}><I n={r.ok ? "check" : "warn"} s={14} /> <b>{nombreArchivo(r.ruta)}</b> → {r.texto}</li>)}</ul>}
    </div>
  );
}
