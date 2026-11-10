import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { I } from "./Icono";
import { impresoraGuardada, metodoGuardado } from "./ImprimirDialogo";
import { PropsHerramienta, carpetaDe, esOffice, esPdf, formatoTam, guardarLS, nombreArchivo, tipoOffice, unir } from "./util";

type SalidaPpt = "diapositivas" | "notas" | "doc2" | "doc3" | "doc6";
type PasoUI =
  | { tipo: "convertir"; excel_alcance: "libro" | "hoja"; excel_ajustar: boolean; ppt_salida: SalidaPpt; pdfa: boolean; solo_office: boolean }
  | { tipo: "comprimir"; nivel: string }
  | { tipo: "ocr" }
  | { tipo: "decorar"; marca: string; numOn: boolean; formato: string; posicion: string }
  | { tipo: "metadatos"; completo: boolean }
  | { tipo: "aplanar" }
  | { tipo: "imprimir"; impresora: string; copias: number; doble_cara: string; color: string; marca: string };
interface Perfil { id: string; nombre: string; pasos: PasoUI[]; }
interface ResultadoLote { entrada: string; salida: string; ok: boolean; error: string; tamano_entrada: number; tamano_salida: number; aviso: string; }
interface Impresora { nombre: string; predeterminada: boolean; red: boolean; }
interface InfoOffice { instalado: boolean; version: string; word: boolean; excel: boolean; powerpoint: boolean; pdfa: boolean; }
const CONVERTIR: PasoUI = { tipo: "convertir", excel_alcance: "libro", excel_ajustar: true, ppt_salida: "diapositivas", pdfa: false, solo_office: false };
const EXT_OFFICE = ["docx", "doc", "docm", "dotx", "rtf", "odt", "txt", "xlsx", "xls", "xlsm", "xlsb", "ods", "csv", "pptx", "ppt", "pptm", "ppsx", "pps", "odp"];

const CLAVE = "pdftool_perfiles";
const PRESETS: Perfil[] = [
  { id: "p1", nombre: "Enviar al exterior (limpiar y comprimir)", pasos: [{ tipo: "metadatos", completo: true }, { tipo: "comprimir", nivel: "ebook" }] },
  { id: "p2", nombre: "Archivo: OCR y numeración", pasos: [{ tipo: "ocr" }, { tipo: "decorar", marca: "", numOn: true, formato: "Página {n} de {total}", posicion: "pie-derecha" }] },
  { id: "p3", nombre: "Comprimir", pasos: [{ tipo: "comprimir", nivel: "ebook" }] },
  { id: "p4", nombre: "Word/Excel/PowerPoint a PDF", pasos: [{ ...CONVERTIR, solo_office: true }] },
];
const NOMBRE_PASO: Record<PasoUI["tipo"], string> = { convertir: "Convertir Word/Excel/PowerPoint a PDF", comprimir: "Comprimir", ocr: "OCR (texto buscable)", decorar: "Marca de agua / numeración", metadatos: "Limpiar metadatos", aplanar: "Aplanar formularios", imprimir: "Imprimir" };

function leerPerfiles(): Perfil[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLAVE) ?? "null");
    if (Array.isArray(v) && v.length) {
      // 3.10: añadir una vez el perfil de ejemplo de Office a quien ya tenía perfiles guardados
      if (localStorage.getItem(CLAVE + "_v") !== "2") {
        localStorage.setItem(CLAVE + "_v", "2");
        if (!v.some((p: Perfil) => p.id === "p4")) v.push(PRESETS[3]);
      }
      // 3.12: la firma digital se eliminó; se quitan esos pasos de los perfiles guardados
      return v.map((p: Perfil) => ({ ...p, pasos: (p.pasos as { tipo: string }[]).filter((x) => x.tipo !== "firmar") as PasoUI[] }));
    }
  } catch { /* */ }
  return PRESETS;
}

