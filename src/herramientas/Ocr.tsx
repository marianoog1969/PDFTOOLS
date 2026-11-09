import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { SvgOcr } from "../iconos";
import { amigable, esErrorDll, formatoTamano, guardarUltimaCarpeta, leerUltimaCarpeta, nombreArchivo, rutaConSufijo } from "../util";
import { CabeceraTarjeta, ListaCola, ZonaSoltar, agregarAColaUnica, claseTarjeta, useReportar, useSoltar, type EstadoTarjeta, type ItemCola, type Progreso, type PropsZona } from "./comun";

export default function Ocr({ ctx }: PropsZona) {
  const [cola, setCola] = useState<ItemCola[]>([]);
  const [estado, setEstado] = useState<EstadoTarjeta>("inactivo");
  const [dpi, setDpi] = useState<150 | 300 | 600>(300);
  const [orientacion, setOrientacion] = useState(false);
  const [progreso, setProgreso] = useState<Progreso | null>(null);
  const [indice, setIndice] = useState<number | null>(null);
  const { ocupado, registrar, infosPdf } = ctx;
  const pendientes = cola.filter((it) => it.estado === "pendiente").length;

  useEffect(() => { const p = listen<Progreso>("ocr-progreso", (ev) => setProgreso(ev.payload)); return () => { p.then((c) => c()); }; }, []);
  const fraccion = estado === "procesando" && cola.length > 0
    ? Math.min(1, ((indice ?? 0) + (progreso ? progreso.actual / Math.max(progreso.total, 1) : 0)) / cola.length) : null;
  useReportar(ctx, "ocr", { procesando: estado === "procesando", pendientes, fraccion, etiqueta: progreso ? `OCR · página ${progreso.actual}/${progreso.total}` : "OCR…" });

  function anadir(rutas: string[]) {
    const { cola: nueva, duplicados } = agregarAColaUnica(cola, rutas);
    setCola(nueva);
    if (duplicados.length) registrar("info", `${duplicados.length} archivo(s) ya estaban en OCR`);
    if (rutas.length > duplicados.length) registrar("info", `Añadidos ${rutas.length - duplicados.length} archivo(s) a OCR`);
  }
  useSoltar("ocr", anadir);

  async function elegir() {
    const rutas = await open({ multiple: true, defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!rutas) return;
    guardarUltimaCarpeta(rutas[0]); anadir(rutas);
  }

  const marcar = (idx: number, cambios: Partial<ItemCola>) => setCola((p) => p.map((it, i) => (i === idx ? { ...it, ...cambios } : it)));

  async function procesar() {
    const lista = cola.map((it, i) => ({ ...it, idx: i })).filter((it) => it.estado === "pendiente");
    if (!lista.length) return;
    await ctx.limpiarCancelacion(); ctx.setResumen(null);
    setEstado("procesando");
    let ok = 0, err = 0; let ultima: string | null = null;
    for (const [n, { ruta, idx }] of lista.entries()) {
      setIndice(idx); setProgreso(null);
      marcar(idx, { estado: "procesando", mensaje: undefined });
      if (!await ctx.verificarProteccion([ruta])) { marcar(idx, { estado: "error", mensaje: "PDF protegido" }); err++; continue; }
      const salida = await ctx.rutaDisponible(rutaConSufijo(ruta, "_OCR"));
      if (!salida) { marcar(idx, { estado: "error", mensaje: "cancelado" }); err++; continue; }
      registrar("info", `OCR [${n + 1}/${lista.length}]: ${nombreArchivo(ruta)}`);
      if (!await ctx.comprobarYDesbloquear([ruta, salida])) { marcar(idx, { estado: "error", mensaje: "en uso" }); err++; continue; }
      try {
        await invoke("ocr_pdf", { entrada: ruta, salida, idioma: "spa", dpi, corregirOrientacion: orientacion });
        marcar(idx, { estado: "hecho", mensaje: "listo" });
        registrar("ok", `Generado: ${salida}`); ultima = salida; ok++;
        ctx.guardarEnHistorial({ operacion: "ocr", archivos: [ruta], resultado: salida, ok: true });
      } catch (e) {
        const m = String(e);
        marcar(idx, { estado: "error", mensaje: esErrorDll(m) ? "Error DLL — ver instrucciones" : amigable(m) });
        ctx.manejarError(e); err++;
      }
    }
    setEstado(err > 0 ? "error" : "hecho");
    setProgreso(null); setIndice(null);
    ctx.setResumen({ ok, error: err });
    if (ultima) { if (lista.length === 1) ctx.abrirResultado(ultima); else ctx.resultadosVarios(ultima); }
    if (err === 0) setTimeout(() => { setCola([]); setEstado("inactivo"); }, 2000);
  }

  return (
    <div className={claseTarjeta(ctx, "ocr", cola.length > 0, estado === "procesando")} data-zona="ocr">
      <CabeceraTarjeta icono={<SvgOcr />} color="verde" titulo="OCR" desc="Añade texto buscable a escaneos" estado={estado}
        textoEstadoExtra={estado === "procesando" && pendientes > 0 ? `${cola.length - pendientes}/${cola.length}` : undefined} />
      {cola.length === 0
        ? <ZonaSoltar icono={<SvgOcr />} titulo="Arrastra PDF escaneados aquí" formatos="PDF" boton="Elegir archivos" alPulsar={elegir} deshabilitado={ocupado} />
        : <ListaCola cola={cola} setCola={setCola} ocupado={ocupado} detalle={(it, i) =>
            it.estado === "procesando" && indice === i && progreso ? <span className="mensaje-item">pág. {progreso.actual}/{progreso.total}</span>
            : it.mensaje ? <span className="mensaje-item">{it.mensaje}</span>
            : infosPdf[it.ruta]?.tamano_bytes ? <span className="tamano-archivo">{formatoTamano(infosPdf[it.ruta].tamano_bytes)}</span> : null} />}

      <div className="ocr-opciones-extra">
        <span className="etq-campo">Resolución de lectura <small>· más resolución reconoce mejor letra pequeña, pero tarda más</small></span>
        <div className="opciones-nivel opciones-dpi">
          {([150, 300, 600] as const).map((d) => (
            <button key={d} className={dpi === d ? "activo" : ""} onClick={() => setDpi(d)} disabled={ocupado} type="button"
              title={d === 150 ? "Rápido, calidad básica" : d === 300 ? "Estándar recomendado" : "Alta calidad, más lento"}>
              <span>{d} ppp</span><small>{d === 150 ? "Rápido" : d === 300 ? "Recomendado" : "Máxima calidad"}</small>
            </button>
          ))}
        </div>
        <label className="check-orientacion">
          <input type="checkbox" checked={orientacion} onChange={(e) => setOrientacion(e.target.checked)} disabled={ocupado} />
          Corregir orientación <small>· endereza páginas escaneadas del revés o de lado</small>
        </label>
      </div>

      {progreso && estado === "procesando" && (
        <div className="progreso-ocr">
          <div className="barra-progreso"><div className="barra-progreso-relleno" style={{ width: `${(progreso.actual / Math.max(progreso.total, 1)) * 100}%` }} /></div>
          <span>Archivo {(indice ?? 0) + 1}/{cola.length} · pág. {progreso.actual}/{progreso.total}</span>
        </div>
      )}

      {cola.length > 0 && (
        <div className="fila-botones">
          <button className="secundario" onClick={elegir} disabled={ocupado}>+ Añadir</button>
          <button className="secundario" onClick={() => setCola((p) => p.filter((it) => it.estado !== "error"))} disabled={ocupado} title="Quitar solo los errores">Limpiar errores</button>
          <button className="secundario" onClick={() => setCola([])} disabled={ocupado} title="Limpiar toda la lista">Limpiar todo</button>
          <button className="primario verde" onClick={procesar} disabled={ocupado || pendientes === 0}>Aplicar OCR ({pendientes})</button>
        </div>
      )}
    </div>
  );
}
