//! Impresión de PDF.
//!
//! Métodos, por orden de preferencia en modo «auto»:
//!  1. **WebView2** (motor de Edge, ya presente en Windows): el PDF se abre en una ventana fuera de pantalla y se
//!     imprime con `ICoreWebView2_16::Print` y los ajustes elegidos. Vectorial, sin dependencias nuevas.
//!  2. **SumatraPDF** portátil, si está en `UTILS\sumatra\SumatraPDF.exe`.
//!  3. **Ghostscript** (`mswinpr2`), que ya está en UTILS. Rasteriza, pero funciona siempre.
//! Además:
//!  - **Envío directo** (solo si se elige para una impresora): el PDF se manda tal cual a la cola de la impresora
//!    con cabecera PJL. Instantáneo y con calidad perfecta, pero solo para impresoras que interpretan PDF.
//!  - **Diálogo de Windows**: abre el PDF en una ventana y muestra el diálogo de impresión del sistema.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Clone, Debug)]
pub struct Ajustes {
    pub impresora: Option<String>,
    #[serde(default = "uno")]
    pub copias: u32,
    /// «1-3, 5»; vacío = todas
    #[serde(default)]
    pub paginas: String,
    /// "auto" | "no" | "largo" | "corto"
    #[serde(default = "auto")]
    pub doble_cara: String,
    /// "auto" | "color" | "gris"
    #[serde(default = "auto")]
    pub color: String,
    /// 1, 2, 4, 6, 9 o 16
    #[serde(default = "uno")]
    pub por_hoja: u32,
    /// "auto" | "vertical" | "horizontal"
    #[serde(default = "auto")]
    pub orientacion: String,
    #[serde(default = "verdadero")]
    pub intercalar: bool,
    /// "auto" | "webview" | "directo" | "sumatra" | "ghostscript"
    #[serde(default = "auto")]
    pub metodo: String,
    /// Marca de agua solo en la copia impresa (p. ej. «COPIA»); el archivo no se toca.
    #[serde(default)]
    pub marca_copia: Option<String>,
    /// Texto al pie solo en la copia impresa (p. ej. «Impreso el 08/11/2026 a las 10:30»).
    #[serde(default)]
    pub pie_copia: Option<String>,
}

impl Ajustes {
    /// Decorado temporal para la copia impresa, si se pidió marca o pie.
    pub fn decorado_copia(&self) -> Option<crate::edicion::Decorado> {
        let marca = self.marca_copia.as_deref().map(str::trim).filter(|t| !t.is_empty());
        let pie = self.pie_copia.as_deref().map(str::trim).filter(|t| !t.is_empty());
        if marca.is_none() && pie.is_none() { return None; }
        Some(crate::edicion::Decorado {
            marca: marca.map(|t| crate::edicion::Marca { texto: t.to_string(), tam: 72.0, opacidad: 0.18, color: [0.55, 0.0, 0.0], angulo: 45.0 }),
            // la «numeración» con un texto fijo sirve de pie de página
            numeracion: pie.map(|t| crate::edicion::Numeracion { formato: t.replace('{', "(").replace('}', ")"), posicion: "pie-centro".into(), tam: 8.0, inicio: 1, color: [0.35, 0.35, 0.35] }),
            paginas: "todas".into(),
        })
    }
}
fn uno() -> u32 { 1 }
fn auto() -> String { "auto".into() }
fn verdadero() -> bool { true }

#[derive(Serialize, Clone, Debug)]
pub struct Impresora { pub nombre: String, pub predeterminada: bool, pub red: bool }

#[derive(Serialize, Clone, Debug)]
pub struct Resultado {
    /// Método con el que se imprimió
    pub metodo: String,
    /// Avisos para el usuario (métodos que fallaron antes, ajustes que el método no admite…)
    pub avisos: Vec<String>,
}

pub fn nombre_metodo(m: &str) -> &'static str {
    match m {
        "webview" => "motor de Windows (WebView2)",
        "directo" => "envío directo a la impresora",
        "sumatra" => "SumatraPDF",
        "ghostscript" => "Ghostscript",
        _ => "desconocido",
    }
}

