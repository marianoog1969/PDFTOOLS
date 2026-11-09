import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { I } from "../Icono";
import { SvgComprimir } from "../iconos";
import { amigable, esErrorDll, formatoTamano, guardarUltimaCarpeta, leerUltimaCarpeta, nombreArchivo, rutaConSufijo } from "../util";
import { CabeceraTarjeta, ListaCola, ZonaSoltar, agregarAColaUnica, claseTarjeta, useReportar, useSoltar, type EstadoTarjeta, type ItemCola, type PropsZona } from "./comun";

type NivelCompresion = "screen" | "ebook" | "printer" | "prepress";
const ORDEN_NIVELES: NivelCompresion[] = ["screen", "ebook", "printer", "prepress"];
const NIVELES: Record<NivelCompresion, { nombre: string; corto: string; desc: string }> = {
  screen: { nombre: "Máxima compresión", corto: "Mínimo", desc: "Compresión extrema: archivo muy pequeño (suele quedar en un 10-30 % del original). Imágenes a 72 ppp y calidad baja: se lee bien en pantalla pero se ve borroso al ampliar o imprimir. Ideal para enviar por correo o subir a una web." },
  ebook: { nombre: "Equilibrada (recomendada)", corto: "Equilibrada", desc: "Buena compresión con buena calidad (suele quedar en un 30-50 % del original). Imágenes a 150 ppp: texto nítido, suficiente para leer en pantalla e imprimir documentos normales. Lo más adecuado para la mayoría de PDF y escaneos." },
  printer: { nombre: "Buena calidad", corto: "Buena calidad", desc: "Poca compresión, alta calidad (suele quedar en un 60-80 % del original). Imágenes hasta 200 ppp con calidad alta, aptas para imprimir. Si el PDF no se puede reducir, se conserva el original." },
  prepress: { nombre: "Mejor calidad", corto: "Mejor calidad", desc: "Sin pérdida apreciable de calidad y sin tocar las imágenes: el archivo apenas se reduce. Para imprenta o archivo definitivo." },
};
const NOMBRES_RESULTADO: Record<string, string> = { printer: "Buena calidad", ebook: "Equilibrada", screen: "Mínimo", extremo: "Compresión extrema", original: "sin cambios" };
interface Analisis { tam: number; tam_imagenes: number; n_imagenes: number; ppp_max: number; estimado: number[]; }
interface ResultadoComp { tamano_entrada: number; tamano_salida: number; nivel: string; cumple: boolean; }

