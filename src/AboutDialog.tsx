import { CREDITS } from "./credits";
import { donar } from "./DonateButton";
import { I } from "./Icono";


export default function AboutDialog({ cerrar, manual }: { cerrar: () => void; manual: () => void }) {
  return (
    <div className="superposicion" onClick={cerrar}>
      <div className="dialogo dialogo-acerca" onClick={(e) => e.stopPropagation()}>
        <h4>PDF Tool</h4>
        <div className="acerca-version">Versión {__APP_VERSION__}</div>
        <p>{CREDITS}</p>
        <p className="acerca-tec">
          Tecnologías: Tauri, React, Rust (lopdf, image, zune-heic). Motores externos: Ghostscript (AGPL) y Tesseract OCR (Apache 2.0).
        </p>
        <p className="acerca-tec">© {new Date().getFullYear()} Servicio de Informática · CIS Guillermo Miranda · Murcia</p>
        <div className="acerca-botones">
          <button className="btn-ver-log" onClick={() => { cerrar(); manual(); }}>Manual</button>
          <button className="btn-donar" onClick={donar}><span className="corazon"><I n="heart" s={14} /></span> Donar</button>
          <button className="btn-ver-log" onClick={cerrar}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
