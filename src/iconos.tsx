/** Iconos SVG propios de las herramientas (los genéricos están en Icono.tsx). */
export function SvgCombinar() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="3" width="13" height="16" rx="2"/><path d="M4 8v11a2 2 0 0 0 2 2h11"/></svg>; }
export function SvgComprimir() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>; }
export function SvgOcr() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 9h8M8 13h5"/><path d="M3 7V5a2 2 0 0 1 2-2h2M3 17v2a2 2 0 0 0 2 2h2M21 7V5a2 2 0 0 0-2-2h-2M21 17v2a2 2 0 0 1-2 2h-2"/></svg>; }
export function SvgExtraer() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 3v18"/><path d="M14 8l3 3-3 3"/></svg>; }
export function SvgDividir() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="8" height="18" rx="1.5"/><rect x="13" y="3" width="8" height="18" rx="1.5"/><path d="M12 3v18" strokeDasharray="2 2"/></svg>; }
export function SvgReordenar() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="7" height="9" rx="1.2"/><rect x="14" y="11" width="7" height="9" rx="1.2"/><path d="M9 16.5 4 21M4 21v-4M4 21h4"/><path d="M15 7.5 20 3M20 3v4M20 3h-4"/></svg>; }
export function SvgCarpeta() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>; }
export function SvgCandado() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>; }
export function SvgImagenes() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>; }
export function SvgOffice() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h5"/><path d="M13 2v5h5"/><path d="m13 2 5 5v4"/><path d="M8 11h5M8 15h3"/><path d="M14 18h7m-3-3 3 3-3 3"/></svg>; }
export function SvgCheck() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>; }
export function SvgX() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>; }

/** Logotipo de la aplicación (propuesta F · «Etiqueta PDF»). */
export function LogoApp({ tam = 28 }: { tam?: number }) {
  return (
    <svg className="logo-app" width={tam} height={tam} viewBox="0 0 64 64" role="img" aria-label="PDF Tool">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#17305E" />
      <path d="M19 9 H38 L47 18 V55 H19 Z" fill="#FFFFFF" />
      <path d="M38 9 V18 H47 Z" fill="#C9D3E6" />
      <rect x="24" y="23" width="17" height="3" rx="1.5" fill="#9DAACB" />
      <rect x="11" y="33" width="34" height="14" rx="3" fill="#E8553E" />
      <text x="28" y="43.6" textAnchor="middle" fontFamily="Inter, Arial, sans-serif" fontWeight={800} fontSize="10.5" letterSpacing="0.5" fill="#FFFFFF">PDF</text>
    </svg>
  );
}
