import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { I } from "./Icono";

export interface CertInfo { id: string; nombre: string; nif: string; emisor: string; caduca: string; caducado: boolean; }
interface Validacion {
  indice: number; nombre: string; nif: string; emisor: string; caduca: string; fecha_firma: string;
  integridad: string; firma: string; cadena: string; revocacion: string; cubre_todo: boolean;
  nivel: "ok" | "aviso" | "error"; resumen: string; detalles: string[];
  sello_tiempo: string; sello_coincide: boolean; ltv: boolean;
}
interface ResultadoFirma { entrada: string; salida: string; ok: boolean; error: string; aviso: string; }
type Rect = { x: number; y: number; w: number; h: number };

interface Cfg {
  rect: Rect;
  paginas: "esta" | "todas" | "ultima" | "rango";
  rango: string;
  fecha: boolean;
  visual: boolean;
  cripto: boolean;
  razon: string;
  lugar: string;
  nivel: "basica" | "ltv";
  origen: "almacen" | "pfx";
  certId: string;
  pfxRuta: string;
}

const CFG0: Cfg = { rect: { x: 0.55, y: 0.86, w: 0.4, h: 0.1 }, paginas: "esta", rango: "", fecha: true, visual: true, cripto: true, razon: "", lugar: "", nivel: "basica", origen: "almacen", certId: "", pfxRuta: "" };
const CLAVE = "pdftool_firma_cfg";
function cargarCfg(): Cfg { try { return { ...CFG0, ...JSON.parse(localStorage.getItem(CLAVE) ?? "{}") }; } catch { return CFG0; } }
function guardarCfg(c: Cfg) { try { localStorage.setItem(CLAVE, JSON.stringify(c)); } catch { /* sin almacenamiento */ } }

interface Props {
  ruta: string;
  total: number;
  minis?: string[];
  abiertos: string[];                 // rutas de todas las pestañas abiertas (firma por lotes)
  deshabilitado?: boolean;
  nombreArchivo: (ruta: string) => string;
  log: (tipo: "info" | "ok" | "err", texto: string) => void;
  manejarError: (e: unknown) => void;
  historial: (archivo: string, resultado: string) => void;
  alTerminar: (resultados: ResultadoFirma[]) => void;
  abrirVisor: (ruta: string) => void;
}

const DPI = 110;
const MIN = 0.04;

