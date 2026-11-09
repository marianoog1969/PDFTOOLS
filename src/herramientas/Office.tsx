// Office a PDF: convierte documentos de Word, Excel y PowerPoint con el Office instalado en el equipo.
import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { I } from "../Icono";
import { SvgCarpeta, SvgOffice } from "../iconos";
import { carpetaDe, formatoTamano, guardarLS, guardarUltimaCarpeta, leerLS, leerUltimaCarpeta, nombreArchivo, tipoOffice, unir, type TipoOffice } from "../util";
import { CabeceraTarjeta, ListaCola, ZonaSoltar, agregarAColaUnica, claseTarjeta, useReportar, useSoltar, type EstadoTarjeta, type ItemCola, type PropsZona } from "./comun";

interface InfoOffice { instalado: boolean; version: string; numero: number; word: boolean; excel: boolean; powerpoint: boolean; pdfa: boolean; marcadores: boolean; }
type SalidaPpt = "diapositivas" | "notas" | "doc2" | "doc3" | "doc6";
interface Prefs {
  pdfa: boolean; marcadores: boolean;
  excel_alcance: "libro" | "hoja"; excel_ajustar: boolean;
  ppt_salida: SalidaPpt;
  destino: "misma" | "otra"; carpeta: string; unir: boolean;
}
const CLAVE = "pdftool_office";
const PREFS: Prefs = { pdfa: false, marcadores: true, excel_alcance: "libro", excel_ajustar: false, ppt_salida: "diapositivas", destino: "misma", carpeta: "", unir: false };
const NOMBRE: Record<TipoOffice, string> = { word: "Word", excel: "Excel", powerpoint: "PowerPoint" };
const LETRA: Record<TipoOffice, string> = { word: "W", excel: "X", powerpoint: "P" };
const SALIDAS_PPT: { id: SalidaPpt; nombre: string; desc: string }[] = [
  { id: "diapositivas", nombre: "Diapositivas", desc: "Una diapositiva por página" },
  { id: "notas", nombre: "Páginas de notas", desc: "Diapositiva arriba y las notas del orador debajo" },
  { id: "doc2", nombre: "Documento · 2 por hoja", desc: "Dos diapositivas grandes por página" },
  { id: "doc3", nombre: "Documento · 3 por hoja", desc: "Tres diapositivas con líneas para tomar notas" },
  { id: "doc6", nombre: "Documento · 6 por hoja", desc: "Seis diapositivas pequeñas por página" },
];
const FORMATOS = "Word, Excel y PowerPoint · DOCX, DOC, RTF, ODT, XLSX, XLS, CSV, PPTX, PPT…";
/** Texto corto para la fila de la lista (el completo va en el registro y en la ayuda emergente). */
function corto(m: string): string {
  if (/contraseña/i.test(m)) return "Protegido con contraseña";
  if (/no respondió/i.test(m)) return "Office no respondió";
  if (/cancelada/i.test(m)) return "Cancelado";
  if (/no se ha encontrado microsoft|no está instalado/i.test(m)) return "Programa no instalado";
  if (/no se pudo iniciar/i.test(m)) return "Office no se pudo iniciar";
  return m.length > 48 ? m.slice(0, 46) + "…" : m;
}
const EXTENSIONES = ["docx", "doc", "docm", "dotx", "rtf", "odt", "txt", "xlsx", "xls", "xlsm", "xlsb", "ods", "csv", "pptx", "ppt", "pptm", "ppsx", "pps", "odp"];