function aBackend(p: PasoUI): Record<string, unknown> {
  switch (p.tipo) {
    case "convertir": return { tipo: "convertir", opciones: { pdfa: p.pdfa, marcadores: true, excel_alcance: p.excel_alcance, excel_ajustar: p.excel_ajustar, ppt_salida: p.ppt_salida, tiempo_max: 120 } };
    case "comprimir": return { tipo: "comprimir", nivel: p.nivel };
    case "ocr": return { tipo: "ocr", idioma: "spa" };
    case "aplanar": return { tipo: "aplanar" };
    case "metadatos": return { tipo: "metadatos", opciones: p.completo ? { borrar_info: true, quitar_xmp: true, quitar_marcadores: false, quitar_adjuntos: true, quitar_javascript: true, quitar_comentarios: false, campos: {} } : { borrar_info: true, campos: {} } };
    case "decorar": return { tipo: "decorar", decorado: {
      marca: p.marca.trim() ? { texto: p.marca, tam: 64, opacidad: 0.25, color: [0.8, 0, 0], angulo: 45 } : null,
      numeracion: p.numOn ? { formato: p.formato, posicion: p.posicion, tam: 10, inicio: 1, color: [0, 0, 0] } : null, paginas: "todas" } };
    case "imprimir": return { tipo: "imprimir", ajustes: {
      impresora: p.impresora || null, copias: p.copias, paginas: "", doble_cara: p.doble_cara, color: p.color, por_hoja: 1, orientacion: "auto",
      intercalar: true, metodo: p.impresora ? metodoGuardado(p.impresora) : "auto", marca_copia: p.marca.trim() || null, pie_copia: null } };
  }
}