export default function FirmaPdf({ ruta, total, minis, abiertos, deshabilitado, nombreArchivo, log, manejarError, historial, alTerminar, abrirVisor }: Props) {
  const [cfg, setCfgE] = useState<Cfg>(cargarCfg);
  const setCfg = (f: (c: Cfg) => Cfg) => setCfgE((c) => { const n = f(c); guardarCfg(n); return n; });
  const [actual, setActual] = useState(1);
  const [hoja, setHoja] = useState({ w: 0, h: 0 });
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const hojaRef = useRef<HTMLDivElement | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [errImg, setErrImg] = useState<string | null>(null);
  const [certs, setCerts] = useState<CertInfo[]>([]);
  const [cargandoCerts, setCargandoCerts] = useState(false);
  const [errCerts, setErrCerts] = useState<string | null>(null);
  const [clave, setClave] = useState("");
  const [firmando, setFirmando] = useState(false);
  const [extras, setExtras] = useState<string[]>([]);
  const [prog, setProg] = useState<{ actual: number; total: number; t0: number } | null>(null);
  const [vals, setVals] = useState<Validacion[] | null>(null);
  const [validando, setValidando] = useState(false);
  const [estado, setEstado] = useState<{ firmas: number; cubre_todo: boolean; ltv: boolean } | null>(null);
  const [resultados, setResultados] = useState<ResultadoFirma[] | null>(null);
  const capaRef = useRef<HTMLDivElement | null>(null);
  const gesto = useRef<{ modo: string; x0: number; y0: number; r0: Rect } | null>(null);

  useEffect(() => { setActual(1); setImg(null); setResultados(null); }, [ruta]);
  useEffect(() => {
    let vivo = true;
    invoke<{ firmas: number; cubre_todo: boolean; ltv: boolean }>("estado_firmas", { ruta }).then((e) => { if (vivo) setEstado(e); }).catch(() => { if (vivo) setEstado(null); });
    return () => { vivo = false; };
  }, [ruta, resultados]);
  const [completando, setCompletando] = useState(false);
  async function completar(nivel: "ltv") {
    setCompletando(true);
    log("info", `Añadiendo datos de validación a largo plazo a ${nombreArchivo(ruta)}…`);
    try {
      const r = await invoke<ResultadoFirma[]>("completar_firma", { rutas: [ruta], nivel, tsaUrl: null });
      setResultados(r);
      for (const x of r) {
        if (x.ok) { log("ok", `Completado: ${x.salida}${x.aviso ? " · " + x.aviso : ""}`); historial(x.entrada, x.salida); } else log("err", `${nombreArchivo(x.entrada)}: ${x.error}`);
      }
      alTerminar(r);
    } catch (e) { manejarError(e); }
    setCompletando(false);
  }
  async function validar(revocacion: boolean) {
    setValidando(true);
    try { setVals(await invoke<Validacion[]>("validar_firmas", { ruta, revocacion })); }
    catch (e) { manejarError(e); }
    setValidando(false);
  }
  // Al abrir un PDF firmado se validan las firmas sin conexión (rápido); la revocación se comprueba a petición.
  useEffect(() => { setVals(null); if (estado && estado.firmas > 0) validar(false); }, [ruta, estado?.firmas]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const p = listen<{ actual: number; total: number }>("firma-progreso", (ev) => setProg((o) => ({ ...ev.payload, t0: o?.t0 ?? Date.now() })));
    return () => { p.then((f) => f()).catch(() => {}); };
  }, []);
  useEffect(() => {
    const el = hojaRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setHoja({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setHoja({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const escala = nat.w > 0 && hoja.w > 0 ? Math.min((hoja.w - 28) / nat.w, (hoja.h - 28) / nat.h, 1.6) : 1;

  useEffect(() => {
    let vivo = true;
    const t = setTimeout(() => {
      invoke<string>("renderizar_pagina", { entrada: ruta, pagina: actual, dpi: DPI })
        .then((d) => { if (vivo) { setImg(d); setErrImg(null); } })
        .catch((e) => { if (vivo) setErrImg(String(e)); });
    }, 140);
    return () => { vivo = false; clearTimeout(t); };
  }, [ruta, actual]);

  async function cargarCerts(origen = cfg.origen, pfx = cfg.pfxRuta, pass = clave) {
    setCargandoCerts(true); setErrCerts(null);
    try {
      const l = await invoke<CertInfo[]>("listar_certificados", { origen, pfxRuta: pfx || null, pfxClave: pass || null });
      setCerts(l);
      setCfg((c) => ({ ...c, certId: l.some((x) => x.id === c.certId) ? c.certId : (l.find((x) => !x.caducado) ?? l[0])?.id ?? "" }));
      if (l.length === 0) setErrCerts(origen === "pfx" ? "El archivo no contiene certificados con clave privada." : "No hay certificados personales con clave privada. Si usas DNIe, inserta la tarjeta y pulsa «Buscar de nuevo».");
    } catch (e) { setCerts([]); setErrCerts(String(e)); }
    setCargandoCerts(false);
  }
  useEffect(() => { if (cfg.origen === "almacen") cargarCerts("almacen"); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function elegirPfx() {
    const r = await open({ multiple: false, filters: [{ name: "Certificado", extensions: ["pfx", "p12"] }] });
    if (typeof r === "string") { setCfg((c) => ({ ...c, pfxRuta: r })); setCerts([]); setErrCerts(null); }
  }

  async function anadirPdfs() {
    const r = await open({ multiple: true, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    const l = typeof r === "string" ? [r] : Array.isArray(r) ? r : [];
    if (l.length) setExtras((p) => Array.from(new Set([...p, ...l])));
  }

  const cert = certs.find((c) => c.id === cfg.certId);
  const ir = (n: number) => setActual(Math.min(total, Math.max(1, n)));

  // ── Recuadro: crear, mover y redimensionar ──
  function pos(e: React.PointerEvent) {
    const r = capaRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  function empezar(e: React.PointerEvent, modo: string) {
    if (deshabilitado) return;
    e.stopPropagation(); e.preventDefault();
    (capaRef.current as HTMLElement).setPointerCapture(e.pointerId);
    const p = pos(e);
    gesto.current = { modo, x0: p.x, y0: p.y, r0: modo === "nuevo" ? { x: p.x, y: p.y, w: 0, h: 0 } : { ...cfg.rect } };
    if (modo === "nuevo") setCfg((c) => ({ ...c, rect: { x: p.x, y: p.y, w: 0, h: 0 } }));
  }
  function mover(e: React.PointerEvent) {
    const g = gesto.current; if (!g) return;
    const p = pos(e); const dx = p.x - g.x0, dy = p.y - g.y0; const r = g.r0;
    let n: Rect = { ...r };
    if (g.modo === "nuevo") n = { x: Math.min(g.x0, p.x), y: Math.min(g.y0, p.y), w: Math.abs(p.x - g.x0), h: Math.abs(p.y - g.y0) };
    else if (g.modo === "mover") n = { ...r, x: r.x + dx, y: r.y + dy };
    else {
      let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
      if (g.modo.includes("o")) x1 = Math.min(r.x + dx, x2 - MIN);
      if (g.modo.includes("e")) x2 = Math.max(r.x + r.w + dx, x1 + MIN);
      if (g.modo.includes("n")) y1 = Math.min(r.y + dy, y2 - MIN);
      if (g.modo.includes("s")) y2 = Math.max(r.y + r.h + dy, y1 + MIN);
      n = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    n.x = Math.min(Math.max(0, n.x), 1 - Math.min(n.w, 1)); n.y = Math.min(Math.max(0, n.y), 1 - Math.min(n.h, 1));
    n.w = Math.min(n.w, 1 - n.x); n.h = Math.min(n.h, 1 - n.y);
    setCfg((c) => ({ ...c, rect: n }));
  }
  function terminar() {
    if (!gesto.current) return;
    gesto.current = null;
    setCfg((c) => (c.rect.w < MIN || c.rect.h < MIN ? { ...c, rect: CFG0.rect } : c));
  }

  const lineas = [cfg.cripto ? "Firmado digitalmente por:" : "Firmado por:", cert?.nombre ?? "NOMBRE APELLIDOS", `NIF: ${cert?.nif || "00000000X"}`, ...(cfg.fecha ? [fechaAhora()] : [])];
  const maxCar = Math.max(...lineas.map((l) => l.length));
  const tamLetra = `min(${(100 / (lineas.length * 1.45)).toFixed(2)}cqh, ${(100 / (maxCar * 0.6)).toFixed(2)}cqw, 11px)`;

  const paginasSpec = cfg.paginas === "esta" ? String(actual) : cfg.paginas === "todas" ? "todas" : cfg.paginas === "ultima" ? "ultima" : cfg.rango;
  const sinCert = !cert;
  const hayClave = cfg.origen !== "pfx" || clave.length >= 0;
  const puedeFirmar = !deshabilitado && !firmando && !!cert && !cert.caducado && (cfg.cripto || cfg.visual) && hayClave && (!cfg.visual || (cfg.paginas !== "rango" || cfg.rango.trim() !== ""));

  async function firmar(rutas: string[]) {
    if (!cert) return;
    setFirmando(true); setResultados(null); setProg({ actual: 0, total: rutas.length, t0: Date.now() });
    log("info", `Firmando ${rutas.length} PDF con el certificado de ${cert.nombre}${cfg.cripto ? "" : " (solo sello visual)"}`);
    try {
      const r = await invoke<ResultadoFirma[]>("firmar_pdfs", {
        entradas: rutas, carpetaSalida: null,
        opciones: {
          cert_origen: cfg.origen, cert_id: cfg.certId, pfx_ruta: cfg.pfxRuta || null, pfx_clave: clave || null,
          criptografica: cfg.cripto, visual: cfg.visual || !cfg.cripto,
          rect: [cfg.rect.x, cfg.rect.y, cfg.rect.w, cfg.rect.h], paginas: paginasSpec || "1", fecha: cfg.fecha,
          razon: cfg.razon || null, lugar: cfg.lugar || null, nivel: cfg.cripto ? cfg.nivel : "basica", tsa_url: null, desfase_min: -new Date().getTimezoneOffset(),
        },
      });
      setResultados(r);
      for (const x of r) {
        if (x.ok) { log(x.aviso ? "info" : "ok", `Firmado: ${x.salida}${x.aviso ? " · AVISO: " + x.aviso : ""}`); historial(x.entrada, x.salida); } else log("err", `${nombreArchivo(x.entrada)}: ${x.error}`);
      }
      if (rutas === extras) setExtras(r.filter((x) => !x.ok).map((x) => x.entrada));
      alTerminar(r);
    } catch (e) { manejarError(e); }
    setFirmando(false); setProg(null);
  }

  const h = (m: string, cls: string) => <div key={m} className={`firma-asa ${cls}`} onPointerDown={(e) => empezar(e, m)} />;
  const r = cfg.rect;
  const hayRect = r.w >= MIN && r.h >= MIN;

  return (
    <div className="visor firmador">
      <div className="visor-minis">
        {(minis ?? []).map((m, i) => (
          <button key={i} className={`visor-mini${i + 1 === actual ? " actual" : ""}`} onClick={() => ir(i + 1)}>
            <img src={m} alt={`Página ${i + 1}`} draggable={false} /><span className="visor-num">{i + 1}</span>
          </button>
        ))}
      </div>

      <div className="visor-principal">
        <div className="visor-barra">
          {estado && estado.firmas > 0 && (
            <span className={`firma-estado${estado.cubre_todo ? "" : " aviso"}`} title="Solo detecta las firmas; no valida los certificados">
              <I n="lock" s={14} /> {estado.firmas} firma(s){estado.cubre_todo ? " · sin cambios posteriores" : " · ¡con cambios posteriores a la última firma!"}
            </span>
          )}
          <span className="firma-ayuda">Arrastra sobre la página para dibujar el recuadro de firma; muévelo o cambia su tamaño con las esquinas.</span>
          <span className="visor-espacio" />
          <div className="nav-visor">
            <button onClick={() => ir(actual - 1)} disabled={actual <= 1} aria-label="Página anterior"><I n="left" /></button>
            <span className="visor-pag"><input type="number" min={1} max={total} value={actual} onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) ir(v); }} /> / {total}</span>
            <button onClick={() => ir(actual + 1)} disabled={actual >= total} aria-label="Página siguiente"><I n="right" /></button>
          </div>
        </div>

        <div className="firma-cuerpo">
          <div className="visor-hoja" ref={hojaRef}>
            {errImg && <div className="visor-error">{errImg}</div>}
            {!img && !errImg && <div className="visor-vacio">Dibujando página…</div>}
            {img && (
              <div className="anot-pagina">
                <img src={img} alt={`Página ${actual}`} draggable={false} style={nat.w ? { width: Math.round(nat.w * escala) } : undefined}
                  onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth !== nat.w || i.naturalHeight !== nat.h) setNat({ w: i.naturalWidth, h: i.naturalHeight }); }} />
                <div className="anot-capa firma-capa" ref={capaRef} onPointerDown={(e) => { if (e.target === capaRef.current) empezar(e, "nuevo"); }}
                  onPointerMove={mover} onPointerUp={terminar} onPointerCancel={terminar}>
                  {(cfg.visual || !cfg.cripto) && hayRect && (
                    <div className="firma-rect" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
                      onPointerDown={(e) => empezar(e, "mover")}>
                      <div className="firma-texto" style={{ fontSize: tamLetra }}>{lineas.map((l, i) => <div key={i}>{l}</div>)}</div>
                      {h("no", "no")}{h("ne", "ne")}{h("so", "so")}{h("se", "se")}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <aside className="firma-panel">
            {estado && estado.firmas > 0 && (
              <section className="firma-validacion">
                <h4>Firmas de este PDF</h4>
                {vals && vals.length > 0 && (() => {
                  const ok = vals.filter((v) => v.nivel === "ok").length, av = vals.filter((v) => v.nivel === "aviso").length, er = vals.length - ok - av;
                  return <div className={`val-resumen ${er ? "error" : av ? "aviso" : "ok"}`}><I n={er ? "x" : av ? "warn" : "shield"} s={16} />{er ? `${er} firma(s) con problemas` : av ? `${av} firma(s) con avisos` : `${ok} firma(s) correcta(s)`}</div>;
                })()}
                {validando && <div className="firma-nota">Validando…</div>}
                {vals?.map((v) => (
                  <div key={v.indice} className={`val-tarjeta ${v.nivel}`}>
                    <div className="val-cab"><span className="val-icono"><I n={v.nivel === "ok" ? "check" : v.nivel === "aviso" ? "warn" : "x"} s={15} /></span><b>Firma {v.indice}{v.nombre ? ` · ${v.nombre}` : ""}</b></div>
                    <div className="val-resumen">{v.resumen}</div>
                    <div className="val-datos">
                      {v.nif && <span>NIF {v.nif}</span>}
                      {v.fecha_firma && <span>Fecha declarada: {v.fecha_firma}</span>}
                      {v.emisor && <span>Emisor: {v.emisor}</span>}
                      {v.caduca && <span>Certificado caduca: {v.caduca}</span>}
                    </div>
                    <div className="val-chips">
                      <span className={`chip ${v.integridad}`}>Integridad: {({ ok: "correcta", modificado: "MODIFICADO", no_verificable: "no verificable" } as Record<string, string>)[v.integridad]}</span>
                      <span className={`chip ${v.firma}`}>Firma: {({ ok: "correcta", invalida: "INVÁLIDA", no_comprobada: "no comprobada" } as Record<string, string>)[v.firma]}</span>
                      <span className={`chip ${v.cadena}`}>Emisor: {({ confiable: "de confianza", no_confiable: "NO confiable", parcial: "cadena incompleta", no_comprobada: "no comprobado" } as Record<string, string>)[v.cadena]}</span>
                      <span className={`chip ${v.sello_tiempo ? (v.sello_coincide ? "ok" : "modificado") : "no_comprobada"}`}>Sello de tiempo: {v.sello_tiempo ? (v.sello_coincide ? v.sello_tiempo : "NO coincide") : "no tiene"}</span>
                      <span className={`chip ${v.ltv ? "ok" : "no_comprobada"}`}>LTV: {v.ltv ? "sí" : "no"}</span>
                      <span className={`chip ${v.revocacion}`}>Revocación: {({ ok: "no revocado", revocado: "REVOCADO", desconocida: "no se pudo comprobar", no_comprobada: "no comprobada" } as Record<string, string>)[v.revocacion]}</span>
                    </div>
                    {v.detalles.length > 0 && <ul className="val-detalles">{v.detalles.map((d, i) => <li key={i}>{d}</li>)}</ul>}
                  </div>
                ))}
                <div className="firma-ltv">
                  <div className="firma-nota">{estado.ltv ? "Este PDF ya lleva datos de validación a largo plazo." : "Para que la firma siga siendo verificable cuando caduque el certificado:"}</div>
                  <button className="secundario" onClick={() => completar("ltv")} disabled={completando || validando} title="Necesita conexión: descarga de las autoridades las pruebas de revocación (OCSP/CRL) y las guarda en el PDF. Crea una copia «_ltv».">{completando ? "Conectando…" : "Añadir validación a largo plazo (LTV)"}</button>
                </div>
                <div className="grupo-herr">
                  <button onClick={() => validar(false)} disabled={validando}>Validar de nuevo</button>
                  <button onClick={() => validar(true)} disabled={validando} title="Consulta a las autoridades si el certificado fue revocado. Necesita conexión a internet.">Comprobar revocación</button>
                </div>
                <small className="firma-nota">La validez de la cadena usa los certificados raíz de Windows. La revocación necesita conexión; sin ella aparecerá «no se pudo comprobar».</small>
              </section>
            )}
            <Sec titulo="Certificado">
            <div className="grupo-herr">
              <button className={cfg.origen === "almacen" ? "on" : ""} onClick={() => { setCfg((c) => ({ ...c, origen: "almacen" })); cargarCerts("almacen"); }}>Windows / DNIe</button>
              <button className={cfg.origen === "pfx" ? "on" : ""} onClick={() => { setCfg((c) => ({ ...c, origen: "pfx" })); setCerts([]); setErrCerts(null); }}>Archivo .pfx</button>
            </div>
            {cfg.origen === "pfx" && (
              <div className="firma-pfx">
                <button onClick={elegirPfx}>{cfg.pfxRuta ? nombreArchivo(cfg.pfxRuta) : "Elegir archivo…"}</button>
                <input type="password" placeholder="Contraseña" value={clave} onChange={(e) => setClave(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && cfg.pfxRuta) cargarCerts("pfx", cfg.pfxRuta, clave); }} />
                <button onClick={() => cargarCerts("pfx", cfg.pfxRuta, clave)} disabled={!cfg.pfxRuta || cargandoCerts}>Abrir</button>
              </div>
            )}
            {cfg.origen === "almacen" && <button className="firma-recargar" onClick={() => cargarCerts("almacen")} disabled={cargandoCerts}>{cargandoCerts ? "Buscando…" : "Buscar de nuevo"}</button>}
            {errCerts && <div className="firma-error">{errCerts}</div>}
            {certs.length > 0 && (
              <select value={cfg.certId} onChange={(e) => setCfg((c) => ({ ...c, certId: e.target.value }))}>
                {certs.map((c) => <option key={c.id} value={c.id}>{c.nombre}{c.nif ? ` · ${c.nif}` : ""}{c.caducado ? " (caducado)" : ""}</option>)}
              </select>
            )}
            {cert && <div className="firma-cert">Emisor: {cert.emisor || "—"}<br />Caduca: {cert.caduca || "—"}{cert.caducado && <b className="firma-error"> · CADUCADO</b>}</div>}
            </Sec>

            <Sec titulo="Qué se añade">
            <label><input type="checkbox" checked={cfg.cripto} onChange={(e) => setCfg((c) => ({ ...c, cripto: e.target.checked }))} /> Firma digital con certificado <small>(válida legalmente, detecta cambios posteriores)</small></label>
            <label><input type="checkbox" checked={cfg.visual || !cfg.cripto} disabled={!cfg.cripto} onChange={(e) => setCfg((c) => ({ ...c, visual: e.target.checked }))} /> Sello visible (nombre, NIF{cfg.fecha ? ", fecha" : ""})</label>
            <label><input type="checkbox" checked={cfg.fecha} onChange={(e) => setCfg((c) => ({ ...c, fecha: e.target.checked }))} /> Incluir fecha y hora en el sello</label>
            </Sec>

            {cfg.cripto && (
              <Sec titulo="Duración de la firma">
                <select value={cfg.nivel} onChange={(e) => setCfg((c) => ({ ...c, nivel: e.target.value as Cfg["nivel"] }))}>
                  <option value="basica">Básica (sin conexión)</option>
                  <option value="ltv">Larga duración · LTV (necesita conexión)</option>
                </select>
                {cfg.nivel === "ltv" && <small className="firma-nota">Al firmar se conecta con las autoridades de certificación (gratis, sin cuenta) para guardar en el PDF la cadena de certificados y las pruebas de revocación. No usa sello de tiempo. Si falla la red, el PDF queda firmado igualmente y se avisa.</small>}
              </Sec>
            )}

            <Sec titulo="Páginas del sello">
            <label><input type="radio" name="fp" checked={cfg.paginas === "esta"} onChange={() => setCfg((c) => ({ ...c, paginas: "esta" }))} /> Solo la página {actual}</label>
            <label><input type="radio" name="fp" checked={cfg.paginas === "todas"} onChange={() => setCfg((c) => ({ ...c, paginas: "todas" }))} /> Todas</label>
            <label><input type="radio" name="fp" checked={cfg.paginas === "ultima"} onChange={() => setCfg((c) => ({ ...c, paginas: "ultima" }))} /> Última de cada PDF</label>
            <label><input type="radio" name="fp" checked={cfg.paginas === "rango"} onChange={() => setCfg((c) => ({ ...c, paginas: "rango" }))} /> Elegir: <input className="firma-rango" placeholder="1,3-5" value={cfg.rango} onChange={(e) => setCfg((c) => ({ ...c, paginas: "rango", rango: e.target.value }))} /></label>
            </Sec>

            {cfg.cripto && (
              <details>
                <summary>Motivo y lugar (opcional)</summary>
                <input placeholder="Motivo: p. ej. Conforme" value={cfg.razon} onChange={(e) => setCfg((c) => ({ ...c, razon: e.target.value }))} />
                <input placeholder="Lugar: p. ej. Murcia" value={cfg.lugar} onChange={(e) => setCfg((c) => ({ ...c, lugar: e.target.value }))} />
              </details>
            )}

            <div className="firma-acciones">
              <button className="primario azul" onClick={() => firmar([ruta])} disabled={!puedeFirmar}>{firmando ? "Firmando…" : "Firmar este PDF"}</button>
              {abiertos.length > 1 && <button className="secundario" onClick={() => firmar(abiertos)} disabled={!puedeFirmar}>Firmar los {abiertos.length} PDF abiertos</button>}
              <button className="secundario" onClick={anadirPdfs} disabled={firmando}><I n="plus" /> Elegir varios PDF para firmar…</button>
            </div>
            {extras.length > 0 && (
              <div className="firma-lote">
                <div className="firma-lote-cab"><b>{extras.length} archivo(s) elegidos</b><button onClick={() => setExtras([])} disabled={firmando}>Vaciar</button></div>
                <ul>{extras.map((x) => <li key={x} title={x}><span>{nombreArchivo(x)}</span><button onClick={() => setExtras((p) => p.filter((y) => y !== x))} disabled={firmando} title="Quitar">×</button></li>)}</ul>
                <button className="primario azul" onClick={() => firmar(extras)} disabled={!puedeFirmar}>{firmando ? "Firmando…" : `Firmar los ${extras.length} archivos`}</button>
                <small className="firma-nota">Se aplica el mismo recuadro y páginas a cada PDF (el recuadro se ve en la página {actual} de este documento).</small>
              </div>
            )}
            {sinCert && <small className="firma-nota">Elige un certificado para poder firmar.</small>}
            {cfg.cripto && <small className="firma-nota">Al firmar, Windows puede pedirte el PIN del DNIe. El PDF original no se modifica: se crea «_firmado».</small>}
            {firmando && prog && prog.total > 0 && (
              <div className="firma-progreso">
                <div className="barra-progreso"><div className="barra-progreso-relleno" style={{ width: `${Math.max(4, (prog.actual / prog.total) * 100)}%` }} /></div>
                <span>{prog.actual}/{prog.total}{prog.actual > 0 && prog.actual < prog.total ? ` · quedan ~${Math.max(1, Math.round(((Date.now() - prog.t0) / prog.actual) * (prog.total - prog.actual) / 1000))} s` : ""}</span>
              </div>
            )}
            {resultados && (
              <ul className="firma-res">
                {resultados.map((x, i) => <li key={i} className={x.ok ? "ok" : "err"}>
                  <span><I n={x.ok ? "check" : "x"} s={14} /> {nombreArchivo(x.ok ? x.salida : x.entrada)}{x.ok ? "" : ` — ${x.error}`}{x.aviso && <em className="firma-aviso"><br /><I n="warn" s={13} /> {x.aviso}</em>}</span>
                  {x.ok && <span className="firma-res-acc"><button onClick={() => abrirVisor(x.salida)}>Ver</button><button onClick={() => invoke("abrir_carpeta", { ruta: x.salida }).catch(() => {})}>Carpeta</button></span>}
                </li>)}
              </ul>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function fechaAhora() {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  return `Fecha: ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Sec({ titulo, children, abierta = true }: { titulo: string; children: React.ReactNode; abierta?: boolean }) {
  return (
    <details className="sec" open={abierta}>
      <summary><span>{titulo}</span><I n="down" s={14} className="sec-flecha" /></summary>
      <div className="sec-cuerpo">{children}</div>
    </details>
  );
}

/** Opciones de firma tal como se guardaron en la pestaña Firmar (para usarlas en lotes). Devuelve null si no hay certificado elegido. */
export function opcionesFirmaGuardadas(claveConfirmada: string): Record<string, unknown> | null {
  try {
    const c = JSON.parse(localStorage.getItem(CLAVE) ?? "null");
    if (!c || !c.certId) return null;
    return {
      cert_origen: c.origen ?? "almacen", cert_id: c.certId, pfx_ruta: c.pfxRuta || null, pfx_clave: claveConfirmada || null,
      criptografica: c.cripto !== false, visual: c.visual !== false || c.cripto === false,
      rect: [c.rect?.x ?? 0.55, c.rect?.y ?? 0.85, c.rect?.w ?? 0.4, c.rect?.h ?? 0.1],
      paginas: c.paginas === "todas" ? "todas" : c.paginas === "ultima" ? "ultima" : c.paginas === "rango" ? (c.rango || "1") : "1",
      fecha: c.fecha !== false, razon: c.razon || null, lugar: c.lugar || null,
      nivel: c.cripto !== false ? (c.nivel ?? "basica") : "basica", tsa_url: null, desfase_min: -new Date().getTimezoneOffset(),
    };
  } catch { return null; }
}