export default function Office({ ctx }: PropsZona) {
  const [cola, setCola] = useState<ItemCola[]>([]);
  const [estado, setEstado] = useState<EstadoTarjeta>("inactivo");
  const [info, setInfo] = useState<InfoOffice | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(() => ({ ...PREFS, ...leerLS<Partial<Prefs>>(CLAVE, {}) }));
  const { ocupado, registrar } = ctx;
  const pendientes = cola.filter((it) => it.estado === "pendiente").length;
  const hechos = cola.filter((it) => it.estado === "hecho" || it.estado === "error").length;
  const setPrefs = (c: Partial<Prefs>) => setPrefsState((p) => { const n = { ...p, ...c }; guardarLS(CLAVE, n); return n; });

  useReportar(ctx, "office", {
    procesando: estado === "procesando", pendientes,
    fraccion: estado === "procesando" && cola.length ? hechos / cola.length : null,
    etiqueta: `Convirtiendo a PDF… ${hechos}/${cola.length}`,
  });

  useEffect(() => { invoke<InfoOffice>("info_office").then(setInfo).catch(() => setInfo({ instalado: false, version: "", numero: 0, word: false, excel: false, powerpoint: false, pdfa: false, marcadores: false })); }, []);

  const disponible = (t: TipoOffice) => !!info && (t === "word" ? info.word : t === "excel" ? info.excel : info.powerpoint);
  const tipos = new Set(cola.map((it) => tipoOffice(it.ruta)).filter((t): t is TipoOffice => t !== null));

  function anadir(rutas: string[]) {
    const validas = rutas.filter((r) => tipoOffice(r));
    if (validas.length < rutas.length) registrar("info", `${rutas.length - validas.length} archivo(s) ignorado(s): no son documentos de Office`);
    const { cola: nueva, duplicados } = agregarAColaUnica(cola, validas);
    setCola(nueva);
    if (duplicados.length) registrar("info", `${duplicados.length} documento(s) ya estaban en la lista (omitidos)`);
    if (validas.length > duplicados.length) registrar("info", `Añadidos ${validas.length - duplicados.length} documento(s) a «Office a PDF»`);
  }
  useSoltar("office", anadir);

  async function elegir() {
    const rutas = await open({ multiple: true, defaultPath: leerUltimaCarpeta(), filters: [{ name: "Documentos de Office", extensions: EXTENSIONES }] });
    if (!rutas) return;
    guardarUltimaCarpeta(rutas[0]); anadir(rutas);
  }
  async function elegirCarpeta() {
    const c = await open({ directory: true, defaultPath: prefs.carpeta || leerUltimaCarpeta() });
    if (typeof c === "string") setPrefs({ carpeta: c, destino: "otra" });
  }

  const marcar = (idx: number, cambios: Partial<ItemCola>) => setCola((p) => p.map((it, i) => (i === idx ? { ...it, ...cambios } : it)));
  const carpetaSalida = (ruta: string) => (prefs.destino === "otra" && prefs.carpeta ? prefs.carpeta : carpetaDe(ruta));
  const pdfDe = (ruta: string) => unir(carpetaSalida(ruta), nombreArchivo(ruta).replace(/\.[^.]+$/, "") + ".pdf");

  async function procesar() {
    const lista = cola.map((it, i) => ({ ...it, idx: i })).filter((it) => it.estado === "pendiente");
    if (!lista.length || !info?.instalado) return;
    await ctx.limpiarCancelacion(); ctx.setResumen(null);
    setEstado("procesando");
    const opciones = { pdfa: prefs.pdfa && info.pdfa, marcadores: prefs.marcadores && info.marcadores, excel_alcance: prefs.excel_alcance, excel_ajustar: prefs.excel_ajustar, ppt_salida: prefs.ppt_salida, tiempo_max: 120 };
    let ok = 0, err = 0; const creados: string[] = [];
    for (const [n, { ruta, idx }] of lista.entries()) {
      const tipo = tipoOffice(ruta)!;
      if (!disponible(tipo)) { marcar(idx, { estado: "error", mensaje: `${NOMBRE[tipo]} no está instalado en este equipo` }); err++; continue; }
      marcar(idx, { estado: "procesando", mensaje: `Abriendo en ${NOMBRE[tipo]}…` });
      const salida = await ctx.rutaDisponible(pdfDe(ruta));
      if (!salida) { marcar(idx, { estado: "error", mensaje: "cancelado" }); err++; continue; }
      if (!await ctx.comprobarYDesbloquear([salida])) { marcar(idx, { estado: "error", mensaje: "el PDF de destino está abierto en otro programa" }); err++; continue; }
      registrar("info", `Convirtiendo con ${NOMBRE[tipo]} [${n + 1}/${lista.length}]: ${nombreArchivo(ruta)}`);
      try {
        const bytes = await invoke<number>("convertir_office", { entrada: ruta, salida, opciones });
        const msg = `PDF creado · ${formatoTamano(bytes)}`;
        marcar(idx, { estado: "hecho", mensaje: msg });
        registrar("ok", `${nombreArchivo(ruta)} → ${nombreArchivo(salida)} (${formatoTamano(bytes)})`);
        creados.push(salida); ok++;
        ctx.guardarEnHistorial({ operacion: "office", archivos: [ruta], resultado: salida, ok: true });
      } catch (e) {
        const m = String(e);
        marcar(idx, { estado: "error", mensaje: m });
        registrar("err", `${nombreArchivo(ruta)}: ${m}`); err++;
        if (/cancelada/i.test(m)) {
          // marcar el resto como cancelado y parar
          lista.slice(n + 1).forEach((r) => marcar(r.idx, { estado: "error", mensaje: "cancelado" }));
          err += lista.length - n - 1;
          break;
        }
      }
    }

    // Unir todos los PDF creados en uno solo (los sueltos se conservan)
    let unido: string | null = null;
    if (prefs.unir && creados.length >= 2) {
      const destino = await ctx.rutaDisponible(unir(carpetaDe(creados[0]), "Documentos convertidos.pdf"));
      if (destino) {
        try {
          await invoke("combinar_pdfs", { rutas: creados, salida: destino });
          registrar("ok", `Unidos ${creados.length} PDF en ${nombreArchivo(destino)}`);
          unido = destino;
          ctx.guardarEnHistorial({ operacion: "combinar", archivos: creados, resultado: destino, ok: true });
        } catch (e) { ctx.manejarError(e); }
      }
    }

    setEstado(err > 0 ? "error" : "hecho");
    ctx.setResumen({ ok, error: err });
    const ultimo = unido ?? creados[creados.length - 1];
    if (ultimo) { if (unido || creados.length === 1) ctx.abrirResultado(ultimo); else ctx.resultadosVarios(ultimo); }
    if (err === 0) setTimeout(() => { setCola([]); setEstado("inactivo"); }, 2000);
  }

  const sinOffice = info !== null && !info.instalado;
  const faltan = info?.instalado ? (["word", "excel", "powerpoint"] as TipoOffice[]).filter((t) => !disponible(t)) : [];
  const verTodo = tipos.size === 0;

  return (
    <div className={claseTarjeta(ctx, "office", cola.length > 0, estado === "procesando")} data-zona="office">
      <CabeceraTarjeta icono={<SvgOffice />} color="azul" titulo="Office a PDF" desc="Word, Excel y PowerPoint con el Office de este equipo" estado={estado}
        textoEstadoExtra={estado === "procesando" && pendientes > 0 ? `${cola.length - pendientes}/${cola.length}` : undefined} />

      {info === null ? <div className="of-info"><span className="of-girando" /> Buscando Microsoft Office…</div>
        : sinOffice ? (
          <div className="of-info error"><I n="warn" s={15} /> <span><b>No se ha encontrado Microsoft Office en este equipo.</b> Esta herramienta usa Word, Excel y PowerPoint instalados para convertir; sin ellos no puede funcionar. Si Office sí está instalado, ábrelo una vez a mano (para que termine de configurarse) y vuelve a abrir PDF Tool.</span></div>
        ) : (
          <div className="of-info ok"><I n="check" s={15} /> <span>Usando <b>{info.version}</b>{faltan.length ? <> · <span className="of-falta">sin {faltan.map((t) => NOMBRE[t]).join(" ni ")}</span></> : " · Word, Excel y PowerPoint"}</span></div>
        )}

      {cola.length === 0
        ? <ZonaSoltar icono={<SvgOffice />} titulo="Arrastra documentos de Office aquí" formatos={FORMATOS} boton="Elegir documentos" alPulsar={elegir} deshabilitado={ocupado || sinOffice} />
        : <ListaCola cola={cola} setCola={setCola} ocupado={ocupado} detalle={(it) => {
            const t = tipoOffice(it.ruta)!;
            return <>
              <span className={`of-tipo of-${t}`} title={NOMBRE[t]}>{LETRA[t]}</span>
              {it.mensaje && <span className="mensaje-item of-msg" title={it.mensaje}>{it.estado === "error" ? corto(it.mensaje) : it.mensaje}</span>}
            </>;
          }} />}

      {!sinOffice && <div className="of-opciones">
        {(verTodo || tipos.has("word")) && (
          <fieldset className="of-grupo" disabled={ocupado}>
            <legend><span className="of-tipo of-word">W</span> Word</legend>
            <label className="of-check" title={info && !info.marcadores ? "Necesita Office 2010 o posterior" : undefined}>
              <input type="checkbox" checked={prefs.marcadores && !!info?.marcadores} disabled={!!info && !info.marcadores} onChange={(e) => setPrefs({ marcadores: e.target.checked })} />
              Crear marcadores a partir de los títulos <small>(índice navegable en el PDF)</small>
            </label>
          </fieldset>
        )}
        {(verTodo || tipos.has("excel")) && (
          <fieldset className="of-grupo" disabled={ocupado}>
            <legend><span className="of-tipo of-excel">X</span> Excel</legend>
            <div className="modo-comp" role="tablist">
              <button type="button" className={prefs.excel_alcance === "libro" ? "activo" : ""} onClick={() => setPrefs({ excel_alcance: "libro" })}>Todo el libro</button>
              <button type="button" className={prefs.excel_alcance === "hoja" ? "activo" : ""} onClick={() => setPrefs({ excel_alcance: "hoja" })}>Solo la hoja activa</button>
            </div>
            <label className="of-check">
              <input type="checkbox" checked={prefs.excel_ajustar} onChange={(e) => setPrefs({ excel_ajustar: e.target.checked })} />
              Ajustar cada hoja a una página de ancho <small>(evita tablas partidas en varias hojas)</small>
            </label>
          </fieldset>
        )}
        {(verTodo || tipos.has("powerpoint")) && (
          <fieldset className="of-grupo" disabled={ocupado}>
            <legend><span className="of-tipo of-powerpoint">P</span> PowerPoint</legend>
            <div className="of-ppt">
              {SALIDAS_PPT.map((s) => (
                <button key={s.id} type="button" className={prefs.ppt_salida === s.id ? "activo" : ""} onClick={() => setPrefs({ ppt_salida: s.id })} title={s.desc}>
                  <MiniPpt tipo={s.id} /><span>{s.nombre}</span>
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <fieldset className="of-grupo" disabled={ocupado}>
          <legend><I n="file" s={13} /> Resultado</legend>
          <div className="of-destino">
            <label className="of-check"><input type="radio" name="of-destino" checked={prefs.destino === "misma"} onChange={() => setPrefs({ destino: "misma" })} /> Junto a cada documento</label>
            <label className="of-check"><input type="radio" name="of-destino" checked={prefs.destino === "otra"} onChange={() => (prefs.carpeta ? setPrefs({ destino: "otra" }) : elegirCarpeta())} /> En otra carpeta</label>
            {prefs.destino === "otra" && <button type="button" className="of-carpeta" onClick={elegirCarpeta} title={prefs.carpeta}><SvgCarpeta /> {prefs.carpeta ? nombreArchivo(prefs.carpeta) : "Elegir…"}</button>}
          </div>
          <label className="of-check" title={info && !info.pdfa ? "Necesita Office 2010 o posterior" : undefined}>
            <input type="checkbox" checked={prefs.pdfa && !!info?.pdfa} disabled={!!info && !info.pdfa} onChange={(e) => setPrefs({ pdfa: e.target.checked })} />
            PDF/A para archivo <small>(conservación a largo plazo{tipos.has("excel") || verTodo ? "; en Excel no está disponible y se crea PDF normal" : ""})</small>
          </label>
          <label className="of-check">
            <input type="checkbox" checked={prefs.unir} onChange={(e) => setPrefs({ unir: e.target.checked })} />
            Unir todo en un solo PDF al terminar <small>(«Documentos convertidos.pdf»; los PDF sueltos también se guardan)</small>
          </label>
        </fieldset>
        <p className="nota-nivel">El documento original no se modifica: se abre una copia en solo lectura, con las macros desactivadas, y el PDF sale igual que con <i>Archivo → Guardar como → PDF</i>. Los documentos con contraseña de apertura se saltan con un aviso.</p>
      </div>}

      {cola.length > 0 && (
        <div className="fila-botones">
          <button className="secundario" onClick={elegir} disabled={ocupado}>+ Añadir</button>
          <button className="secundario" onClick={() => setCola((p) => p.filter((it) => it.estado !== "error"))} disabled={ocupado} title="Quitar solo los errores">Limpiar errores</button>
          <button className="secundario" onClick={() => setCola([])} disabled={ocupado} title="Limpiar toda la lista">Limpiar todo</button>
          <button className="primario azul" onClick={procesar} disabled={ocupado || pendientes === 0 || !info?.instalado}>Convertir a PDF ({pendientes})</button>
        </div>
      )}
    </div>
  );
}

/** Miniatura de la distribución de página de cada salida de PowerPoint. */
function MiniPpt({ tipo }: { tipo: SalidaPpt }) {
  const d = (x: number, y: number, w: number, h: number, k: number) => <rect key={k} x={x} y={y} width={w} height={h} rx="0.8" className="of-mini-d" />;
  const l = (x: number, y: number, w: number, k: number) => <rect key={k} x={x} y={y} width={w} height="1.1" rx=".5" className="of-mini-l" />;
  let c: ReactNode[] = [];
  if (tipo === "diapositivas") return <svg width="34" height="26" viewBox="0 0 34 26"><rect x="1" y="1" width="32" height="24" rx="2" className="of-mini-p" />{d(4, 4, 26, 18, 0)}</svg>;
  if (tipo === "notas") c = [d(5, 3, 14, 9, 0), l(4, 15, 16, 1), l(4, 18, 16, 2), l(4, 21, 11, 3)];
  if (tipo === "doc2") c = [d(5, 3, 14, 9, 0), d(5, 14, 14, 9, 1)];
  if (tipo === "doc3") c = [0, 1, 2].flatMap((i) => [d(3, 2.5 + i * 7.5, 8, 5.5, i * 3), l(13, 4 + i * 7.5, 8, i * 3 + 1), l(13, 6.5 + i * 7.5, 8, i * 3 + 2)]);
  if (tipo === "doc6") c = [0, 1, 2].flatMap((i) => [d(3.5, 2.5 + i * 7.5, 7.5, 5.5, i * 2), d(13, 2.5 + i * 7.5, 7.5, 5.5, i * 2 + 1)]);
  return <svg width="26" height="26" viewBox="0 0 24 26"><rect x="1" y="0.5" width="22" height="25" rx="2" className="of-mini-p" />{c}</svg>;
}
