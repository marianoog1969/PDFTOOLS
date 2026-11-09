import { useEffect, useMemo, useRef, useState } from "react";

export interface ItemPaleta { id: string; titulo: string; grupo: string; accion: () => void; }

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export default function Paleta({ items, cerrar }: { items: ItemPaleta[]; cerrar: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const lista = useRef<HTMLDivElement | null>(null);
  const filtrados = useMemo(() => {
    const t = norm(q).trim();
    return t ? items.filter((i) => norm(i.titulo + " " + i.grupo).includes(t)) : items;
  }, [q, items]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { (lista.current?.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" }); }, [sel]);

  function ejecutar(i?: ItemPaleta) { if (!i) return; cerrar(); setTimeout(i.accion, 0); }

  return (
    <div className="paleta-fondo" onMouseDown={cerrar}>
      <div className="paleta" onMouseDown={(e) => e.stopPropagation()}>
        <input autoFocus placeholder="Busca una herramienta, acción o archivo reciente…" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") cerrar();
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(filtrados.length - 1, s + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); ejecutar(filtrados[sel]); }
          }} />
        <div className="paleta-lista" ref={lista}>
          {filtrados.length === 0 && <div className="paleta-vacio">Sin resultados</div>}
          {filtrados.map((i, n) => (
            <div key={i.id} className={`paleta-item${n === sel ? " on" : ""}`} onMouseEnter={() => setSel(n)} onClick={() => ejecutar(i)}>
              <span>{i.titulo}</span><span className="paleta-grupo">{i.grupo}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