export default function Comprimir({ ctx }: PropsZona) {
  const [cola, setCola] = useState<ItemCola[]>([]);
  const [estado, setEstado] = useState<EstadoTarjeta>("inactivo");
  const [nivel, setNivel] = useState<NivelCompresion>("ebook");
  const [modo, setModo] = useState<"nivel" | "tamano">("nivel");
  const [maxMB, setMaxMB] = useState("2");
  const [analisis, setAnalisis] = useState<Record<string, Analisis | null>>({});
  const { ocupado, registrar, infosPdf } = ctx;
  const pendientes = cola.filter((it) => it.estado === "pendiente").length;
  const hechos = cola.filter((it) => it.estado === "hecho" || it.estado === "error").length;

  useReportar(ctx, "comprimir", {
    procesando: estado === "procesando", pendientes,
    fraccion: estado === "procesando" && cola.length ? hechos / cola.length : null,
    etiqueta: `Comprimiendo… ${hechos}/${cola.length}`,
  });

  // Estimación previa del tamaño tras comprimir (solo lee el PDF, no comprime)
  useEffect(() => {
    cola.forEach((it) => {
      if (it.ruta in analisis) return;
      setAnalisis((a) => ({ ...a, [it.ruta]: null }));
      invoke<Analisis>("analizar_compresion", { ruta: it.ruta })
        .then((r) => setAnalisis((a) => ({ ...a, [it.ruta]: r })))
        .catch(() => setAnalisis((a) => ({ ...a, [it.ruta]: null })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al cambiar la cola
  }, [cola]);

  function anadir(rutas: string[]) {
    const { cola: nueva, duplicados } = agregarAColaUnica(cola, rutas);
    setCola(nueva);
    if (duplicados.length) registrar("info", `${duplicados.length} archivo(s) ya estaban en Comprimir (omitidos)`);
    if (rutas.length > duplicados.length) registrar("info", `Añadidos ${rutas.length - duplicados.length} archivo(s) a Comprimir`);
  }
  useSoltar("comprimir", anadir);

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
      marcar(idx, { estado: "procesando", mensaje: undefined });
      if (!await ctx.verificarProteccion([ruta])) { marcar(idx, { estado: "error", mensaje: "PDF protegido" }); err++; continue; }
      const salida = await ctx.rutaDisponible(rutaConSufijo(ruta, "_compressed"));
      if (!salida) { marcar(idx, { estado: "error", mensaje: "cancelado" }); err++; continue; }
      registrar("info", modo === "tamano" ? `Comprimiendo hasta ${maxMB} MB [${n + 1}/${lista.length}]: ${nombreArchivo(ruta)}` : `Comprimiendo (${NIVELES[nivel].nombre}) [${n + 1}/${lista.length}]: ${nombreArchivo(ruta)}`);
      if (!await ctx.comprobarYDesbloquear([ruta, salida])) { marcar(idx, { estado: "error", mensaje: "en uso" }); err++; continue; }
      try {
        const limiteBytes = Math.round((parseFloat(maxMB.replace(",", ".")) || 0) * 1024 * 1024);
        const res = modo === "tamano"
          ? await invoke<ResultadoComp>("comprimir_a_tamano", { entrada: ruta, salida, maxBytes: limiteBytes })
          : await invoke<ResultadoComp>("comprimir_pdf", { entrada: ruta, salida, nivel });
        const red = res.tamano_entrada > 0 ? Math.round((1 - res.tamano_salida / res.tamano_entrada) * 100) : 0;
        let msg = res.tamano_salida >= res.tamano_entrada ? `${formatoTamano(res.tamano_entrada)} · ya estaba optimizado, se conserva el original` : `${formatoTamano(res.tamano_entrada)} → ${formatoTamano(res.tamano_salida)} (-${Math.abs(red)}%)`;
        if (modo === "tamano") {
          if (res.nivel === "original") msg = `${formatoTamano(res.tamano_entrada)} · ya cumplía el límite, sin cambios`;
          else if (res.cumple) msg += ` · nivel «${NOMBRES_RESULTADO[res.nivel] ?? res.nivel}»`;
          else msg += ` · no se llegó a ${maxMB} MB; es lo mínimo posible`;
        }
        marcar(idx, { estado: "hecho", mensaje: msg });
        registrar("ok", `${nombreArchivo(ruta)}: ${msg}`); ultima = salida; ok++;
        ctx.guardarEnHistorial({ operacion: "comprimir", archivos: [ruta], resultado: salida, ok: true });
      } catch (e) {
        const m = String(e);
        marcar(idx, { estado: "error", mensaje: esErrorDll(m) ? "Error DLL — ver instrucciones" : amigable(m) });
        ctx.manejarError(e); err++;
      }
    }
    setEstado(err > 0 ? "error" : "hecho");
    ctx.setResumen({ ok, error: err });
    if (ultima) { if (lista.length === 1) ctx.abrirResultado(ultima); else ctx.resultadosVarios(ultima); }
    if (err === 0) setTimeout(() => { setCola([]); setEstado("inactivo"); }, 2000);
  }

  const pend = cola.filter((it) => it.estado === "pendiente" && analisis[it.ruta]);

  return (
    <div className={claseTarjeta(ctx, "comprimir", cola.length > 0, estado === "procesando")} data-zona="comprimir">
      <CabeceraTarjeta icono={<SvgComprimir />} color="naranja" titulo="Comprimir" desc="Reduce el tamaño · ideal para escaneos" estado={estado}
        textoEstadoExtra={estado === "procesando" && pendientes > 0 ? `${cola.length - pendientes}/${cola.length}` : undefined} />
      {cola.length === 0
        ? <ZonaSoltar icono={<SvgComprimir />} titulo="Arrastra uno o varios PDF aquí" formatos="PDF" boton="Elegir archivos" alPulsar={elegir} deshabilitado={ocupado} />
        : <ListaCola cola={cola} setCola={setCola} ocupado={ocupado} detalle={(it) => it.mensaje
            ? <span className="mensaje-item">{it.mensaje}</span>
            : infosPdf[it.ruta]?.tamano_bytes ? <span className="tamano-archivo">{formatoTamano(infosPdf[it.ruta].tamano_bytes)}</span> : null} />}

      <div className="modo-comp" role="tablist">
        <button type="button" className={modo === "nivel" ? "activo" : ""} onClick={() => setModo("nivel")} disabled={ocupado}>Por calidad</button>
        <button type="button" className={modo === "tamano" ? "activo" : ""} onClick={() => setModo("tamano")} disabled={ocupado}>Por tamaño máximo</button>
      </div>

      {modo === "tamano" ? (() => {
        const limite = Math.max(0, parseFloat(maxMB.replace(",", ".")) || 0) * 1024 * 1024;
        // niveles de mayor a menor calidad: printer, ebook, screen, extremo (≈ 60 % del Mínimo)
        const prevision = (a: Analisis) => {
          if (a.tam <= limite) return { ok: true, txt: "ya cumple, no hace falta comprimir" };
          const e = [a.estimado[2], a.estimado[1], a.estimado[0], a.estimado[0] * 0.6];
          const nombres = ["Buena calidad", "Equilibrada", "Mínimo", "Compresión extrema"];
          const j = e.findIndex((v) => v <= limite * 1.15);
          return j === -1 ? { ok: false, txt: `puede que no se alcance (mínimo estimado ≈ ${formatoTamano(e[3])})` } : { ok: true, txt: `se conseguiría con «${nombres[j]}»` };
        };
        return (
          <div className="tamano-comp">
            <label>Cada archivo debe pesar como máximo
              <input type="text" inputMode="decimal" value={maxMB} onChange={(e) => setMaxMB(e.target.value)} disabled={ocupado} /> MB
            </label>
            <div className="chips-tamano">
              {["1", "2", "5", "10", "20"].map((v) => <button key={v} type="button" className={maxMB === v ? "activo" : ""} onClick={() => setMaxMB(v)} disabled={ocupado}>{v} MB</button>)}
            </div>
            {limite <= 0 && <div className="aviso-tamano">Escribe un tamaño máximo mayor que 0.</div>}
            {limite > 0 && pend.map((it) => { const a = analisis[it.ruta]!; const r = prevision(a); return (
              <div key={it.ruta} className={`prev-tamano ${r.ok ? "ok" : "no"}`}><I n={r.ok ? "check" : "warn"} s={13} /> <b>{nombreArchivo(it.ruta)}</b> ({formatoTamano(a.tam)}): {r.txt}</div>
            ); })}
            <p className="nota-nivel">Se elige automáticamente el nivel de <b>mayor calidad</b> que cumpla el límite. Si no se puede alcanzar, se guarda el resultado más pequeño posible y se avisa. <i>Las previsiones son aproximadas; el resultado final se comprueba con el tamaño real.</i></p>
          </div>
        );
      })() : (() => {
        const base = pend.reduce((t, it) => t + (analisis[it.ruta]?.tam ?? 0), 0);
        const est = (k: number) => pend.reduce((t, it) => t + (analisis[it.ruta]?.estimado[k] ?? 0), 0);
        const k = ORDEN_NIVELES.indexOf(nivel);
        return (
          <>
            {base > 0 && <div className="resumen-comp">Tamaño actual: <b>{formatoTamano(base)}</b> · con «{NIVELES[nivel].corto}» quedaría en unos <b>{formatoTamano(est(k))}</b>{est(k) < base ? ` (−${Math.round((1 - est(k) / base) * 100)} %)` : " (sin reducción apreciable)"}</div>}
            <div className="deslizador-nivel">
              <div className="dn-extremos"><span>Archivo más pequeño</span><span>Mejor calidad</span></div>
              <input type="range" min={0} max={3} step={1} value={k} disabled={ocupado} onChange={(e) => setNivel(ORDEN_NIVELES[+e.target.value])} aria-label="Nivel de compresión" />
              <div className="dn-paradas">
                {ORDEN_NIVELES.map((n, j) => (
                  <button key={n} type="button" className={nivel === n ? "activo" : ""} disabled={ocupado} onClick={() => setNivel(n)} title={NIVELES[n].desc}>
                    <span>{NIVELES[n].corto}</span>
                    {base > 0 && <small>≈ {formatoTamano(est(j))}</small>}
                  </button>
                ))}
              </div>
            </div>
            <p className="nota-nivel"><b>{NIVELES[nivel].nombre}.</b> {NIVELES[nivel].desc} <i>El tamaño indicado es una estimación aproximada.</i></p>
          </>
        );
      })()}

      {cola.length > 0 && (
        <div className="fila-botones">
          <button className="secundario" onClick={elegir} disabled={ocupado}>+ Añadir</button>
          <button className="secundario" onClick={() => setCola((p) => p.filter((it) => it.estado !== "error"))} disabled={ocupado} title="Quitar solo los errores">Limpiar errores</button>
          <button className="secundario" onClick={() => setCola([])} disabled={ocupado} title="Limpiar toda la lista">Limpiar todo</button>
          <button className="primario naranja" onClick={procesar} disabled={ocupado || pendientes === 0}>Comprimir ({pendientes})</button>
        </div>
      )}
    </div>
  );
}
