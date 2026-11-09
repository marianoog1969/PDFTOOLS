import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { I } from "./Icono";
import { PropsHerramienta, nombreArchivo, rutaSalida } from "./util";

interface Campo { nombre: string; tipo: string; valor: string; opciones: string[]; pagina: number; solo_lectura: boolean; multilinea: boolean; }

export default function FormularioPdf({ alGenerar, registrar, zona }: PropsHerramienta) {
  const [ruta, setRuta] = useState<string | null>(null);
  const [campos, setCampos] = useState<Campo[]>([]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [aplanar, setAplanar] = useState(false);
  const [err, setErr] = useState("");
  const [cargando, setCargando] = useState(false);
  const [vista, setVista] = useState<string | null>(null);
  const [pagVista, setPagVista] = useState(1);
  const [trabajando, setTrabajando] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; texto: string } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const f = (e: Event) => { const d = (e as CustomEvent).detail; if (d.zona === zona) { const p = d.rutas.find((r: string) => /\.pdf$/i.test(r)); if (p) setRuta(p); } };
    window.addEventListener("pdftool-soltar", f); return () => window.removeEventListener("pdftool-soltar", f);
  }, [zona]);
  useEffect(() => {
    setCampos([]); setVals({}); setErr(""); setVista(null); setRes(null);
    if (!ruta) return;
    setCargando(true);
    invoke<Campo[]>("leer_formulario", { ruta }).then((c) => {
      setCampos(c); setVals(Object.fromEntries(c.map((x) => [x.nombre, x.valor])));
      setPagVista(c.find((x) => x.pagina > 0)?.pagina ?? 1);
      if (!c.length) setErr("Este PDF no tiene campos de formulario rellenables.");
    }).catch((e) => setErr(String(e))).finally(() => setCargando(false));
  }, [ruta]);

  useEffect(() => {
    if (!ruta || !campos.length) return;
    const mi = ++seq.current;
    const t = setTimeout(async () => {
      try { const v = await invoke<string>("vista_previa_formulario", { entrada: ruta, valores: vals, pagina: pagVista }); if (mi === seq.current) setVista(v); } catch { /* sin vista */ }
    }, 600);
    return () => clearTimeout(t);
  }, [ruta, campos, vals, pagVista]);

  async function elegir() {
    const r = await open({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (r && !Array.isArray(r)) setRuta(r);
  }
  async function guardar() {
    if (!ruta) return; setTrabajando(true); setRes(null);
    try {
      const salida = await rutaSalida(ruta, aplanar ? "_plano" : "_rellenado");
      await invoke("rellenar_formulario", { entrada: ruta, salida, valores: vals, aplanar });
      setRes({ ok: true, texto: nombreArchivo(salida) }); registrar("ok", `Generado: ${salida}`); alGenerar(salida);
    } catch (e) { setRes({ ok: false, texto: String(e) }); registrar("err", String(e)); }
    setTrabajando(false);
  }
  const set = (n: string, v: string) => setVals((x) => ({ ...x, [n]: v }));
  const paginas = [...new Set(campos.map((c) => c.pagina))].sort((a, b) => a - b);

  const entrada = (c: Campo) => {
    const v = vals[c.nombre] ?? "";
    if (c.tipo === "casilla") return <label className="ed-check"><input type="checkbox" checked={v === "true"} disabled={c.solo_lectura} onChange={(e) => set(c.nombre, e.target.checked ? "true" : "false")} /> Marcada</label>;
    if (c.tipo === "radio") return <div className="ed-radios">{c.opciones.map((o) => <label key={o} className="ed-check"><input type="radio" name={c.nombre} checked={v === o} disabled={c.solo_lectura} onChange={() => set(c.nombre, o)} /> {o}</label>)}</div>;
    if (c.tipo === "lista" || c.tipo === "desplegable") return <select value={v} disabled={c.solo_lectura} onChange={(e) => set(c.nombre, e.target.value)}><option value="">—</option>{c.opciones.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
    return c.multilinea ? <textarea rows={3} value={v} disabled={c.solo_lectura} onChange={(e) => set(c.nombre, e.target.value)} /> : <input type="text" value={v} disabled={c.solo_lectura} onChange={(e) => set(c.nombre, e.target.value)} />;
  };

  return (
    <div className="ed-doble">
      <div className="ed-col">
        <div className="ed-fila"><button className="secundario" onClick={elegir} disabled={trabajando}><I n="plus" /> Elegir PDF…</button><small>{ruta ? nombreArchivo(ruta) : "Elige o arrastra un PDF con formulario"}</small></div>
        {cargando && <small>Leyendo campos…</small>}
        {err && <div className="firma-error">{err}</div>}
        {paginas.map((p) => (
          <details className="sec" key={p} open onToggle={() => p > 0 && setPagVista(p)}>
            <summary><span>{p > 0 ? `Página ${p}` : "Campos"}</span><I n="down" s={14} className="sec-flecha" /></summary>
            <div className="sec-cuerpo">
              {campos.filter((c) => c.pagina === p).map((c) => (
                <div key={c.nombre} className="ed-campo"><div className="ed-etq" title={c.nombre}>{c.nombre}{c.solo_lectura && <span className="ed-chip">solo lectura</span>}</div>{entrada(c)}</div>
              ))}
            </div>
          </details>
        ))}
        {campos.length > 0 && <>
          <label className="ed-check"><input type="checkbox" checked={aplanar} onChange={(e) => setAplanar(e.target.checked)} /> Aplanar: dejar los datos fijos y quitar los campos (ya no se podrá editar)</label>
          <div className="ed-fila"><button className="primario azul" onClick={guardar} disabled={trabajando}>{trabajando ? "Guardando…" : aplanar ? "Guardar copia aplanada" : "Guardar copia rellenada"}</button></div>
        </>}
        {res && <div className={`ed-res-uno ${res.ok ? "ok" : "err"}`}><I n={res.ok ? "check" : "warn"} s={14} /> {res.ok ? `Guardado: ${res.texto}` : res.texto}</div>}
      </div>
      <div className="ed-vista">
        {vista ? <img src={vista} alt={`Vista previa de la página ${pagVista}`} /> : <div className="ed-vacio">{campos.length ? "Generando vista previa…" : "La vista previa aparecerá al elegir un PDF"}</div>}
        {vista && <small>Página {pagVista}</small>}
      </div>
    </div>
  );
}
