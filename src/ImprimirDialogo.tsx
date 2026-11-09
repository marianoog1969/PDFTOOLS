import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { I } from "./Icono";
import { avisar, confirmar } from "./Avisos";
import { leerLS, guardarLS, nombreArchivo, validarRangoPaginas, textoFechaImpresion, type Registrar } from "./util";

interface Impresora { nombre: string; predeterminada: boolean; red: boolean; }
interface Resultado { metodo: string; avisos: string[]; }
/** Respuesta de la impresora a «¿aceptas PDF?» (comando sondear_impresora) */
interface Sondeo { estado: "si" | "no" | "desconocido"; detalle: string; via: string; lenguajes: string[]; direccion: string; pide_direccion: boolean; }
interface SondeoGuardado extends Sondeo { fecha: string; }
type Metodo = "auto" | "directo" | "sumatra" | "ghostscript";

interface Preferencias {
  impresora: string;
  copias: number;
  intercalar: boolean;
  doble_cara: "auto" | "no" | "largo" | "corto";
  color: "auto" | "color" | "gris";
  por_hoja: number;
  orientacion: "auto" | "vertical" | "horizontal";
  /** método elegido para cada impresora (p. ej. «directo» para las que entienden PDF) */
  metodos: Record<string, Metodo>;
  /** marca de agua solo en la copia impresa */
  marcaOn: boolean;
  marcaTexto: string;
  /** pie «Impreso el … a las …» solo en la copia impresa */
  fechaOn: boolean;
  /** última comprobación de «¿acepta PDF?» de cada impresora */
  sondeos: Record<string, SondeoGuardado>;
  /** IP escrita a mano para las impresoras cuya dirección no se puede averiguar */
  direcciones: Record<string, string>;
}
const CLAVE = "pdftool_impresion";
/** Método de impresión recordado para una impresora (lo usa también el paso «Imprimir» de Lotes). */
export function metodoGuardado(impresora: string): string {
  return leerLS<Preferencias>(CLAVE, POR_DEFECTO).metodos[impresora] ?? "auto";
}
/** Impresora usada la última vez (o «» si nunca se imprimió). */
export function impresoraGuardada(): string { return leerLS<Preferencias>(CLAVE, POR_DEFECTO).impresora; }
const POR_DEFECTO: Preferencias = { impresora: "", copias: 1, intercalar: true, doble_cara: "auto", color: "auto", por_hoja: 1, orientacion: "auto", metodos: {}, marcaOn: false, marcaTexto: "COPIA", fechaOn: false, sondeos: {}, direcciones: {} };

const NOMBRE_METODO: Record<string, string> = {
  webview: "el motor de Windows", directo: "envío directo", sumatra: "SumatraPDF", ghostscript: "Ghostscript",
};

export interface PropsImprimir {
  ruta: string;
  /** Páginas del documento (para validar el rango); 0 si no se sabe. */
  total: number;
  /** Rango propuesto al abrir (p. ej. las páginas seleccionadas en el visor). */
  paginasIniciales?: string;
  /** Aviso a mostrar arriba (p. ej. cambios sin guardar que no se imprimirán). */
  aviso?: string;
  cerrar: () => void;
  registrar: Registrar;
}

