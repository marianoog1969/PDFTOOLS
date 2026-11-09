import { useState } from "react";
import { I } from "./Icono";

export interface ArchivoCola { ruta: string; tipo: "pdf" | "imagen"; }

interface Props {
  archivos: ArchivoCola[];
  ignorados: string[];
  nombre: (ruta: string) => string;
  cerrar: () => void;
  alAbrirVisor: (rutas: string[]) => void;
  alCombinar: (rutas: string[]) => void;
  alComprimir: (rutas: string[]) => void;
  alOcr: (rutas: string[]) => void;
  alImagenes: (rutas: string[]) => void;
  alCombinarTodo: (rutas: string[]) => void;
}

export default function ColaArchivos(P: Props) {
  const [lista, setLista] = useState(P.archivos);
  const pdfs = lista.filter((a) => a.tipo === "pdf").map((a) => a.ruta);
  const imgs = lista.filter((a) => a.tipo === "imagen").map((a) => a.ruta);
  const todos = lista.map((a) => a.ruta);
  const mixto = pdfs.length > 0 && imgs.length > 0;

  const mover = (i: number, d: number) => setLista((l) => {
    const j = i + d; if (j < 0 || j >= l.length) return l;
    const c = [...l]; [c[i], c[j]] = [c[j], c[i]]; return c;
  });
  const quitar = (i: number) => setLista((l) => l.filter((_, k) => k !== i));

  const cerrarYHacer = (f: () => void) => () => { P.cerrar(); f(); };
  const Accion = ({ texto, desc, onClick, activa, principal }: { texto: string; desc: string; onClick: () => void; activa: boolean; principal?: boolean }) => (
    <button className={`cola-accion${principal ? " principal" : ""}`} disabled={!activa} onClick={onClick}>
      <span className="cola-accion-titulo">{texto}</span>
      <span className="cola-accion-desc">{activa ? desc : "Solo disponible con PDF"}</span>
    </button>
  );

  return (
    <div className="paleta-fondo" onMouseDown={P.cerrar}>
      <div className="cola" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cola-cab">
          <h3>{lista.length} archivo(s) recibidos</h3>
          <span>{pdfs.length} PDF · {imgs.length} imagen(es){P.ignorados.length ? ` · ${P.ignorados.length} ignorado(s)` : ""}</span>
        </div>

        <div className="cola-lista">
          {lista.map((a, i) => (
            <div className="cola-fila" key={a.ruta}>
              <span className={`cola-tipo ${a.tipo}`}>{a.tipo === "pdf" ? "PDF" : "IMG"}</span>
              <span className="cola-nombre" title={a.ruta}>{P.nombre(a.ruta)}</span>
              <button onClick={() => mover(i, -1)} disabled={i === 0} title="Subir" aria-label="Subir"><I n="up" /></button>
              <button onClick={() => mover(i, 1)} disabled={i === lista.length - 1} title="Bajar" aria-label="Bajar"><I n="down" /></button>
              <button onClick={() => quitar(i)} title="Quitar de la lista">×</button>
            </div>
          ))}
          {lista.length === 0 && <div className="visor-vacio">No queda ningún archivo.</div>}
        </div>

        {P.ignorados.length > 0 && (
          <div className="cola-ignorados" title={P.ignorados.join("\n")}>
            No admitidos y descartados: {P.ignorados.slice(0, 4).map(P.nombre).join(", ")}{P.ignorados.length > 4 ? `… (+${P.ignorados.length - 4})` : ""}
          </div>
        )}

        <div className="cola-acciones">
          {mixto && <Accion principal texto="Combinar todo en un PDF" desc="Las imágenes se convierten y se unen en el orden de la lista" activa onClick={cerrarYHacer(() => P.alCombinarTodo(todos))} />}
          {!mixto && imgs.length > 0 && <Accion principal texto="Convertir a PDF" desc="Una imagen por página, en el orden de la lista" activa onClick={cerrarYHacer(() => P.alImagenes(imgs))} />}
          {!mixto && pdfs.length > 0 && <Accion principal texto={pdfs.length === 1 ? "Abrir en el visor" : "Abrir en el visor (una pestaña cada uno)"} desc="Leer, organizar páginas y anotar" activa onClick={cerrarYHacer(() => P.alAbrirVisor(pdfs))} />}
          {!mixto && pdfs.length > 1 && <Accion texto="Combinar" desc="Une los PDF en uno, en el orden de la lista" activa onClick={cerrarYHacer(() => P.alCombinar(pdfs))} />}
          {!mixto && pdfs.length > 0 && <Accion texto="Comprimir" desc="Reduce el tamaño de cada PDF" activa onClick={cerrarYHacer(() => P.alComprimir(pdfs))} />}
          {!mixto && pdfs.length > 0 && <Accion texto="OCR" desc="Hace buscable el texto de cada PDF" activa onClick={cerrarYHacer(() => P.alOcr(pdfs))} />}
          {mixto && <Accion texto="Solo los PDF → visor" desc="Abre únicamente los PDF de la lista" activa onClick={cerrarYHacer(() => P.alAbrirVisor(pdfs))} />}
          {imgs.length > 0 && pdfs.length === 0 && <Accion texto="Comprimir / OCR / Combinar" desc="" activa={false} onClick={() => {}} />}
        </div>

        <div className="cola-pie"><button className="secundario" onClick={P.cerrar}>Cancelar</button></div>
      </div>
    </div>
  );
}
