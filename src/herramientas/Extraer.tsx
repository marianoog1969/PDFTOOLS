import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { I } from "../Icono";
import VisorPdf from "../VisorPdf";
import { SvgExtraer } from "../iconos";
import { aRango, formatoTamano, guardarUltimaCarpeta, leerUltimaCarpeta, nombreArchivo, rangoAPaginas, rutaConSufijo, validarRangoPaginas } from "../util";
import { CabeceraTarjeta, Candado, ZonaSoltar, claseTarjeta, useReportar, useSoltar, type EstadoTarjeta, type PropsZona } from "./comun";

export default function Extraer({ ctx }: PropsZona) {
  const [entrada, setEntrada] = useState<string | null>(null);
  const [estado, setEstado] = useState<EstadoTarjeta>("inactivo");
  const [rango, setRango] = useState("");
  const { ocupado, registrar } = ctx;
  const info = entrada ? ctx.infosPdf[entrada] : null;
  const usable = !!info && !info.protegido && info.paginas > 0;
  const validacion = usable && rango.trim() ? validarRangoPaginas(rango, info.paginas) : null;

  useReportar(ctx, "extraer", { procesando: estado === "procesando", pendientes: 0, fraccion: null, etiqueta: "Extrayendo páginas…" });

  function cargar(ruta: string) { setEntrada(ruta); setEstado("inactivo"); setRango(""); ctx.cargarInfoPdf([ruta]); }
  useSoltar("extraer", (rutas) => { cargar(rutas[0]); registrar("info", `Archivo listo para extraer: ${nombreArchivo(rutas[0])}`); });

  async function elegir() {
    const ruta = await open({ defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!ruta || Array.isArray(ruta)) return;
    guardarUltimaCarpeta(ruta); cargar(ruta);
  }

  async function extraer() {
    if (!entrada || !rango.trim()) return;
    await ctx.limpiarCancelacion();
    if (!await ctx.verificarProteccion([entrada])) return;
    const salida = await ctx.rutaDisponible(rutaConSufijo(entrada, `_pags_${rango.replace(/\s/g, "").replace(/,/g, "-")}`));
    if (!salida) return;
    setEstado("procesando");
    registrar("info", `Extrayendo [${rango}] de ${nombreArchivo(entrada)}`);
    try {
      await invoke("extraer_paginas", { entrada, rango, salida });
      setEstado("hecho"); registrar("ok", `Generado: ${salida}`);
      ctx.guardarEnHistorial({ operacion: "extraer", archivos: [entrada], resultado: salida, ok: true });
      ctx.abrirResultado(salida);
    } catch (e) { setEstado("error"); ctx.manejarError(e); }
  }

  return (
    <div className={claseTarjeta(ctx, "extraer", !!entrada, estado === "procesando")} data-zona="extraer">
      <CabeceraTarjeta icono={<SvgExtraer />} color="morado" titulo="Extraer páginas" desc="Saca un rango de páginas como PDF nuevo" estado={estado} />
      {!entrada ? (
        <ZonaSoltar icono={<SvgExtraer />} titulo="Arrastra un PDF aquí" formatos="PDF" boton="Elegir archivo" alPulsar={elegir} deshabilitado={ocupado} />
      ) : (
        <>
          <div className="chip-archivo">
            <span className="nombre" title={entrada}>{nombreArchivo(entrada)}</span>
            {info?.protegido && <Candado />}
            {usable && <span className="num-paginas">{info.paginas}p</span>}
            {info && info.tamano_bytes > 0 && <span className="tamano-archivo">{formatoTamano(info.tamano_bytes)}</span>}
            <button className="quitar" onClick={() => { setEntrada(null); setEstado("inactivo"); setRango(""); }} disabled={ocupado} aria-label="Quitar archivo">×</button>
          </div>
          {usable && (
            <VisorPdf ruta={entrada} total={info.paginas} modo="extraer" marcadas={rangoAPaginas(rango, info.paginas)} deshabilitado={ocupado}
              onToggle={(n) => { const set = rangoAPaginas(rango, info.paginas); if (set.has(n)) set.delete(n); else set.add(n); setRango(aRango([...set])); }} />
          )}
          <div className="grupo-rango">
            <label className="etq-campo" htmlFor="rango-extraer">Páginas que quieres extraer <small>· o márcalas en las miniaturas</small></label>
            <input id="rango-extraer" type="text" value={rango} onChange={(e) => setRango(e.target.value)} disabled={ocupado}
              className={`input-rango${validacion ? (validacion.ok ? " rango-ok" : " rango-error") : ""}`}
              placeholder={usable ? `Ej: 1-3, 5, 7-9  (total: ${info.paginas}p)` : "Ej: 1-3, 5, 7-9"} />
            {validacion?.error && <span className="error-rango">{validacion.error}</span>}
            {validacion?.ok && <span className="exito-rango"><I n="check" s={13} /> {validacion.n} página(s) seleccionada(s)</span>}
            <div className="rango-ayuda">
              <span><strong>1-5</strong> páginas 1 a 5</span>
              <span><strong>3</strong> solo página 3</span>
              <span><strong>1-3, 7, 10-12</strong> combinado</span>
            </div>
          </div>
          <div className="fila-botones">
            <button className="secundario" onClick={elegir} disabled={ocupado}>Cambiar archivo</button>
            <button className="primario morado" onClick={extraer} disabled={ocupado || !rango.trim() || (validacion !== null && !validacion.ok)}>Extraer páginas</button>
          </div>
        </>
      )}
    </div>
  );
}
