import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { I } from "../Icono";
import VisorPdf from "../VisorPdf";
import { SvgDividir } from "../iconos";
import { calcularRangosDividir, guardarUltimaCarpeta, leerUltimaCarpeta, nombreArchivo } from "../util";
import { CabeceraTarjeta, Candado, ZonaSoltar, claseTarjeta, useReportar, useSoltar, type EstadoTarjeta, type Progreso, type PropsZona } from "./comun";

export default function Dividir({ ctx }: PropsZona) {
  const [entrada, setEntrada] = useState<string | null>(null);
  const [estado, setEstado] = useState<EstadoTarjeta>("inactivo");
  const [modo, setModo] = useState<"cada" | "puntos">("cada");
  const [cadaN, setCadaN] = useState("10");
  const [puntos, setPuntos] = useState("");
  const [progreso, setProgreso] = useState<Progreso | null>(null);
  const { ocupado, registrar } = ctx;
  const info = entrada ? ctx.infosPdf[entrada] : null;
  const usable = !!info && !info.protegido && info.paginas > 0;
  const calculo = usable ? calcularRangosDividir(modo, cadaN, puntos, info.paginas) : { rangos: [] as [number, number][], error: undefined as string | undefined };

  useEffect(() => { const p = listen<Progreso>("dividir-progreso", (ev) => setProgreso(ev.payload)); return () => { p.then((c) => c()); }; }, []);
  useReportar(ctx, "dividir", {
    procesando: estado === "procesando", pendientes: 0,
    fraccion: estado === "procesando" && progreso ? progreso.actual / Math.max(progreso.total, 1) : null,
    etiqueta: progreso ? `Dividiendo… ${progreso.actual}/${progreso.total}` : "Dividiendo…",
  });

  function cargar(ruta: string) { setEntrada(ruta); setEstado("inactivo"); setPuntos(""); ctx.cargarInfoPdf([ruta]); }
  useSoltar("dividir", (rutas) => { cargar(rutas[0]); registrar("info", `Archivo listo para dividir: ${nombreArchivo(rutas[0])}`); });

  async function elegir() {
    const ruta = await open({ defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!ruta || Array.isArray(ruta)) return;
    guardarUltimaCarpeta(ruta); cargar(ruta);
  }

  async function dividir() {
    if (!entrada || calculo.rangos.length === 0) return;
    if (!await ctx.verificarProteccion([entrada])) return;
    await ctx.limpiarCancelacion();
    setEstado("procesando"); setProgreso(null);
    registrar("info", `Dividiendo ${nombreArchivo(entrada)} en ${calculo.rangos.length} parte(s)`);
    try {
      const generados = await invoke<string[]>("dividir_pdf", { entrada, rangos: calculo.rangos });
      setEstado("hecho");
      registrar("ok", `Generado(s) ${generados.length} archivo(s)`);
      ctx.guardarEnHistorial({ operacion: "dividir", archivos: [entrada], resultado: generados[0], ok: true });
      if (generados.length === 1) ctx.abrirResultado(generados[0]); else ctx.resultadosVarios(generados[0]);
    } catch (e) {
      setEstado("error");
      if (String(e).includes("Operación cancelada")) registrar("info", "División cancelada"); else ctx.manejarError(e);
    } finally { setProgreso(null); }
  }

  const marcadas = new Set(calculo.rangos.slice(1).map((r) => r[0]));

  return (
    <div className={claseTarjeta(ctx, "dividir", !!entrada, estado === "procesando")} data-zona="dividir">
      <CabeceraTarjeta icono={<SvgDividir />} color="naranja" titulo="Dividir PDF" desc="En varios archivos, cada N páginas o por puntos concretos" estado={estado} />
      {!entrada ? (
        <ZonaSoltar icono={<SvgDividir />} titulo="Arrastra un PDF aquí" formatos="PDF" boton="Elegir archivo" alPulsar={elegir} deshabilitado={ocupado} />
      ) : (
        <>
          <div className="chip-archivo">
            <span className="nombre" title={entrada}>{nombreArchivo(entrada)}</span>
            {info?.protegido && <Candado />}
            {usable && <span className="num-paginas">{info.paginas}p</span>}
            <button className="quitar" onClick={() => { setEntrada(null); setEstado("inactivo"); setPuntos(""); }} disabled={ocupado} aria-label="Quitar archivo">×</button>
          </div>
          {usable && (
            <VisorPdf ruta={entrada} total={info.paginas} modo="dividir" marcadas={marcadas} deshabilitado={ocupado}
              onToggle={(n) => { const set = new Set(marcadas); if (set.has(n)) set.delete(n); else set.add(n); setModo("puntos"); setPuntos([...set].sort((x, y) => x - y).join(", ")); }} />
          )}
          <span className="etq-campo">Cómo dividir</span>
          <div className="modo-dividir">
            <label className={`opcion-modo${modo === "cada" ? " activa" : ""}`}>
              <input type="radio" name="modoDividir" checked={modo === "cada"} onChange={() => setModo("cada")} disabled={ocupado} /> Cada N páginas
            </label>
            <label className={`opcion-modo${modo === "puntos" ? " activa" : ""}`}>
              <input type="radio" name="modoDividir" checked={modo === "puntos"} onChange={() => setModo("puntos")} disabled={ocupado} /> En páginas concretas
            </label>
          </div>
          <div className="grupo-rango">
            {modo === "cada"
              ? <input type="number" min={1} className="input-rango" style={{ maxWidth: 140 }} value={cadaN} onChange={(e) => setCadaN(e.target.value)} placeholder="Ej: 10" disabled={ocupado} aria-label="Páginas por parte" />
              : <input className={`input-rango${puntos.trim() ? (calculo.error ? " rango-error" : " rango-ok") : ""}`} value={puntos} onChange={(e) => setPuntos(e.target.value)} disabled={ocupado}
                  placeholder={usable ? `Ej: 5, 12  (total: ${info.paginas}p)` : "Ej: 5, 12"} aria-label="Páginas donde empieza cada parte" />}
          </div>
          {calculo.error && <span className="error-rango">{calculo.error}</span>}
          {!calculo.error && calculo.rangos.length > 0 && (
            <span className="exito-rango"><I n="check" s={13} /> Se generarán {calculo.rangos.length} archivo(s): {calculo.rangos.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ")}</span>
          )}
          {estado === "procesando" && progreso && (
            <div className="progreso-ocr">
              <div className="barra-progreso"><div className="barra-progreso-relleno" style={{ width: `${(progreso.actual / Math.max(progreso.total, 1)) * 100}%` }} /></div>
              <span>Generando parte {progreso.actual}/{progreso.total}</span>
            </div>
          )}
          <div className="fila-botones">
            <button className="secundario" onClick={elegir} disabled={ocupado}>Cambiar archivo</button>
            <button className="primario naranja" onClick={dividir} disabled={ocupado || calculo.rangos.length === 0 || !!calculo.error}>Dividir PDF</button>
          </div>
        </>
      )}
    </div>
  );
}