/// Crea una copia del PDF solo con las páginas pedidas (en su orden original). `None` si se imprimen todas.
pub fn subconjunto(entrada: &str, nums: &[u32], total: u32, dir: &Path) -> Result<Option<PathBuf>, String> {
    if nums.is_empty() || nums.len() as u32 == total { return Ok(None); }
    let mut doc = lopdf::Document::load(entrada).map_err(|e| format!("No se pudo abrir el PDF: {e}"))?;
    let quitar: Vec<u32> = (1..=total).filter(|n| !nums.contains(n)).collect();
    doc.delete_pages(&quitar);
    doc.prune_objects();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let salida = dir.join("imprimir.pdf");
    doc.save(&salida).map_err(|e| format!("No se pudo preparar la selección de páginas: {e}"))?;
    Ok(Some(salida))
}

/// Cabecera PJL + PDF + fin de trabajo, para el envío directo.
pub fn trabajo_pjl(pdf: &[u8], aj: &Ajustes) -> Vec<u8> {
    let mut c = String::from("\x1b%-12345X@PJL JOB NAME=\"PDF Tool\"\r\n");
    c += &format!("@PJL SET COPIES={}\r\n@PJL SET QTY={}\r\n", aj.copias.max(1), aj.copias.max(1));
    match aj.doble_cara.as_str() {
        "no" => c += "@PJL SET DUPLEX=OFF\r\n",
        "largo" => c += "@PJL SET DUPLEX=ON\r\n@PJL SET BINDING=LONGEDGE\r\n",
        "corto" => c += "@PJL SET DUPLEX=ON\r\n@PJL SET BINDING=SHORTEDGE\r\n",
        _ => {}
    }
    match aj.color.as_str() {
        "gris" => c += "@PJL SET RENDERMODE=GRAYSCALE\r\n",
        "color" => c += "@PJL SET RENDERMODE=COLOR\r\n",
        _ => {}
    }
    c += "@PJL ENTER LANGUAGE=PDF\r\n";
    let mut v = c.into_bytes();
    v.extend_from_slice(pdf);
    v.extend_from_slice(b"\x1b%-12345X@PJL EOJ NAME=\"PDF Tool\"\r\n\x1b%-12345X");
    v
}

/// Ajustes de SumatraPDF: «1-3,5,duplexlong,monochrome,2x,fit»
pub fn ajustes_sumatra(aj: &Ajustes) -> String {
    let mut p: Vec<String> = vec![];
    let r = aj.paginas.replace(' ', "");
    if !r.is_empty() { p.push(r); }
    match aj.doble_cara.as_str() { "no" => p.push("simplex".into()), "largo" => p.push("duplexlong".into()), "corto" => p.push("duplexshort".into()), _ => {} }
    match aj.color.as_str() { "gris" => p.push("monochrome".into()), "color" => p.push("color".into()), _ => {} }
    if aj.copias > 1 { p.push(format!("{}x", aj.copias)); }
    p.push("fit".into());
    p.join(",")
}

// ───────────────────────────── Windows ─────────────────────────────
#[cfg(windows)]
pub mod win {
    use super::*;
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
    unsafe fn de_wide(p: *const u16) -> String {
        if p.is_null() { return String::new(); }
        let mut n = 0; while *p.add(n) != 0 { n += 1; }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
    }