export default function ImprimirDialogo({ ruta, total, paginasIniciales, aviso, cerrar, registrar }: PropsImprimir) {
  const [pref, setPref] = useState<Preferencias>(() => leerLS(CLAVE, POR_DEFECTO));
  const [impresoras, setImpresoras] = useState<Impresora[] | null>(null);
  const [haySumatra, setHaySumatra] = useState(false);
  const [todas, setTodas] = useState(!paginasIniciales);
  const [rango, setRango] = useState(paginasIniciales ?? "");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verAvanzado, setVerAvanzado] = useState(false);
  const [comprobando, setComprobando] = useState(false);
  const [ipEscrita, setIpEscrita] = useState("");

  const cambiar = <K extends keyof Preferencias>(k: K, v: Preferencias[K]) => setPref((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    invoke<Impresora[]>("listar_impresoras")
      .then((l) => {
        setImpresoras(l);
        setPref((p) => (p.impresora && l.some((x) => x.nombre === p.impresora)) ? p : { ...p, impresora: l.find((x) => x.predeterminada)?.nombre ?? l[0]?.nombre ?? "" });
      })
      .catch((e) => { setImpresoras([]); setError(String(e)); });
    invoke<{ sumatra: boolean }>("info_impresion").then((r) => setHaySumatra(r.sumatra)).catch(() => {});
  }, []);

  useEffect(() => {
    const t = (e: KeyboardEvent) => { if (e.key === "Escape" && !enviando) cerrar(); };
    window.addEventListener("keydown", t); return () => window.removeEventListener("keydown", t);
  }, [enviando, cerrar]);

  const metodo: Metodo = pref.metodos[pref.impresora] ?? "auto";
  const sondeo: SondeoGuardado | undefined = pref.sondeos?.[pref.impresora];

  /** Pregunta a la impresora si acepta PDF (IPP y, si no responde, SNMP) y guarda la respuesta. */
  async function comprobarPdf(direccion?: string) {
    const imp = pref.impresora;
    if (!imp) return;
    setComprobando(true);
    setTimeout(() => document.querySelector(".imp-sondeo")?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
    try {
      const dir = direccion ?? pref.direcciones?.[imp];
      const r = await invoke<Sondeo>("sondear_impresora", { impresora: imp, direccion: dir || null });
      setPref((p) => {
        const n = { ...p, sondeos: { ...p.sondeos, [imp]: { ...r, fecha: new Date().toISOString() } }, direcciones: direccion ? { ...p.direcciones, [imp]: direccion } : p.direcciones };
        guardarLS(CLAVE, n); return n;
      });
      registrar("info", `Comprobación de «${imp}»: ${r.detalle}`);
      // que se vea el resultado aunque quede por debajo en el panel
      setTimeout(() => document.querySelector(".imp-sondeo")?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
    } catch (e) { registrar("err", `No se pudo comprobar la impresora: ${String(e)}`); }
    finally { setComprobando(false); }
  }

  // Al elegir «Envío directo» para una impresora que no se ha comprobado, se le pregunta.
  useEffect(() => {
    if (metodo === "directo" && pref.impresora && !pref.sondeos?.[pref.impresora] && !comprobando) comprobarPdf();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al cambiar de impresora o de método
  }, [metodo, pref.impresora]);
  useEffect(() => { setIpEscrita(pref.direcciones?.[pref.impresora] ?? ""); }, [pref.impresora, pref.direcciones]);
  const valRango = useMemo(() => (todas ? null : validarRangoPaginas(rango, total)), [todas, rango, total]);
  const sinImpresoras = impresoras !== null && impresoras.length === 0;
  const puede = !enviando && !sinImpresoras && !!pref.impresora && (todas || !!valRango?.ok) && pref.copias >= 1;

  async function imprimir() {
    if (!puede) return;
    if (metodo === "directo" && sondeo?.estado === "no" && !(await confirmar({
      titulo: "La impresora dice que no acepta PDF",
      texto: `${sondeo.detalle}\n\nSi la envías de forma directa, lo más probable es que salgan hojas llenas de símbolos.`,
      ok: "Imprimir de todas formas", peligro: true, icono: "warn",
    }))) return;
    setEnviando(true); setError(null);
    guardarLS(CLAVE, pref);
    const ajustes = {
      impresora: pref.impresora, copias: pref.copias, paginas: todas ? "" : rango, doble_cara: pref.doble_cara, color: pref.color,
      por_hoja: pref.por_hoja, orientacion: pref.orientacion, intercalar: pref.intercalar, metodo,
      marca_copia: pref.marcaOn && pref.marcaTexto.trim() ? pref.marcaTexto.trim() : null,
      pie_copia: pref.fechaOn ? textoFechaImpresion() : null,
    };
    try {
      const r = await invoke<Resultado>("imprimir_pdf", { ruta, ajustes });
      registrar("ok", `Enviado a «${pref.impresora}»: ${nombreArchivo(ruta)} (${NOMBRE_METODO[r.metodo] ?? r.metodo})`);
      r.avisos.forEach((a) => registrar("info", a));
      avisar({ tipo: "ok", titulo: "Enviado a la impresora", texto: `${nombreArchivo(ruta)} → ${pref.impresora}${r.avisos.length ? `\n${r.avisos.join("\n")}` : ""}` });
      cerrar();
    } catch (e) {
      setError(String(e));
      registrar("info", `No se pudo imprimir ${nombreArchivo(ruta)}: ${String(e).split("\n")[0]}`);
    } finally { setEnviando(false); }
  }

  async function dialogoWindows() {
    guardarLS(CLAVE, pref);
    setEnviando(true); setError(null);
    try { await invoke("dialogo_impresion", { ruta }); cerrar(); }
    catch (e) { setError(String(e)); }
    finally { setEnviando(false); }
  }

  return (
    <div className="modal-fondo" onMouseDown={() => !enviando && cerrar()}>
      <div className="modal-caja imp-caja" role="dialog" aria-modal="true" aria-label="Imprimir" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-cab">
          <h3><I n="printer" s={18} /> Imprimir</h3>
          <button className="modal-x" onClick={cerrar} disabled={enviando} aria-label="Cerrar"><I n="x" /></button>
        </div>

        <div className="imp-cuerpo">
          <div className="imp-doc" title={ruta}><I n="file" s={15} /> <span>{nombreArchivo(ruta)}</span>{total > 0 && <small>{total} {total === 1 ? "página" : "páginas"}</small>}</div>
          {aviso && <div className="imp-aviso"><I n="warn" s={14} /> {aviso}</div>}

          <label className="imp-campo">
            <span>Impresora</span>
            {impresoras === null ? <div className="imp-cargando">Buscando impresoras…</div>
              : sinImpresoras ? <div className="imp-error-linea">No hay impresoras instaladas en Windows.</div>
              : (
                <select value={pref.impresora} onChange={(e) => cambiar("impresora", e.target.value)} disabled={enviando} autoFocus>
                  {impresoras.map((x) => <option key={x.nombre} value={x.nombre}>{x.nombre}{x.predeterminada ? " (predeterminada)" : ""}{x.red ? " · red" : ""}</option>)}
                </select>
              )}
          </label>

          <div className="imp-fila">
            <label className="imp-campo imp-copias">
              <span>Copias</span>
              <input type="number" min={1} max={999} value={pref.copias} disabled={enviando}
                onChange={(e) => cambiar("copias", Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1)))} />
            </label>
            {pref.copias > 1 && (
              <label className="ed-check imp-intercalar">
                <input type="checkbox" checked={pref.intercalar} onChange={(e) => cambiar("intercalar", e.target.checked)} disabled={enviando} />
                Intercalar <small>(1-2-3, 1-2-3…)</small>
              </label>
            )}
          </div>

          <div className="imp-campo">
            <span>Páginas</span>
            <div className="imp-paginas">
              <div className="grupo-herr">
                <button type="button" className={todas ? "on" : ""} onClick={() => setTodas(true)} disabled={enviando}>Todas</button>
                <button type="button" className={!todas ? "on" : ""} onClick={() => setTodas(false)} disabled={enviando}>Elegir</button>
              </div>
              {!todas && (
                <input className={`imp-rango${valRango ? (valRango.ok ? " ok" : " mal") : ""}`} value={rango} onChange={(e) => setRango(e.target.value)}
                  placeholder={total ? `Ej: 1-3, 5  (de 1 a ${total})` : "Ej: 1-3, 5"} disabled={enviando} autoFocus />
              )}
            </div>
            {!todas && valRango && (valRango.ok
              ? <small className="imp-ok"><I n="check" s={12} /> {valRango.n} {valRango.n === 1 ? "página" : "páginas"}</small>
              : <small className="imp-mal">{valRango.error}</small>)}
          </div>

          <div className="imp-rejilla">
            <label className="imp-campo">
              <span>Doble cara</span>
              <select value={pref.doble_cara} onChange={(e) => cambiar("doble_cara", e.target.value as Preferencias["doble_cara"])} disabled={enviando}>
                <option value="auto">Según la impresora</option>
                <option value="no">Una cara</option>
                <option value="largo">Doble cara · borde largo</option>
                <option value="corto">Doble cara · borde corto</option>
              </select>
            </label>
            <label className="imp-campo">
              <span>Color</span>
              <select value={pref.color} onChange={(e) => cambiar("color", e.target.value as Preferencias["color"])} disabled={enviando}>
                <option value="auto">Según la impresora</option>
                <option value="color">Color</option>
                <option value="gris">Blanco y negro</option>
              </select>
            </label>
            <label className="imp-campo">
              <span>Páginas por hoja</span>
              <select value={pref.por_hoja} onChange={(e) => cambiar("por_hoja", +e.target.value)} disabled={enviando}>
                {[1, 2, 4, 6, 9, 16].map((n) => <option key={n} value={n}>{n === 1 ? "1 (normal)" : n}</option>)}
              </select>
            </label>
            <label className="imp-campo">
              <span>Orientación</span>
              <select value={pref.orientacion} onChange={(e) => cambiar("orientacion", e.target.value as Preferencias["orientacion"])} disabled={enviando}>
                <option value="auto">Automática</option>
                <option value="vertical">Vertical</option>
                <option value="horizontal">Horizontal</option>
              </select>
            </label>
          </div>

          <div className="imp-campo">
            <span>Solo en la copia impresa <small className="imp-sub">(el archivo no se modifica)</small></span>
            <div className="imp-copia">
              <label className="ed-check"><input type="checkbox" checked={pref.marcaOn} onChange={(e) => cambiar("marcaOn", e.target.checked)} disabled={enviando} /> Marca de agua</label>
              <input className="imp-marca" value={pref.marcaTexto} onChange={(e) => cambiar("marcaTexto", e.target.value)} disabled={enviando || !pref.marcaOn} placeholder="COPIA" aria-label="Texto de la marca de agua" maxLength={40} />
              <label className="ed-check"><input type="checkbox" checked={pref.fechaOn} onChange={(e) => cambiar("fechaOn", e.target.checked)} disabled={enviando} /> Fecha y hora al pie</label>
            </div>
            {pref.fechaOn && <small className="imp-sub">Saldrá: «{textoFechaImpresion()}»</small>}
          </div>

          <details className="imp-avanzado" open={verAvanzado} onToggle={(e) => setVerAvanzado((e.target as HTMLDetailsElement).open)}>
            <summary>Opciones avanzadas {metodo !== "auto" && <span className="ed-chip">{metodo === "directo" ? "Envío directo" : metodo === "sumatra" ? "SumatraPDF" : "Ghostscript"}</span>}</summary>
            <div className="imp-metodos" role="radiogroup" aria-label="Método de impresión">
              {([
                ["auto", "Automático (recomendado)", "Usa el motor de PDF de Windows (calidad vectorial). Si falla, prueba los demás métodos."],
                ["directo", "Envío directo a la impresora", "Manda el PDF tal cual. Lo más rápido y nítido, pero solo para impresoras que entienden PDF (muchas de oficina: HP, Ricoh, Kyocera, Konica…). Si la impresora no lo admite, saldrán hojas con símbolos: prueba primero con una página."],
                ...(haySumatra ? [["sumatra", "SumatraPDF", "Usa SumatraPDF de la carpeta UTILS."]] : []),
                ["ghostscript", "Ghostscript", "Siempre funciona, pero envía las páginas como imagen (más lento y pesado). Doble cara, color y páginas por hoja siguen la configuración de la impresora."],
              ] as [Metodo, string, string][]).map(([m, t, d]) => (
                <label key={m} className={`imp-metodo${metodo === m ? " on" : ""}`}>
                  <input type="radio" name="metodo-imp" checked={metodo === m} disabled={enviando || !pref.impresora}
                    onChange={() => setPref((p) => ({ ...p, metodos: { ...p.metodos, [p.impresora]: m } }))} />
                  <span><b>{t}{m === "directo" && sondeo && <span className={`imp-chip ${sondeo.estado}`}>{sondeo.estado === "si" ? "Acepta PDF" : sondeo.estado === "no" ? "No acepta PDF" : "Sin comprobar"}</span>}</b><small>{d}</small></span>
                </label>
              ))}
              {metodo === "directo" && (
                <div className={`imp-sondeo ${comprobando ? "comprobando" : sondeo?.estado ?? "desconocido"}`} aria-live="polite">
                  {comprobando ? <span className="imp-sondeo-tit"><span className="imp-giro oscuro" /> Preguntando a la impresora si acepta PDF…</span> : sondeo ? (
                    <>
                      <span className="imp-sondeo-tit">
                        <I n={sondeo.estado === "si" ? "check" : sondeo.estado === "no" ? "x" : "info"} s={14} />
                        {sondeo.estado === "si" ? "La impresora acepta PDF" : sondeo.estado === "no" ? "La impresora no acepta PDF" : "No se ha podido comprobar"}
                      </span>
                      <span>{sondeo.detalle}</span>
                      {sondeo.via && <small>Comprobado por {sondeo.via}{sondeo.direccion ? ` en ${sondeo.direccion}` : ""} · {new Date(sondeo.fecha).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}</small>}
                      {sondeo.estado === "no" && <span><b>No uses el envío directo con esta impresora.</b></span>}
                      {sondeo.estado === "desconocido" && <span>Puedes probar igualmente, pero imprime primero <b>una sola página</b>.</span>}
                      {(sondeo.pide_direccion || sondeo.estado === "desconocido") && (
                        <form className="imp-ip" onSubmit={(e) => { e.preventDefault(); if (ipEscrita.trim()) comprobarPdf(ipEscrita.trim()); }}>
                          <input value={ipEscrita} onChange={(e) => setIpEscrita(e.target.value)} placeholder="IP de la impresora, p. ej. 10.20.1.45" aria-label="Dirección IP de la impresora" disabled={enviando} />
                          <button type="submit" className="secundario" disabled={enviando || !ipEscrita.trim()}>Comprobar</button>
                        </form>
                      )}
                      <span className="imp-sondeo-acc">
                        <button type="button" className="imp-enlace" onClick={() => comprobarPdf()} disabled={enviando}>Volver a comprobar</button>
                        {sondeo.estado === "no" && <button type="button" className="imp-enlace" onClick={() => setPref((p) => ({ ...p, metodos: { ...p.metodos, [p.impresora]: "auto" } }))}>Usar «Automático» con esta impresora</button>}
                      </span>
                    </>
                  ) : null}
                </div>
              )}
              <p className="imp-nota">El método se recuerda para cada impresora.</p>
            </div>
          </details>

          {error && (
            <div className="imp-error" role="alert">
              <b><I n="warn" s={14} /> No se pudo imprimir</b>
              <pre>{error}</pre>
              <span>Prueba con <button type="button" className="imp-enlace" onClick={dialogoWindows} disabled={enviando}>el diálogo de Windows</button> o cambia el método en «Opciones avanzadas».</span>
            </div>
          )}
        </div>

        <div className="dlg-pie imp-pie">
          <button type="button" className="imp-enlace" onClick={dialogoWindows} disabled={enviando}
            title="Abre el documento con el diálogo de impresión de Windows: bandejas, grapado y preferencias propias de la impresora">
            Diálogo de Windows…
          </button>
          <span className="imp-espacio" />
          <button type="button" className="secundario" onClick={cerrar} disabled={enviando}>Cancelar</button>
          <button type="button" className="primario" onClick={imprimir} disabled={!puede}>
            {enviando ? <><span className="imp-giro" /> Enviando…</> : <><I n="printer" s={15} /> Imprimir</>}
          </button>
        </div>
      </div>
    </div>
  );
}