export default function LotesPdf({ alGenerar, registrar, zona }: PropsHerramienta) {
  const [perfiles, setPerfiles] = useState<Perfil[]>(leerPerfiles);
  const [sel, setSel] = useState<string>(() => leerPerfiles()[0].id);
  const [archivos, setArchivos] = useState<string[]>([]);
  const [carpetaOrigen, setCarpetaOrigen] = useState<string | null>(null);
  const [recursivo, setRecursivo] = useState(false);
  const [salida, setSalida] = useState("");
  const [sufijo, setSufijo] = useState("");
  const [corriendo, setCorriendo] = useState(false);
  const [prog, setProg] = useState<{ actual: number; total: number; archivo: string; fase?: string } | null>(null);
  const [res, setRes] = useState<ResultadoLote[] | null>(null);
  const [err, setErr] = useState("");
  const salidaManual = useRef(false);
  const [impresoras, setImpresoras] = useState<Impresora[] | null>(null);

  const perfil = perfiles.find((p) => p.id === sel) ?? perfiles[0];
  const conImprimir = perfil.pasos.some((p) => p.tipo === "imprimir");
  const pasoConv = perfil.pasos.find((p): p is Extract<PasoUI, { tipo: "convertir" }> => p.tipo === "convertir");
  const conConvertir = !!pasoConv;
  const [infoOffice, setInfoOffice] = useState<InfoOffice | null>(null);
  useEffect(() => {
    if (!conConvertir || infoOffice) return;
    invoke<InfoOffice>("info_office").then(setInfoOffice).catch(() => setInfoOffice({ instalado: false, version: "", word: false, excel: false, powerpoint: false, pdfa: false }));
  }, [conConvertir, infoOffice]);
  // Qué se procesa según el perfil: sin «Convertir» solo PDF; con él, PDF y Office (o solo Office)
  const nOffice = archivos.filter(esOffice).length;
  const nPdf = archivos.filter(esPdf).length;
  const entradas = archivos.filter((a) => (conConvertir ? esOffice(a) || (!pasoConv?.solo_office && esPdf(a)) : esPdf(a)));
  useEffect(() => {
    if (!conImprimir || impresoras) return;
    invoke<Impresora[]>("listar_impresoras").then(setImpresoras).catch(() => setImpresoras([]));
  }, [conImprimir, impresoras]);
  useEffect(() => { guardarLS(CLAVE, perfiles); }, [perfiles]);
  useEffect(() => { let off: (() => void) | undefined; listen<{ actual: number; total: number; archivo: string; fase?: string }>("lote-progreso", (e) => setProg(e.payload)).then((u) => { off = u; }); return () => off?.(); }, []);
  useEffect(() => {
    const f = (e: Event) => { const d = (e as CustomEvent).detail; if (d.zona === zona) { setCarpetaOrigen(null); setArchivos((p) => [...new Set([...p, ...d.rutas.filter((r: string) => esPdf(r) || esOffice(r))])]); } };
    window.addEventListener("pdftool-soltar", f); return () => window.removeEventListener("pdftool-soltar", f);
  }, [zona]);

  // carpeta de salida por defecto
  useEffect(() => {
    if (salidaManual.current) return;
    const base = carpetaOrigen ?? (archivos[0] ? carpetaDe(archivos[0]) : "");
    setSalida(base ? unir(base, "procesados") : "");
  }, [carpetaOrigen, archivos]);
  // listado de la carpeta
  useEffect(() => {
    if (!carpetaOrigen) return;
    // se listan siempre también los documentos de Office: así se puede avisar de que hay y ofrecer convertirlos
    invoke<string[]>("listar_pdfs_carpeta", { ruta: carpetaOrigen, recursivo, excluir: salida || null, office: true }).then((l) => { setArchivos(l); setErr(l.length ? "" : "No hay PDF ni documentos de Office en esa carpeta."); }).catch((e) => setErr(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carpetaOrigen, recursivo]);

  const actualizar = (f: (p: Perfil) => Perfil) => setPerfiles((l) => l.map((p) => (p.id === perfil.id ? f(p) : p)));
  const setPaso = (i: number, n: PasoUI) => actualizar((p) => ({ ...p, pasos: p.pasos.map((x, k) => (k === i ? n : x)) }));
  // «Convertir» siempre es el primero: no se mueve ni se puede poner nada delante
  const mover = (i: number, d: number) => actualizar((p) => { const a = [...p.pasos]; const j = i + d; if (j < 0 || j >= a.length || a[i].tipo === "convertir" || a[j].tipo === "convertir") return p; [a[i], a[j]] = [a[j], a[i]]; return { ...p, pasos: a }; });
  const nuevo = () => { const id = "u" + Date.now(); setPerfiles((l) => [...l, { id, nombre: "Perfil nuevo", pasos: [] }]); setSel(id); };
  const duplicar = () => { const id = "u" + Date.now(); setPerfiles((l) => [...l, { ...perfil, id, nombre: perfil.nombre + " (copia)", pasos: JSON.parse(JSON.stringify(perfil.pasos)) }]); setSel(id); };
  const eliminar = () => { if (perfiles.length <= 1) return; const resto = perfiles.filter((p) => p.id !== perfil.id); setPerfiles(resto); setSel(resto[0].id); };
  const anadir = (t: PasoUI["tipo"]) => actualizar((p) => {
    if (t === "convertir") return p.pasos.some((x) => x.tipo === "convertir") ? p : { ...p, pasos: [{ ...CONVERTIR }, ...p.pasos] };
    const n: PasoUI = t === "comprimir" ? { tipo: t, nivel: "ebook" } : t === "decorar" ? { tipo: t, marca: "", numOn: true, formato: "Página {n} de {total}", posicion: "pie-derecha" } : t === "metadatos" ? { tipo: t, completo: true }
      : t === "imprimir" ? { tipo: t, impresora: impresoraGuardada(), copias: 1, doble_cara: "auto", color: "auto", marca: "" } : ({ tipo: t } as PasoUI);
    const pasos = [...p.pasos, n]; // «Imprimir» y el resto, al final
    return { ...p, pasos };
  });

  const sinOffice = conConvertir && infoOffice !== null && !infoOffice.instalado;
  const puede = !corriendo && entradas.length > 0 && perfil.pasos.length > 0 && !sinOffice && !!salida;

  async function elegirCarpeta() { const r = await open({ directory: true, multiple: false }); if (r && !Array.isArray(r)) { salidaManual.current = false; setCarpetaOrigen(r); setRes(null); } }
  async function elegirArchivos() { const r = await open({ multiple: true, filters: [{ name: "PDF y documentos de Office", extensions: ["pdf", ...EXT_OFFICE] }, { name: "PDF", extensions: ["pdf"] }] }); if (!r) return; salidaManual.current = false; setCarpetaOrigen(null); setArchivos((p) => [...new Set([...p, ...(Array.isArray(r) ? r : [r])])]); setRes(null); }
  async function elegirSalida() { const r = await open({ directory: true, multiple: false }); if (r && !Array.isArray(r)) { salidaManual.current = true; setSalida(r); } }

  async function ejecutar() {
    setCorriendo(true); setRes(null); setErr(""); setProg({ actual: 0, total: entradas.length, archivo: "" });
    registrar("info", `Lote «${perfil.nombre}»: ${entradas.length} archivo(s) → ${salida}`);
    try {
      const r = await invoke<ResultadoLote[]>("ejecutar_lote", { entradas, base: carpetaOrigen, carpetaSalida: salida, sufijo, pasos: perfil.pasos.map((p) => aBackend(p)) });
      setRes(r);
      for (const x of r) registrar(x.ok ? "ok" : "err", x.ok ? `Generado: ${x.salida}` : `${nombreArchivo(x.entrada)}: ${x.error}`);
      const ultima = [...r].reverse().find((x) => x.ok);
      if (ultima) alGenerar(ultima.salida);
    } catch (e) { setErr(String(e)); registrar("err", String(e)); }
    setCorriendo(false); setProg(null);
  }

  const okN = res?.filter((x) => x.ok).length ?? 0;
  // el «ahorro» solo tiene sentido entre PDF (un .docx convertido no se compara con su PDF)
  const ahorro = res ? res.filter((x) => x.ok && esPdf(x.entrada)).reduce((a, x) => a + (x.tamano_entrada - x.tamano_salida), 0) : 0;

  return (
    <div className="ed-col ed-ancho">
      <details className="sec" open>
        <summary><span>1 · Archivos de origen</span><I n="down" s={14} className="sec-flecha" /></summary>
        <div className="sec-cuerpo">
          <div className="ed-fila">
            <button className="secundario" onClick={elegirCarpeta} disabled={corriendo}><I n="file" /> Elegir carpeta…</button>
            <button className="secundario" onClick={elegirArchivos} disabled={corriendo}><I n="plus" /> Elegir archivos…</button>
            {archivos.length > 0 && <button className="secundario" onClick={() => { setArchivos([]); setCarpetaOrigen(null); setRes(null); }} disabled={corriendo}>Vaciar</button>}
          </div>
          {carpetaOrigen && <label className="ed-check"><input type="checkbox" checked={recursivo} onChange={(e) => setRecursivo(e.target.checked)} disabled={corriendo} /> Incluir subcarpetas (se conserva la estructura en la salida)</label>}
          <small>{carpetaOrigen ? `Carpeta: ${carpetaOrigen} · ` : ""}{archivos.length === 0 ? "Elige una carpeta o varios archivos: PDF o documentos de Word, Excel y PowerPoint (también puedes arrastrarlos)" : [nPdf ? `${nPdf} PDF` : "", nOffice ? `${nOffice} de Office` : ""].filter(Boolean).join(" · ") + (entradas.length !== archivos.length ? ` · se procesarán ${entradas.length}` : "")}</small>
          {nOffice > 0 && !conConvertir && (
            <div className="lote-aviso-office"><I n="info" s={14} /> <span>Hay {nOffice} documento(s) de Word, Excel o PowerPoint que no se procesarán con este perfil.</span>
              <button className="secundario" onClick={() => anadir("convertir")} disabled={corriendo}>Añadir «Convertir a PDF» al perfil</button></div>
          )}
          {entradas.length > 0 && <ul className="ed-lista">{entradas.slice(0, 6).map((a) => { const t = tipoOffice(a); return <li key={a}>{t && <span className={`of-tipo of-${t}`}>{t === "word" ? "W" : t === "excel" ? "X" : "P"}</span>}<span title={a}>{nombreArchivo(a)}</span></li>; })}{entradas.length > 6 && <li><small>… y {entradas.length - 6} más</small></li>}</ul>}
        </div>
      </details>

      <details className="sec" open>
        <summary><span>2 · Perfil (qué se hace con cada archivo)</span><I n="down" s={14} className="sec-flecha" /></summary>
        <div className="sec-cuerpo">
          <div className="ed-fila">
            <select value={perfil.id} onChange={(e) => setSel(e.target.value)} disabled={corriendo} aria-label="Perfil">{perfiles.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select>
            <button className="secundario" onClick={nuevo} disabled={corriendo}>Nuevo</button>
            <button className="secundario" onClick={duplicar} disabled={corriendo}>Duplicar</button>
            <button className="secundario" onClick={eliminar} disabled={corriendo || perfiles.length <= 1}><I n="trash" s={14} /></button>
          </div>
          <label>Nombre del perfil<input type="text" value={perfil.nombre} onChange={(e) => actualizar((p) => ({ ...p, nombre: e.target.value }))} disabled={corriendo} /></label>
          <ol className="ed-pasos">
            {perfil.pasos.map((p, i) => (
              <li key={i}>
                <div className="ed-paso-cab"><b>{i + 1}. {NOMBRE_PASO[p.tipo]}</b>
                  <span><button onClick={() => mover(i, -1)} disabled={i === 0 || corriendo} aria-label="Subir"><I n="up" s={14} /></button><button onClick={() => mover(i, 1)} disabled={i === perfil.pasos.length - 1 || corriendo} aria-label="Bajar"><I n="down" s={14} /></button><button onClick={() => actualizar((q) => ({ ...q, pasos: q.pasos.filter((_, k) => k !== i) }))} disabled={corriendo} aria-label="Quitar paso"><I n="x" s={14} /></button></span></div>
                {p.tipo === "convertir" && <div className="ed-rejilla">
                  {infoOffice && (infoOffice.instalado
                    ? <small className="lote-office-ok"><I n="check" s={13} /> Con {infoOffice.version}. Los PDF de la lista pasan este paso sin cambios.</small>
                    : <div className="firma-error">No se ha encontrado Microsoft Office en este equipo: este paso no puede hacerse.</div>)}
                  <label className="ed-check"><input type="checkbox" checked={p.solo_office} onChange={(e) => setPaso(i, { ...p, solo_office: e.target.checked })} /> Procesar solo los documentos de Office (no los PDF que ya hubiera en la carpeta)</label>
                  <label>Excel<select value={p.excel_alcance} onChange={(e) => setPaso(i, { ...p, excel_alcance: e.target.value as "libro" | "hoja" })}><option value="libro">Todo el libro</option><option value="hoja">Solo la hoja activa</option></select></label>
                  <label className="ed-check"><input type="checkbox" checked={p.excel_ajustar} onChange={(e) => setPaso(i, { ...p, excel_ajustar: e.target.checked })} /> Excel: ajustar cada hoja a una página de ancho</label>
                  <label>PowerPoint<select value={p.ppt_salida} onChange={(e) => setPaso(i, { ...p, ppt_salida: e.target.value as SalidaPpt })}><option value="diapositivas">Diapositivas</option><option value="notas">Páginas de notas</option><option value="doc2">Documento · 2 por hoja</option><option value="doc3">Documento · 3 por hoja</option><option value="doc6">Documento · 6 por hoja</option></select></label>
                  <label className="ed-check"><input type="checkbox" checked={p.pdfa} disabled={!!infoOffice && !infoOffice.pdfa} onChange={(e) => setPaso(i, { ...p, pdfa: e.target.checked })} /> PDF/A (Word y PowerPoint)</label>
                  <small>Word crea los marcadores a partir de los títulos. Los documentos con contraseña se saltan con un aviso.</small>
                </div>}
                {p.tipo === "comprimir" && <select value={p.nivel} onChange={(e) => setPaso(i, { ...p, nivel: e.target.value })}><option value="screen">Máxima compresión</option><option value="ebook">Equilibrado (recomendado)</option><option value="printer">Alta calidad</option><option value="prepress">Calidad de imprenta</option></select>}
                {p.tipo === "decorar" && <div className="ed-rejilla">
                  <label>Marca de agua (vacío = ninguna)<input type="text" value={p.marca} onChange={(e) => setPaso(i, { ...p, marca: e.target.value })} placeholder="CONFIDENCIAL" /></label>
                  <label className="ed-check"><input type="checkbox" checked={p.numOn} onChange={(e) => setPaso(i, { ...p, numOn: e.target.checked })} /> Numerar páginas</label>
                  <label>Formato<select value={p.formato} onChange={(e) => setPaso(i, { ...p, formato: e.target.value })} disabled={!p.numOn}><option value="Página {n} de {total}">Página 1 de 10</option><option value="{n} / {total}">1 / 10</option><option value="{n}">1</option></select></label>
                  <label>Posición<select value={p.posicion} onChange={(e) => setPaso(i, { ...p, posicion: e.target.value })} disabled={!p.numOn}><option value="pie-derecha">Pie · derecha</option><option value="pie-centro">Pie · centro</option><option value="cab-derecha">Cabecera · derecha</option></select></label></div>}
                {p.tipo === "metadatos" && <label className="ed-check"><input type="checkbox" checked={p.completo} onChange={(e) => setPaso(i, { ...p, completo: e.target.checked })} /> Limpieza completa (datos, XMP, adjuntos y JavaScript)</label>}
                {p.tipo === "ocr" && <small>Idioma: español. Requiere Tesseract en la carpeta UTILS.</small>}
                {p.tipo === "imprimir" && <div className="ed-rejilla">
                  <label>Impresora<select value={p.impresora} onChange={(e) => setPaso(i, { ...p, impresora: e.target.value })}>
                    <option value="">Predeterminada de Windows</option>
                    {(impresoras ?? []).map((x) => <option key={x.nombre} value={x.nombre}>{x.nombre}{x.predeterminada ? " (predeterminada)" : ""}</option>)}
                    {p.impresora && impresoras && !impresoras.some((x) => x.nombre === p.impresora) && <option value={p.impresora}>{p.impresora} (no encontrada)</option>}
                  </select></label>
                  <label>Copias<input type="number" min={1} max={99} value={p.copias} onChange={(e) => setPaso(i, { ...p, copias: Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1)) })} /></label>
                  <label>Doble cara<select value={p.doble_cara} onChange={(e) => setPaso(i, { ...p, doble_cara: e.target.value })}><option value="auto">Según la impresora</option><option value="no">Una cara</option><option value="largo">Doble cara · borde largo</option><option value="corto">Doble cara · borde corto</option></select></label>
                  <label>Color<select value={p.color} onChange={(e) => setPaso(i, { ...p, color: e.target.value })}><option value="auto">Según la impresora</option><option value="color">Color</option><option value="gris">Blanco y negro</option></select></label>
                  <label>Marca solo en la copia impresa (vacío = ninguna)<input type="text" value={p.marca} onChange={(e) => setPaso(i, { ...p, marca: e.target.value })} placeholder="COPIA" maxLength={40} /></label>
                  <small>Imprime el PDF tal como está en este punto; no lo modifica. Si falla, el archivo se guarda igualmente y se avisa.</small>
                </div>}
              </li>
            ))}
            {perfil.pasos.length === 0 && <li><small>Este perfil no tiene pasos. Añade el primero:</small></li>}
          </ol>
          <div className="ed-fila"><select value="" onChange={(e) => { if (e.target.value) anadir(e.target.value as PasoUI["tipo"]); }} disabled={corriendo} aria-label="Añadir paso"><option value="">＋ Añadir paso…</option>{(Object.keys(NOMBRE_PASO) as PasoUI["tipo"][]).map((t) => <option key={t} value={t} disabled={t === "convertir" && conConvertir}>{NOMBRE_PASO[t]}{t === "convertir" ? " (va siempre el primero)" : ""}</option>)}</select></div>
        </div>
      </details>

      <details className="sec" open>
        <summary><span>3 · Salida</span><I n="down" s={14} className="sec-flecha" /></summary>
        <div className="sec-cuerpo">
          <div className="ed-fila"><input type="text" value={salida} onChange={(e) => { salidaManual.current = true; setSalida(e.target.value); }} placeholder="Carpeta de salida" disabled={corriendo} /><button className="secundario" onClick={elegirSalida} disabled={corriendo}>Cambiar…</button></div>
          <label>Añadir al nombre (opcional)<input type="text" value={sufijo} onChange={(e) => setSufijo(e.target.value)} placeholder="_proc" disabled={corriendo} /></label>
          <small>Los originales no se tocan. Si ya existe un archivo con ese nombre, se añade «(2)».</small>
        </div>
      </details>

      <div className="ed-fila">
        <button className="primario azul" onClick={ejecutar} disabled={!puede}>{corriendo ? "Procesando…" : `Procesar ${entradas.length || ""} archivo(s)`}</button>
        {corriendo && <button className="secundario" onClick={() => { invoke("cancelar_operacion").catch(() => {}); }}>Cancelar</button>}
        {salida && res && <button className="secundario" onClick={() => { invoke("abrir_carpeta", { ruta: salida }).catch(() => {}); }}>Abrir carpeta de salida</button>}
      </div>
      {prog && corriendo && <div className="ed-prog"><div className="ed-prog-barra"><div style={{ width: `${prog.total ? (prog.actual / prog.total) * 100 : 0}%` }} /></div><small>{prog.actual} de {prog.total}{prog.archivo ? ` · ${prog.fase ? prog.fase + ": " : ""}${nombreArchivo(prog.archivo)}` : ""}</small></div>}
      {err && <div className="firma-error">{err}</div>}
      {res && <>
        <div className={`val-resumen ${okN === res.length ? "ok" : okN === 0 ? "error" : "aviso"}`}><I n={okN === res.length ? "check" : "warn"} s={16} /> {okN} de {res.length} procesado(s){ahorro > 0 ? ` · ahorro ${formatoTam(ahorro)}` : ""}</div>
        <ul className="ed-res">{res.map((r) => <li key={r.entrada} className={r.ok ? "ok" : "err"}><I n={r.ok ? "check" : "warn"} s={14} /> <b>{nombreArchivo(r.entrada)}</b> {r.ok ? (esOffice(r.entrada) ? `→ ${nombreArchivo(r.salida)} (${formatoTam(r.tamano_salida)})` : `→ ${formatoTam(r.tamano_entrada)} → ${formatoTam(r.tamano_salida)}`) : r.error}{r.aviso && <small className={`ed-aviso${/No se pudo/.test(r.aviso) ? " mal" : ""}`}> · {r.aviso}</small>}</li>)}</ul>
      </>}
    </div>
  );
}