    #[repr(C)] struct PrinterInfo4 { nombre: *mut u16, servidor: *mut u16, atributos: u32 }
    #[repr(C)] struct DocInfo1 { doc: *const u16, salida: *const u16, tipo: *const u16 }
    #[repr(C)] struct PrinterInfo2 {
        servidor: *mut u16, nombre: *mut u16, compartida: *mut u16, puerto: *mut u16, driver: *mut u16, comentario: *mut u16,
        ubicacion: *mut u16, devmode: *mut c_void, separador: *mut u16, procesador: *mut u16, tipo_datos: *mut u16,
        parametros: *mut u16, seguridad: *mut c_void, atributos: u32, prioridad: u32, prioridad_def: u32, inicio: u32,
        fin: u32, estado: u32, trabajos: u32, ppm: u32,
    }

    #[link(name = "winspool")]
    extern "system" {
        fn EnumPrintersW(flags: u32, name: *const u16, level: u32, buf: *mut u8, cb: u32, needed: *mut u32, returned: *mut u32) -> i32;
        fn GetDefaultPrinterW(buf: *mut u16, cch: *mut u32) -> i32;
        fn OpenPrinterW(name: *const u16, h: *mut *mut c_void, def: *const c_void) -> i32;
        fn ClosePrinter(h: *mut c_void) -> i32;
        fn StartDocPrinterW(h: *mut c_void, level: u32, info: *const DocInfo1) -> u32;
        fn EndDocPrinter(h: *mut c_void) -> i32;
        fn StartPagePrinter(h: *mut c_void) -> i32;
        fn EndPagePrinter(h: *mut c_void) -> i32;
        fn WritePrinter(h: *mut c_void, buf: *const c_void, cb: u32, written: *mut u32) -> i32;
        fn GetPrinterW(h: *mut c_void, level: u32, buf: *mut u8, cb: u32, needed: *mut u32) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(hkey: isize, subclave: *const u16, valor: *const u16, flags: u32, tipo: *mut u32, datos: *mut c_void, cb: *mut u32) -> i32;
    }
    const HKEY_LOCAL_MACHINE: isize = 0x8000_0002u32 as i32 as isize;
    const RRF_RT_REG_SZ: u32 = 0x2;
    const PRINTER_ENUM_LOCAL: u32 = 2;
    const PRINTER_ENUM_CONNECTIONS: u32 = 4;
    const PRINTER_ATTRIBUTE_NETWORK: u32 = 0x10;

    pub fn predeterminada() -> Option<String> {
        unsafe {
            let mut n: u32 = 0;
            GetDefaultPrinterW(null_mut(), &mut n);
            if n == 0 { return None; }
            let mut b = vec![0u16; n as usize];
            if GetDefaultPrinterW(b.as_mut_ptr(), &mut n) == 0 { return None; }
            Some(de_wide(b.as_ptr()))
        }
    }

    pub fn listar() -> Result<Vec<Impresora>, String> {
        unsafe {
            let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
            let (mut cb, mut n) = (0u32, 0u32);
            EnumPrintersW(flags, null(), 4, null_mut(), 0, &mut cb, &mut n);
            if cb == 0 { return Ok(vec![]); }
            let mut buf = vec![0u64; (cb as usize).div_ceil(8)]; // alineado para leer las estructuras
            if EnumPrintersW(flags, null(), 4, buf.as_mut_ptr() as *mut u8, cb, &mut cb, &mut n) == 0 {
                return Err("No se pudo obtener la lista de impresoras de Windows.".into());
            }
            let pred = predeterminada();
            let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PrinterInfo4, n as usize);
            let mut v: Vec<Impresora> = infos.iter().map(|i| {
                let nombre = de_wide(i.nombre);
                Impresora { predeterminada: pred.as_deref() == Some(nombre.as_str()), red: i.atributos & PRINTER_ATTRIBUTE_NETWORK != 0 || nombre.starts_with("\\\\"), nombre }
            }).collect();
            v.sort_by(|a, b| b.predeterminada.cmp(&a.predeterminada).then(a.nombre.to_lowercase().cmp(&b.nombre.to_lowercase())));
            Ok(v)
        }
    }

    fn leer_registro(subclave: &str, valor: &str) -> Option<String> {
        unsafe {
            let (sc, v) = (wide(subclave), wide(valor));
            let mut cb: u32 = 0;
            if RegGetValueW(HKEY_LOCAL_MACHINE, sc.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, null_mut(), null_mut(), &mut cb) != 0 || cb < 2 { return None; }
            let mut b = vec![0u16; (cb as usize).div_ceil(2)];
            if RegGetValueW(HKEY_LOCAL_MACHINE, sc.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, null_mut(), b.as_mut_ptr() as *mut c_void, &mut cb) != 0 { return None; }
            Some(de_wide(b.as_ptr())).map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
        }
    }

    /// Dirección de red de una impresora instalada en Windows, para preguntarle qué formatos acepta.
    /// `Err` explica por qué no se puede averiguar (compartida por un servidor, WSD, USB…).
    pub fn direccion(impresora: &str) -> Result<String, String> {
        if impresora.starts_with("\\\\") {
            let servidor = impresora.trim_start_matches('\\').split('\\').next().unwrap_or("");
            return Err(format!("Esta impresora está compartida a través del servidor «{servidor}», así que no se sabe la dirección de la impresora física."));
        }
        let puerto = unsafe {
            let nombre = wide(impresora);
            let mut h: *mut c_void = null_mut();
            if OpenPrinterW(nombre.as_ptr(), &mut h, null()) == 0 || h.is_null() { return Err(format!("No se pudo abrir la impresora «{impresora}».")); }
            let mut cb: u32 = 0;
            GetPrinterW(h, 2, null_mut(), 0, &mut cb);
            let mut buf = vec![0u64; (cb.max(1) as usize).div_ceil(8)]; // alineado para leer la estructura
            let ok = cb > 0 && GetPrinterW(h, 2, buf.as_mut_ptr() as *mut u8, cb, &mut cb) != 0;
            let puerto = if ok { de_wide((*(buf.as_ptr() as *const PrinterInfo2)).puerto) } else { String::new() };
            ClosePrinter(h);
            puerto
        };
        let puerto = puerto.split(',').next().unwrap_or("").trim().to_string();
        let mayus = puerto.to_uppercase();
        if puerto.is_empty() { return Err("Windows no indica el puerto de esta impresora.".into()); }
        if mayus.starts_with("HTTP://") || mayus.starts_with("HTTPS://") { return Ok(puerto); }
        if let Some(h) = leer_registro(&format!("SYSTEM\\CurrentControlSet\\Control\\Print\\Monitors\\Standard TCP/IP Port\\Ports\\{puerto}"), "HostName")
            .or_else(|| leer_registro(&format!("SYSTEM\\CurrentControlSet\\Control\\Print\\Monitors\\Standard TCP/IP Port\\Ports\\{puerto}"), "IPAddress")) {
            return Ok(h);
        }
        // Puertos con la IP en el nombre: «IP_10.0.0.5», «10.0.0.5», «10.0.0.5_1»
        let candidato = puerto.trim_start_matches("IP_").split('_').next().unwrap_or("");
        if candidato.parse::<std::net::IpAddr>().is_ok() { return Ok(candidato.to_string()); }
        if mayus.starts_with("WSD") { return Err("Esta impresora está conectada por WSD y Windows no indica su dirección.".into()); }
        if mayus.starts_with("USB") || mayus.starts_with("LPT") || mayus.starts_with("COM") || mayus.starts_with("DOT4") {
            return Err("Esta impresora está conectada por cable al equipo (no por red): no se le puede preguntar.".into());
        }
        if mayus.starts_with("PORTPROMPT") || mayus.starts_with("FILE") || mayus == "NUL:" || mayus.starts_with("NE0") || mayus.ends_with(".PDF") || mayus.ends_with(".XPS") {
            return Err("Es una impresora virtual (imprime a archivo): no admite envío directo.".into());
        }
        Err(format!("No se reconoce el puerto «{puerto}» de esta impresora."))
    }

    /// Manda bytes «RAW» a la cola de una impresora.
    pub fn enviar_raw(impresora: &str, titulo: &str, datos: &[u8]) -> Result<(), String> {
        unsafe {
            let nombre = wide(impresora);
            let mut h: *mut c_void = null_mut();
            if OpenPrinterW(nombre.as_ptr(), &mut h, null()) == 0 || h.is_null() {
                return Err(format!("No se pudo abrir la impresora «{impresora}»."));
            }
            let (doc, tipo) = (wide(titulo), wide("RAW"));
            let info = DocInfo1 { doc: doc.as_ptr(), salida: null(), tipo: tipo.as_ptr() };
            let r = (|| {
                if StartDocPrinterW(h, 1, &info) == 0 { return Err("La impresora no aceptó el trabajo.".to_string()); }
                let mut res = Ok(());
                if StartPagePrinter(h) != 0 {
                    let mut escrito: u32 = 0;
                    if WritePrinter(h, datos.as_ptr() as *const c_void, datos.len() as u32, &mut escrito) == 0 || escrito as usize != datos.len() {
                        res = Err("No se pudo enviar el documento completo a la impresora.".to_string());
                    }
                    EndPagePrinter(h);
                } else { res = Err("La impresora no aceptó el trabajo.".to_string()); }
                EndDocPrinter(h);
                res
            })();
            ClosePrinter(h);
            r
        }
    }

    /// Aplica los ajustes a un `ICoreWebView2PrintSettings` y lanza la impresión. El resultado llega por `tx`.
    pub fn imprimir_webview(wv: &tauri::webview::PlatformWebview, aj: &Ajustes, tx: std::sync::mpsc::Sender<Result<(), String>>) -> Result<(), String> {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::PrintCompletedHandler;
        use windows_core::{Interface, PCWSTR};
        let e = |m: &str, err: windows_core::Error| format!("{m}: {}", err.message());
        unsafe {
            let core = wv.controller().CoreWebView2().map_err(|x| e("WebView2 no disponible", x))?;
            let core16: ICoreWebView2_16 = core.cast().map_err(|x| e("Esta versión de WebView2 no permite imprimir (actualiza WebView2 Runtime)", x))?;
            let env6: ICoreWebView2Environment6 = wv.environment().cast().map_err(|x| e("WebView2 sin soporte de impresión", x))?;
            let ps = env6.CreatePrintSettings().map_err(|x| e("No se pudieron crear los ajustes de impresión", x))?;
            ps.SetShouldPrintBackgrounds(true).ok();
            ps.SetOrientation(if aj.orientacion == "horizontal" { COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE } else { COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT }).ok();
            if let Ok(ps2) = ps.cast::<ICoreWebView2PrintSettings2>() {
                if let Some(imp) = aj.impresora.as_deref().filter(|s| !s.is_empty()) {
                    let w = wide(imp);
                    ps2.SetPrinterName(PCWSTR::from_raw(w.as_ptr())).map_err(|x| e("Impresora no válida", x))?;
                }
                let r = aj.paginas.replace(' ', "");
                if !r.is_empty() {
                    let w = wide(&r);
                    ps2.SetPageRanges(PCWSTR::from_raw(w.as_ptr())).map_err(|x| e("Rango de páginas no válido", x))?;
                }
                ps2.SetCopies(aj.copias.clamp(1, 999) as i32).ok();
                ps2.SetCollation(if aj.intercalar { COREWEBVIEW2_PRINT_COLLATION_COLLATED } else { COREWEBVIEW2_PRINT_COLLATION_UNCOLLATED }).ok();
                if matches!(aj.por_hoja, 1 | 2 | 4 | 6 | 9 | 16) { ps2.SetPagesPerSide(aj.por_hoja as i32).ok(); }
                ps2.SetDuplex(match aj.doble_cara.as_str() {
                    "no" => COREWEBVIEW2_PRINT_DUPLEX_ONE_SIDED,
                    "largo" => COREWEBVIEW2_PRINT_DUPLEX_TWO_SIDED_LONG_EDGE,
                    "corto" => COREWEBVIEW2_PRINT_DUPLEX_TWO_SIDED_SHORT_EDGE,
                    _ => COREWEBVIEW2_PRINT_DUPLEX_DEFAULT,
                }).ok();
                ps2.SetColorMode(match aj.color.as_str() {
                    "color" => COREWEBVIEW2_PRINT_COLOR_MODE_COLOR,
                    "gris" => COREWEBVIEW2_PRINT_COLOR_MODE_GRAYSCALE,
                    _ => COREWEBVIEW2_PRINT_COLOR_MODE_DEFAULT,
                }).ok();
            }
            let tx2 = tx.clone();
            let manejador = PrintCompletedHandler::create(Box::new(move |hr, estado| {
                let r = match (hr, estado) {
                    (Ok(()), s) if s == COREWEBVIEW2_PRINT_STATUS_SUCCEEDED => Ok(()),
                    (Ok(()), s) if s == COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE => Err("La impresora no está disponible (¿apagada o sin conexión?).".to_string()),
                    (Ok(()), _) => Err("WebView2 no pudo imprimir este documento.".to_string()),
                    (Err(err), _) => Err(format!("WebView2 no pudo imprimir: {}", err.message())),
                };
                let _ = tx2.send(r);
                Ok(())
            }));
            core16.Print(&ps, &manejador).map_err(|x| e("No se pudo iniciar la impresión", x))?;
            Ok(())
        }
    }

    /// Muestra el diálogo de impresión de Windows sobre el documento cargado en la ventana.
    pub fn dialogo_sistema(wv: &tauri::webview::PlatformWebview) -> Result<(), String> {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows_core::Interface;
        unsafe {
            let core = wv.controller().CoreWebView2().map_err(|x| x.message().to_string())?;
            let core16: ICoreWebView2_16 = core.cast().map_err(|_| "Esta versión de WebView2 no permite imprimir (actualiza WebView2 Runtime).".to_string())?;
            core16.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM).map_err(|x| x.message().to_string())
        }
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    fn ajustes() -> Ajustes {
        serde_json::from_str(r#"{ "impresora": "HP", "copias": 2, "paginas": "1-3, 5", "doble_cara": "largo", "color": "gris" }"#).unwrap()
    }

    #[test]
    fn valores_por_defecto() {
        let a: Ajustes = serde_json::from_str("{}").unwrap();
        assert_eq!((a.copias, a.por_hoja, a.intercalar), (1, 1, true));
        assert_eq!((a.doble_cara.as_str(), a.color.as_str(), a.metodo.as_str()), ("auto", "auto", "auto"));
        assert!(a.decorado_copia().is_none());
    }

    #[test]
    fn cabecera_pjl() {
        let t = String::from_utf8(trabajo_pjl(b"%PDF-1.7", &ajustes())).unwrap();
        assert!(t.starts_with("\x1b%-12345X@PJL"));
        assert!(t.contains("@PJL SET COPIES=2"));
        assert!(t.contains("@PJL SET DUPLEX=ON\r\n@PJL SET BINDING=LONGEDGE"));
        assert!(t.contains("RENDERMODE=GRAYSCALE"));
        assert!(t.contains("@PJL ENTER LANGUAGE=PDF\r\n%PDF-1.7"));
        assert!(t.ends_with("\x1b%-12345X"));
    }

    #[test]
    fn ajustes_de_sumatra() {
        assert_eq!(ajustes_sumatra(&ajustes()), "1-3,5,duplexlong,monochrome,2x,fit");
    }

    /// PDF mínimo de `n` páginas en blanco.
    fn pdf_de_prueba(n: u32, ruta: &Path) {
        use lopdf::{dictionary, Document, Object};
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let kids: Vec<Object> = (0..n).map(|_| doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()] }).into()).collect();
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => n as i64 }));
        let catalogo = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalogo);
        doc.save(ruta).unwrap();
    }

    #[test]
    fn subconjunto_de_paginas() {
        let dir = std::env::temp_dir().join(format!("pdftool_prueba_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let entrada = dir.join("entrada.pdf");
        pdf_de_prueba(5, &entrada);
        let e = entrada.to_string_lossy().into_owned();
        // todas las páginas: no hace falta copia
        assert!(subconjunto(&e, &[1, 2, 3, 4, 5], 5, &dir).unwrap().is_none());
        assert!(subconjunto(&e, &[], 5, &dir).unwrap().is_none());
        let sal = subconjunto(&e, &[1, 3, 5], 5, &dir).unwrap().unwrap();
        assert_eq!(lopdf::Document::load(&sal).unwrap().get_pages().len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn marca_solo_en_la_copia() {
        let mut a = ajustes();
        a.marca_copia = Some("  ".into());
        assert!(a.decorado_copia().is_none(), "una marca vacía no cuenta");
        a.marca_copia = Some("COPIA".into());
        a.pie_copia = Some("Impreso el {x}".into());
        let d = a.decorado_copia().unwrap();
        assert_eq!(d.marca.unwrap().texto, "COPIA");
        // las llaves se neutralizan para que no se interpreten como {n} / {total}
        assert_eq!(d.numeracion.unwrap().formato, "Impreso el (x)");
    }
}
