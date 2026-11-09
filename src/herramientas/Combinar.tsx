import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { I } from "../Icono";
import { SvgCombinar } from "../iconos";
import { confirmar } from "../Avisos";
import { formatoTamano, guardarUltimaCarpeta, leerUltimaCarpeta, moverEnLista, nombreArchivo } from "../util";
import { CabeceraTarjeta, Candado, MoverOrden, ZonaSoltar, claseTarjeta, useReportar, useSoltar, type EstadoTarjeta, type PropsZona, type ResultadoValidacion } from "./comun";

export default function Combinar({ ctx }: PropsZona) {
  const [lista, setLista] = useState<string[]>([]);
  const [estado, setEstado] = useState<EstadoTarjeta>("inactivo");
  const [errores, setErrores] = useState<Record<string, string>>({});
  const arrastre = useRef<number | null>(null);
  const { infosPdf, cargandoInfos, ocupado, registrar } = ctx;

  useReportar(ctx, "combinar", { procesando: estado === "procesando", pendientes: lista.length, fraccion: null, etiqueta: "Combinando…" });

  function anadir(rutas: string[]) {
    const ya = new Set(lista);
    const nuevas = rutas.filter((r) => !ya.has(r));
    const dupes = rutas.length - nuevas.length;
    if (nuevas.length) { setLista((p) => [...p, ...nuevas]); ctx.cargarInfoPdf(nuevas); registrar("info", `Añadidos ${nuevas.length} archivo(s) a Combinar`); }
    if (dupes) registrar("info", `${dupes} archivo(s) ya estaban en la lista`);
  }
  useSoltar("combinar", anadir);

  async function elegir() {
    const rutas = await open({ multiple: true, defaultPath: leerUltimaCarpeta(), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!rutas) return;
    guardarUltimaCarpeta(rutas[0]);
    anadir(rutas);
  }

  const totalPaginas = lista.reduce((s, r) => s + (infosPdf[r]?.paginas ?? 0), 0);

  async function combinar() {
    if (!lista.length) return;
    await ctx.limpiarCancelacion();
    const validaciones = await invoke<ResultadoValidacion[]>("validar_pdfs", { rutas: lista });
    const fallidos = validaciones.filter((v) => !v.ok);
    if (fallidos.length > 0) {
      const nuevos: Record<string, string> = {};
      fallidos.forEach((v) => {
        const motivo = v.protegido ? "protegido con contraseña" : v.corrupto ? "corrupto o inválido" : v.error || "error desconocido";
        nuevos[v.ruta] = motivo;
        registrar("err", `${nombreArchivo(v.ruta)}: ${motivo}`);
      });
      setErrores(nuevos);
      if (fallidos.length === lista.length) return;
      const seguir = await confirmar({
        titulo: "Hay archivos que no se pueden combinar",
        texto: `${fallidos.map((v) => `${nombreArchivo(v.ruta)} — ${v.protegido ? "protegido" : "corrupto"}`).join("\n")}\n\n¿Continuar con el resto?`,
        ok: "Continuar sin ellos",
      });
      if (!seguir) return;
      return combinarRutas(validaciones.filter((v) => v.ok).map((v) => v.ruta));
    }
    setErrores({});
    await combinarRutas(lista);
  }

  async function combinarRutas(rutas: string[]) {
    const ultima = leerUltimaCarpeta();
    const salida = await save({ defaultPath: ultima ? `${ultima}\\combinado.pdf` : "combinado.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!salida) return;
    if (!await ctx.comprobarYDesbloquear([...rutas, salida])) { registrar("err", "Combinación cancelada: archivo en uso"); return; }
    setEstado("procesando");
    registrar("info", `Combinando ${rutas.length} archivos`);
    try {
      await invoke("combinar_pdfs", { rutas, salida });
      setEstado("hecho");
      guardarUltimaCarpeta(salida);
      registrar("ok", `Generado: ${salida}`);
      ctx.guardarEnHistorial({ operacion: "combinar", archivos: rutas, resultado: salida, ok: true });
      const originales = [...lista];
      setLista([]); setErrores({});
      ctx.abrirResultado(salida);
      // Borrar los originales es opcional: se ofrece en la tarjeta de resultado.
      ctx.ofrecerBorrarOriginales(salida, originales);
    } catch (e) { setEstado("error"); ctx.manejarError(e); }
  }

  const mover = (de: number, a: number) => setLista((p) => moverEnLista(p, de, a));

  return (
    <div className={claseTarjeta(ctx, "combinar", lista.length > 0, estado === "procesando")} data-zona="combinar">
      <CabeceraTarjeta icono={<SvgCombinar />} color="azul" titulo="Combinar" desc="Une varios PDF · reordena con las flechas" estado={estado} />
      {lista.length === 0 ? (
        <ZonaSoltar icono={<SvgCombinar />} titulo="Arrastra PDF aquí" formatos="PDF" boton="Elegir archivos" alPulsar={elegir} deshabilitado={ocupado} />
      ) : (
        <>
          <ul className="lista-archivos">
            {lista.map((ruta, i) => {
              const info = infosPdf[ruta];
              return (
                <li key={`${ruta}-${i}`} draggable className={errores[ruta] ? "item-error" : ""}
                  onDragStart={() => { arrastre.current = i; }} onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { const o = arrastre.current; arrastre.current = null; if (o !== null && o !== i) mover(o, i); }}>
                  <span className="asa">⠿</span>
                  <span className="nombre" title={ruta}>{nombreArchivo(ruta)}</span>
                  {errores[ruta]
                    ? <span className="mensaje-item" style={{ color: "var(--error)" }}><I n="warn" s={13} /> {errores[ruta]}</span>
                    : <>
                      {info?.protegido && <Candado />}
                      {cargandoInfos.has(ruta) && !info && <span className="cargando-info">···</span>}
                      {info && !info.protegido && info.paginas > 0 && <span className="num-paginas">{info.paginas}p</span>}
                      {info && info.tamano_bytes > 0 && <span className="tamano-archivo">{formatoTamano(info.tamano_bytes)}</span>}
                    </>}
                  <MoverOrden i={i} n={lista.length} mover={mover} deshabilitado={ocupado} />
                  <button className="quitar" onClick={() => setLista((p) => p.filter((_, j) => j !== i))} disabled={ocupado} aria-label="Quitar">×</button>
                </li>
              );
            })}
          </ul>
          <div className="fila-botones">
            <button className="secundario" onClick={elegir} disabled={ocupado}>+ Añadir más</button>
            <button className="secundario" onClick={() => { setLista([]); setErrores({}); }} disabled={ocupado}>Limpiar</button>
            <button className="primario azul" onClick={combinar} disabled={ocupado}>
              Combinar ({lista.length}{totalPaginas > 0 ? ` · ${totalPaginas}p` : ""})
            </button>
          </div>
        </>
      )}
    </div>
  );
}
