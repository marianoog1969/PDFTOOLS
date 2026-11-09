import { useEffect, useRef, useState } from "react";

export interface ItemMenu { texto?: string; atajo?: string; hacer?: () => void; sep?: boolean; off?: boolean; sub?: ItemMenu[]; }
export interface GrupoMenu { titulo: string; items: ItemMenu[]; }

export default function MenuSuperior({ grupos }: { grupos: GrupoMenu[] }) {
  const [abierto, setAbierto] = useState<number | null>(null);
  const [subAbierto, setSubAbierto] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (abierto === null) return;
    const fuera = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setAbierto(null); };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(null);
      else if (e.key === "ArrowRight") setAbierto((a) => (a === null ? a : (a + 1) % grupos.length));
      else if (e.key === "ArrowLeft") setAbierto((a) => (a === null ? a : (a + grupos.length - 1) % grupos.length));
    };
    document.addEventListener("mousedown", fuera); document.addEventListener("keydown", tecla);
    return () => { document.removeEventListener("mousedown", fuera); document.removeEventListener("keydown", tecla); };
  }, [abierto, grupos.length]);
  const lanzar = (it: ItemMenu) => { if (it.off || it.sub || !it.hacer) return; setAbierto(null); setSubAbierto(null); setTimeout(() => it.hacer!(), 0); };
  return (
    <div className="menu-sup" ref={ref} role="menubar">
      {grupos.map((g, i) => (
        <div key={g.titulo} className="menu-grupo">
          <button role="menuitem" aria-haspopup="true" aria-expanded={abierto === i} className={abierto === i ? "on" : ""}
            onClick={() => setAbierto(abierto === i ? null : i)} onMouseEnter={() => abierto !== null && setAbierto(i)}>{g.titulo}</button>
          {abierto === i && (
            <div className="menu-lista" role="menu">
              {g.items.map((it, k) => it.sep ? <hr key={k} /> : (
                <div key={k} className="menu-item-w" onMouseEnter={() => setSubAbierto(it.sub ? k : null)}>
                  <button role="menuitem" className={`menu-item${it.off ? " off" : ""}`} disabled={it.off} onClick={() => lanzar(it)}>
                    <span>{it.texto}</span>{it.sub ? <kbd>›</kbd> : it.atajo ? <kbd>{it.atajo}</kbd> : null}
                  </button>
                  {it.sub && subAbierto === k && (
                    <div className="menu-lista menu-sub" role="menu">
                      {it.sub.length === 0 ? <div className="menu-vacio">(vacío)</div> : it.sub.map((s, j) => (
                        <button key={j} role="menuitem" className="menu-item" onClick={() => lanzar(s)} title={s.texto}><span>{s.texto}</span></button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
