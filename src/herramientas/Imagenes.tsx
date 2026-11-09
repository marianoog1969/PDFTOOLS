import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { SvgImagenes } from "../iconos";
import { guardarUltimaCarpeta, leerUltimaCarpeta, moverEnLista, nombreArchivo } from "../util";
import { CabeceraTarjeta, MoverOrden, ZonaSoltar, claseTarjeta, useReportar, useSoltar, type EstadoTarjeta, type PropsZona } from "./comun";

const EXTS_IMAGEN = ["jpg", "jpeg", "png", "bmp", "tiff", "tif", "gif", "webp", "heic", "heif"];

export default function Imagenes({ ctx }: PropsZona) {
  const [lista, setLista] = useState<string[]>([]);
  const [estado, setEstado] = useState<EstadoTarjeta>("inactivo");
  const [separadas, setSeparadas] = useState(false);
  const arrastre = useRef<number | null>(null);
  const { ocupado, registrar } = ctx;

  useReportar(ctx, "imagenes", { procesando: estado === "procesando", pendientes: lista.length, fraccion: null, etiqueta: "Convirtiendo imágenes…" });

  function anadir(rutas: string[]) {
    setLista((p) => [...new Set([...p, ...rutas])]);
    registrar("info", `Añadidas ${rutas.length} imagen(es)`);
  }
  useSoltar("imagenes", anadir);

  async function elegir() {
    const rutas = await open({ multiple: true, defaultPath: leerUltimaCarpeta(), filters: [{ name: "Imágenes", extensions: EXTS_IMAGEN }] });
    if (!rutas) return;
    guardarUltimaCarpeta(rutas[0]); setLista((p) => [...new Set([...p, ...rutas])]);
  }

  async function convertir() {
    if (!lista.length) return;
    await ctx.limpiarCancelacion();
    if (!separadas) {
      // Todas las imágenes → un único PDF
      const ultima = leerUltimaCarpeta();
      const s = await save({ defaultPath: ultima ? `${ultima}\\imagenes.pdf` : "imagenes.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
      if (!s) return;
      const salida = await ctx.rutaDisponible(s);
      if (!salida) return;
      setEstado("procesando");
      registrar("info", `Convirtiendo ${lista.length} imagen(es) a un único PDF A4`);
      try {
        await invoke("imagenes_a_pdf", { rutas: lista, salida, separados: false });
        setEstado("hecho"); registrar("ok", `Generado: ${salida}`);
        ctx.guardarEnHistorial({ operacion: "imagenes", archivos: lista, resultado: salida, ok: true });
        ctx.abrirResultado(salida);
        setTimeout(() => { setLista([]); setEstado("inactivo"); }, 2000);
      } catch (e) { setEstado("error"); ctx.manejarError(e); }
      return;
    }
    // Una imagen → un PDF, junto a cada imagen
    setEstado("procesando"); ctx.setResumen(null);
    registrar("info", `Convirtiendo ${lista.length} imagen(es) a PDF A4 separados`);
    let ok = 0, err = 0; let ultimaOk: string | null = null;
    for (const ruta of lista) {
      const salida = await ctx.rutaDisponible(ruta.replace(/\.[^.]+$/, ".pdf"));
      if (!salida) { registrar("info", `Omitido: ${nombreArchivo(ruta)}`); err++; continue; }
      registrar("info", `Convirtiendo [${ok + err + 1}/${lista.length}]: ${nombreArchivo(ruta)}`);
      try {
        await invoke("imagen_a_pdf", { ruta, salida });
        registrar("ok", `Generado: ${salida}`);
        ctx.guardarEnHistorial({ operacion: "imagenes", archivos: [ruta], resultado: salida, ok: true });
        ultimaOk = salida; ok++;
      } catch (e) { ctx.manejarError(e); err++; }
    }
    setEstado(err > 0 && ok === 0 ? "error" : "hecho");
    ctx.setResumen({ ok, error: err });
    if (ultimaOk) ctx.resultadosVarios(ultimaOk);
    if (err === 0) setTimeout(() => { setLista([]); setEstado("inactivo"); }, 2000);
  }

  const mover = (de: number, a: number) => setLista((p) => moverEnLista(p, de, a));

  return (
    <div className={claseTarjeta(ctx, "imagenes", lista.length > 0, estado === "procesando")} data-zona="imagenes">
      <CabeceraTarjeta icono={<SvgImagenes />} color="verde" titulo="Imágenes a PDF" desc="Convierte JPG, PNG… a PDF tamaño A4" estado={estado} />
      {lista.length === 0 ? (
        <ZonaSoltar icono={<SvgImagenes />} titulo="Arrastra imágenes aquí" formatos="JPG · PNG · HEIC · TIFF · WEBP · BMP" boton="Elegir imágenes" alPulsar={elegir} deshabilitado={ocupado} />
      ) : (
        <ul className="lista-archivos">
          {lista.map((ruta, i) => (
            <li key={`${ruta}-${i}`} draggable onDragStart={() => { arrastre.current = i; }} onDragOver={(e) => e.preventDefault()}
              onDrop={() => { const o = arrastre.current; arrastre.current = null; if (o !== null && o !== i) mover(o, i); }}>
              <span className="asa">⠿</span>
              <span className="nombre" title={ruta}>{nombreArchivo(ruta)}</span>
              <MoverOrden i={i} n={lista.length} mover={mover} deshabilitado={ocupado} />
              <button className="quitar" onClick={() => setLista((p) => p.filter((_, j) => j !== i))} disabled={ocupado} aria-label="Quitar">×</button>
            </li>
          ))}
        </ul>
      )}
      <span className="etq-campo">Resultado</span>
      <div className="opciones-nivel opciones-salida-img" role="radiogroup" aria-label="Resultado">
        <button type="button" role="radio" aria-checked={!separadas} className={!separadas ? "activo" : ""} onClick={() => setSeparadas(false)} disabled={ocupado}>
          <span>Un único PDF</span><small>todas las imágenes, una por página</small>
        </button>
        <button type="button" role="radio" aria-checked={separadas} className={separadas ? "activo" : ""} onClick={() => setSeparadas(true)} disabled={ocupado}>
          <span>Un PDF por imagen</span><small>cada imagen en su propio archivo</small>
        </button>
      </div>
      {lista.length > 0 && (
        <div className="fila-botones">
          <button className="secundario" onClick={elegir} disabled={ocupado}>+ Añadir</button>
          <button className="secundario" onClick={() => setLista([])} disabled={ocupado}>Limpiar</button>
          <button className="primario verde" onClick={convertir} disabled={ocupado}>Convertir ({lista.length})</button>
        </div>
      )}
    </div>
  );
}
