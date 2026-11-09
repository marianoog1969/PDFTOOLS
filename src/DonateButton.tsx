import { invoke } from "@tauri-apps/api/core";
import { PAYPAL_URL } from "./credits";
import { I } from "./Icono";

export function donar() {
  invoke("open_url", { url: PAYPAL_URL }).catch(() => {});
}

export default function DonateButton({ compacto = false }: { compacto?: boolean }) {
  return (
    <button
      className={compacto ? "btn-donar compacto" : "btn-donar"}
      onClick={donar}
      title="Apoyar el proyecto con una donación (PayPal)"
    >
      <span className="corazon"><I n="heart" s={14} /></span>{compacto ? "" : " Donar"}
    </button>
  );
}
