import { useEffect, useState } from "react";
import { I } from "./Icono";

// ── Avisos (toasts) ──
export interface AvisoAccion { texto: string; hacer: () => void; principal?: boolean; }
export interface AvisoDatos { id: number; tipo: "ok" | "err" | "info"; titulo: string; texto?: string; acciones?: AvisoAccion[]; }
type Oyente = (a: AvisoDatos) => void;
let oyenteAviso: Oyente | null = null;
let contador = 1;
export function avisar(a: Omit<AvisoDatos, "id">) { oyenteAviso?.({ ...a, id: contador++ }); }

export function AvisosHost() {
  const [lista, setLista] = useState<AvisoDatos[]>([]);
  useEffect(() => {
    oyenteAviso = (a) => {
      setLista((p) => [...p.filter((x) => !(x.titulo === a.titulo && x.texto === a.texto)), a].slice(-4));
      if (a.tipo !== "err") setTimeout(() => setLista((p) => p.filter((x) => x.id !== a.id)), 7000);
    };
    return () => { oyenteAviso = null; };
  }, []);
  const cerrar = (id: number) => setLista((p) => p.filter((x) => x.id !== id));
  if (!lista.length) return null;
  return (
    <div className="avisos" role="region" aria-label="Notificaciones" aria-live="polite">
      {lista.map((a) => (
        <div key={a.id} className={`aviso aviso-${a.tipo}`} role={a.tipo === "err" ? "alert" : "status"}>
          <div className="aviso-cab">
            <I n={a.tipo === "ok" ? "check" : a.tipo === "err" ? "warn" : "info"} s={16} />
            <b>{a.titulo}</b>
            <button className="aviso-x" onClick={() => cerrar(a.id)} aria-label="Cerrar aviso"><I n="x" s={14} /></button>
          </div>
          {a.texto && <p>{a.texto}</p>}
          {a.acciones && a.acciones.length > 0 && (
            <div className="aviso-acc">
              {a.acciones.map((x) => (
                <button key={x.texto} className={x.principal ? "primario" : "secundario"} onClick={() => { x.hacer(); cerrar(a.id); }}>{x.texto}</button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Confirmaciones ──
export interface ConfirmDatos { titulo: string; texto?: string; ok?: string; cancelar?: string; peligro?: boolean; /** icono: «trash» al borrar (por defecto con peligro), «warn» para avisos */ icono?: "trash" | "warn"; }
let oyenteConf: ((d: ConfirmDatos, r: (v: boolean) => void) => void) | null = null;
export function confirmar(d: ConfirmDatos): Promise<boolean> {
  return new Promise((res) => { if (!oyenteConf) { res(window.confirm(d.titulo + (d.texto ? "\n\n" + d.texto : ""))); return; } oyenteConf(d, res); });
}

export function ConfirmHost() {
  const [est, setEst] = useState<{ d: ConfirmDatos; r: (v: boolean) => void } | null>(null);
  useEffect(() => { oyenteConf = (d, r) => setEst({ d, r }); return () => { oyenteConf = null; }; }, []);
  useEffect(() => {
    if (!est) return;
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); cerrar(false); } };
    window.addEventListener("keydown", f); return () => window.removeEventListener("keydown", f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [est]);
  function cerrar(v: boolean) { est?.r(v); setEst(null); }
  if (!est) return null;
  const { d } = est;
  return (
    <div className="modal-fondo" onClick={() => cerrar(false)}>
      <div className="modal-caja dlg-conf" role="alertdialog" aria-modal="true" aria-label={d.titulo} onClick={(e) => e.stopPropagation()}>
        <div className="dlg-cuerpo">
          <div className={`dlg-icono${d.peligro ? " peligro" : ""}`}><I n={d.icono ?? (d.peligro ? "trash" : "warn")} s={20} /></div>
          <div><h3>{d.titulo}</h3>{d.texto && <p>{d.texto}</p>}</div>
        </div>
        <div className="dlg-pie">
          <button className="secundario" onClick={() => cerrar(false)}>{d.cancelar ?? "Cancelar"}</button>
          <button className={d.peligro ? "peligro" : "primario"} autoFocus onClick={() => cerrar(true)}>{d.ok ?? "Aceptar"}</button>
        </div>
      </div>
    </div>
  );
}
