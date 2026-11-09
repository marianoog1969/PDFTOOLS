//! Conversión de documentos de Office (Word, Excel, PowerPoint) a PDF con el **Office instalado** en el equipo.
//!
//! Se usa automatización COM directamente desde Rust (sin PowerShell ni VBScript, que suelen estar bloqueados
//! por directiva). Cada conversión:
//!  1. Copia el documento a una carpeta temporal (así no importa que esté abierto, en red o con un nombre raro).
//!  2. Arranca Word/Excel/PowerPoint **invisible**, con las macros desactivadas y sin avisos.
//!  3. Abre el documento en solo lectura y lo exporta con `ExportAsFixedFormat` (lo mismo que «Guardar como PDF»).
//!  4. Cierra sin guardar y sale de Office.
//! Todo ocurre en un hilo propio; si tarda más del tiempo máximo (o se cancela) se cierra el proceso de Office
//! que se arrancó para la conversión, nunca uno que ya tuviera abierto el usuario.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Default, Clone, Debug)]
pub struct InfoOffice {
    pub instalado: bool,
    /// «Microsoft Office 2019», «Microsoft 365»…
    pub version: String,
    /// Versión interna: 12 = 2007, 14 = 2010, 15 = 2013, 16 = 2016 o posterior
    pub numero: u32,
    pub word: bool,
    pub excel: bool,
    pub powerpoint: bool,
    /// PDF/A y marcadores desde títulos (Office 2010 o posterior)
    pub pdfa: bool,
    pub marcadores: bool,
}

fn si() -> bool { true }
fn libro() -> String { "libro".into() }
fn diapositivas() -> String { "diapositivas".into() }
fn dos_minutos() -> u64 { 120 }

#[derive(Deserialize, Clone, Debug)]
pub struct Opciones {
    #[serde(default)]
    pub pdfa: bool,
    /// Word: marcadores del PDF a partir de los títulos
    #[serde(default = "si")]
    pub marcadores: bool,
    /// Excel: "libro" | "hoja"
    #[serde(default = "libro")]
    pub excel_alcance: String,
    /// Excel: ajustar cada hoja a una página de ancho
    #[serde(default)]
    pub excel_ajustar: bool,
    /// PowerPoint: "diapositivas" | "notas" | "doc2" | "doc3" | "doc6"
    #[serde(default = "diapositivas")]
    pub ppt_salida: String,
    /// Tiempo máximo por documento, en segundos
    #[serde(default = "dos_minutos")]
    pub tiempo_max: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tipo { Word, Excel, PowerPoint }

impl Tipo {
    pub fn nombre(self) -> &'static str {
        match self { Tipo::Word => "Word", Tipo::Excel => "Excel", Tipo::PowerPoint => "PowerPoint" }
    }
    #[cfg_attr(not(windows), allow(dead_code))]
    fn ejecutable(self) -> &'static str {
        match self { Tipo::Word => "winword.exe", Tipo::Excel => "excel.exe", Tipo::PowerPoint => "powerpnt.exe" }
    }
}

pub fn tipo_de(ruta: &std::path::Path) -> Option<Tipo> {
    let ext = ruta.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "doc" | "docx" | "docm" | "dot" | "dotx" | "dotm" | "rtf" | "odt" | "txt" | "wpd" => Some(Tipo::Word),
        "xls" | "xlsx" | "xlsm" | "xlsb" | "xlt" | "xltx" | "xltm" | "ods" | "csv" => Some(Tipo::Excel),
        "ppt" | "pptx" | "pptm" | "pps" | "ppsx" | "pot" | "potx" | "odp" => Some(Tipo::PowerPoint),
        _ => None,
    }
}

/// Los formatos OOXML (docx, xlsx, pptx…) son ZIP; si en su lugar empiezan por la cabecera OLE (D0 CF 11 E0)
/// es que están cifrados con contraseña de apertura.
pub fn ooxml_cifrado(ruta: &std::path::Path, cabecera: &[u8]) -> bool {
    let ext = ruta.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let ooxml = ext.len() == 4 && (ext.ends_with('x') || ext.ends_with('m') || ext == "xlsb");
    ooxml && cabecera.starts_with(&[0xD0, 0xCF, 0x11, 0xE0])
}

/// Nombre comercial a partir de la versión interna y, si es Hacer clic y ejecutar, de los productos instalados.
pub fn nombre_version(numero: u32, productos_c2r: &str) -> String {
    let p = productos_c2r.to_ascii_lowercase();
    let anio = match numero {
        0 => return String::new(),
        ..=11 => return format!("Microsoft Office (versión {numero})"),
        12 => "2007",
        14 => "2010",
        15 => "2013",
        16 if p.contains("2024") => "2024",
        16 if p.contains("2021") => "2021",
        16 if p.contains("2019") => "2019",
        16 if p.contains("o365") || p.contains("365") => return "Microsoft 365".into(),
        16 => "2016",
        _ => return format!("Microsoft Office (versión {numero})"),
    };
    format!("Microsoft Office {anio}")
}

pub const PROTEGIDO: &str = "El documento está protegido con contraseña. Ábrelo en Office, quita la contraseña (Archivo → Información → Proteger) y vuelve a intentarlo.";

#[cfg(not(windows))]
pub fn info() -> InfoOffice { InfoOffice::default() }

#[cfg(not(windows))]
pub fn convertir(_entrada: &std::path::Path, _salida: &std::path::Path, _op: &Opciones, _cancelar: &std::sync::Arc<std::sync::atomic::AtomicBool>) -> Result<u64, String> {
    Err("La conversión de documentos de Office solo funciona en Windows.".into())
}

#[cfg(windows)]
pub use win::{convertir, info};

#[cfg(windows)]
mod win {
    use super::*;
    use std::collections::HashSet;
    use std::mem::ManuallyDrop;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};
    use windows::core::{BSTR, GUID, HRESULT, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, DISP_E_EXCEPTION, DISP_E_PARAMNOTFOUND, VARIANT_BOOL};
    use windows::Win32::System::Com::{
        CLSIDFromProgID, CoCreateInstance, CoInitializeEx, CoUninitialize, IDispatch, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
        COINIT_DISABLE_OLE1DDE, DISPATCH_FLAGS, DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, DISPPARAMS, EXCEPINFO,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Ole::DISPID_PROPERTYPUT;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CLASSES_ROOT, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    use windows::Win32::System::Variant::{VariantChangeType, VariantClear, VARENUM, VARIANT, VAR_CHANGE_FLAGS, VT_BOOL, VT_BSTR, VT_DISPATCH, VT_ERROR, VT_I4};

    /// Idioma para los nombres y llamadas COM: inglés (EE. UU.), como recomienda Microsoft para automatizar Excel.
    const LCID: u32 = 0x0409;

    fn ancho(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }

    // ───────────────────────── Detección ─────────────────────────

    fn leer_reg(raiz: HKEY, clave: &str, valor: Option<&str>) -> Option<String> {
        let k = ancho(clave);
        let v = valor.map(ancho);
        let pv = v.as_ref().map(|v| PCWSTR(v.as_ptr())).unwrap_or(PCWSTR::null());
        let mut buf = vec![0u16; 1024];
        let mut tam = (buf.len() * 2) as u32;
        let r = unsafe { RegGetValueW(raiz, PCWSTR(k.as_ptr()), pv, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut tam as *mut u32)) };
        if r.is_err() { return None; }
        let n = (tam as usize / 2).saturating_sub(1).min(buf.len());
        Some(String::from_utf16_lossy(&buf[..n]).trim_end_matches('\0').to_string())
    }

    /// «Word.Application.16» → 16
    fn version_de(progid: &str) -> Option<u32> {
        let cur = leer_reg(HKEY_CLASSES_ROOT, &format!("{progid}\\CurVer"), None)?;
        cur.rsplit('.').next()?.parse().ok()
    }

    pub fn info() -> InfoOffice {
        let w = version_de("Word.Application");
        let e = version_de("Excel.Application");
        let p = version_de("PowerPoint.Application");
        let numero = [w, e, p].iter().flatten().copied().max().unwrap_or(0);
        let c2r = leer_reg(HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration", Some("ProductReleaseIds")).unwrap_or_default();
        InfoOffice {
            instalado: numero > 0,
            version: nombre_version(numero, &c2r),
            numero,
            word: w.is_some(),
            excel: e.is_some(),
            powerpoint: p.is_some(),
            pdfa: numero >= 14,
            marcadores: numero >= 14,
        }
    }

    // ───────────────────────── VARIANT y IDispatch ─────────────────────────

    /// VARIANT que se libera solo.
    #[repr(transparent)]
    struct Var(VARIANT);
    impl Drop for Var {
        fn drop(&mut self) { unsafe { let _ = VariantClear(&mut self.0); } }
    }
    fn var(vt: VARENUM, rellenar: impl FnOnce(&mut windows::Win32::System::Variant::VARIANT_0_0_0)) -> Var {
        let mut v = VARIANT::default();
        unsafe {
            let dentro = &mut *v.Anonymous.Anonymous;
            dentro.vt = vt;
            rellenar(&mut dentro.Anonymous);
        }
        Var(v)
    }
    fn t(s: &str) -> Var { var(VT_BSTR, |a| a.bstrVal = ManuallyDrop::new(BSTR::from(s))) }
    fn n(i: i32) -> Var { var(VT_I4, |a| a.lVal = i) }
    fn b(x: bool) -> Var { var(VT_BOOL, |a| a.boolVal = VARIANT_BOOL(if x { -1 } else { 0 })) }
    /// Argumento opcional omitido
    fn falta() -> Var { var(VT_ERROR, |a| a.scode = DISP_E_PARAMNOTFOUND.0) }
    /// MsoTriState de PowerPoint: msoTrue = -1, msoFalse = 0
    fn tri(x: bool) -> Var { n(if x { -1 } else { 0 }) }

    impl Var {
        fn vt(&self) -> VARENUM { unsafe { self.0.Anonymous.Anonymous.vt } }
        fn objeto(&self) -> Result<Obj, String> {
            if self.vt() != VT_DISPATCH { return Err("Office devolvió un valor inesperado.".into()); }
            let d = unsafe { (*self.0.Anonymous.Anonymous.Anonymous.pdispVal).clone() };
            d.map(Obj).ok_or_else(|| "Office devolvió un objeto vacío.".into())
        }
        fn entero(&self) -> i32 {
            let mut destino = VARIANT::default();
            unsafe {
                if VariantChangeType(&mut destino, &self.0, VAR_CHANGE_FLAGS(0), VT_I4).is_ok() {
                    let r = destino.Anonymous.Anonymous.Anonymous.lVal;
                    let _ = VariantClear(&mut destino);
                    return r;
                }
            }
            0
        }
    }

    struct Obj(IDispatch);

    /// Error de una llamada COM con la descripción que da Office (si la hay).
    struct ErrCom { hr: HRESULT, desc: String }
    impl From<ErrCom> for String {
        fn from(e: ErrCom) -> String { traducir(&e) }
    }

    fn traducir(e: &ErrCom) -> String {
        let d = e.desc.to_lowercase();
        if d.contains("password") || d.contains("contraseña") || d.contains("contrasena") { return PROTEGIDO.into(); }
        match e.hr.0 as u32 {
            0x800A_03EC if d.is_empty() => "Excel no pudo exportar el libro (¿hojas vacías o sin nada que imprimir?).".into(),
            0x8001_0001 | 0x8001_010A => "Office está ocupado mostrando un aviso. Ciérralo e inténtalo de nuevo.".into(),
            0x8001_0108 | 0x8001_0114 | 0x8007_06BA | 0x8007_06BE | 0x8007_06BF => "Office se cerró durante la conversión.".into(),
            _ if !e.desc.is_empty() => format!("Office: {}", e.desc.trim()),
            _ => format!("Office devolvió el error 0x{:08X}.", e.hr.0 as u32),
        }
    }

    impl Obj {
        fn crear(progid: &str, programa: &str) -> Result<Obj, String> {
            let p = ancho(progid);
            let clsid: GUID = unsafe { CLSIDFromProgID(PCWSTR(p.as_ptr())) }
                .map_err(|_| format!("No se ha encontrado Microsoft {programa} en este equipo."))?;
            let d: IDispatch = unsafe { CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER) }.map_err(|e| match e.code().0 as u32 {
                0x8008_0005 => format!("No se pudo iniciar {programa}. Comprueba que Office está activado y ábrelo una vez a mano para cerrar cualquier aviso pendiente."),
                0x8007_0005 => format!("Windows no permite iniciar {programa} desde esta aplicación (acceso denegado)."),
                _ => format!("No se pudo iniciar {programa} ({}).", e.message()),
            })?;
            Ok(Obj(d))
        }

        fn id(&self, nombre: &str) -> Result<i32, ErrCom> {
            let w = ancho(nombre);
            let nombres = [PCWSTR(w.as_ptr())];
            let mut id = 0i32;
            unsafe { self.0.GetIDsOfNames(&GUID::zeroed(), nombres.as_ptr(), 1, LCID, &mut id) }
                .map_err(|e| ErrCom { hr: e.code(), desc: format!("«{nombre}» no disponible en esta versión de Office") })?;
            Ok(id)
        }

        fn invocar(&self, nombre: &str, flags: DISPATCH_FLAGS, args: Vec<Var>) -> Result<Var, ErrCom> {
            let id = self.id(nombre)?;
            // IDispatch recibe los argumentos en orden inverso
            let mut args: Vec<Var> = args.into_iter().rev().collect();
            let mut put = DISPID_PROPERTYPUT;
            let es_put = flags == DISPATCH_PROPERTYPUT;
            let params = DISPPARAMS {
                rgvarg: if args.is_empty() { std::ptr::null_mut() } else { args.as_mut_ptr() as *mut VARIANT },
                rgdispidNamedArgs: if es_put { &mut put } else { std::ptr::null_mut() },
                cArgs: args.len() as u32,
                cNamedArgs: if es_put { 1 } else { 0 },
            };
            // Office rechaza llamadas mientras está ocupado (RPC_E_CALL_REJECTED): se reintenta un rato
            let mut intentos = 0;
            loop {
                let mut res = Var(VARIANT::default());
                let mut exc = EXCEPINFO::default();
                let r = unsafe { self.0.Invoke(id, &GUID::zeroed(), LCID, flags, &params, Some(&mut res.0 as *mut VARIANT), Some(&mut exc as *mut EXCEPINFO), None) };
                match r {
                    Ok(()) => return Ok(res),
                    Err(e) => {
                        let hr = e.code();
                        if (hr.0 as u32 == 0x8001_0001 || hr.0 as u32 == 0x8001_010A) && intentos < 100 {
                            intentos += 1;
                            std::thread::sleep(Duration::from_millis(250));
                            continue;
                        }
                        let mut desc = String::new();
                        if hr == DISP_E_EXCEPTION {
                            if let Some(f) = exc.pfnDeferredFillIn { unsafe { let _ = f(&mut exc); } }
                            desc = exc.bstrDescription.to_string();
                            let hr2 = if exc.scode != 0 { HRESULT(exc.scode) } else { hr };
                            return Err(ErrCom { hr: hr2, desc });
                        }
                        return Err(ErrCom { hr, desc });
                    }
                }
            }
        }
        fn get(&self, nombre: &str) -> Result<Var, ErrCom> { self.invocar(nombre, DISPATCH_PROPERTYGET, vec![]) }
        fn obj(&self, nombre: &str) -> Result<Obj, String> { self.get(nombre).map_err(String::from)?.objeto() }
        fn put(&self, nombre: &str, v: Var) -> Result<(), ErrCom> { self.invocar(nombre, DISPATCH_PROPERTYPUT, vec![v]).map(|_| ()) }
        /// Asignación que puede fallar sin importancia (propiedad que no existe en versiones antiguas)
        fn poner(&self, nombre: &str, v: Var) { let _ = self.put(nombre, v); }
        fn llamar(&self, nombre: &str, args: Vec<Var>) -> Result<Var, ErrCom> {
            self.invocar(nombre, DISPATCH_METHOD | DISPATCH_PROPERTYGET, args)
        }
    }

    // ───────────────────────── Conversión por programa ─────────────────────────

    const MSO_AUTOMATION_SECURITY_FORCE_DISABLE: i32 = 3;
    /// Contraseña ficticia: si el documento no tiene contraseña se ignora; si la tiene, Office da error
    /// en lugar de quedarse esperando a que alguien la escriba.
    const CLAVE_FALSA: &str = "\u{1}pdftool\u{1}";

    fn word(entrada: &str, salida: &str, op: &Opciones) -> Result<(), String> {
        let app = Obj::crear("Word.Application", "Word")?;
        app.poner("Visible", b(false));
        app.poner("DisplayAlerts", n(0)); // wdAlertsNone
        app.poner("AutomationSecurity", n(MSO_AUTOMATION_SECURITY_FORCE_DISABLE));
        let r = (|| -> Result<(), String> {
            let docs = app.obj("Documents")?;
            // Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate, Revert,
            //      WritePasswordDocument, WritePasswordTemplate, Format, Encoding, Visible, OpenAndRepair, DocumentDirection, NoEncodingDialog)
            let doc = docs.llamar("Open", vec![t(entrada), b(false), b(true), b(false), t(CLAVE_FALSA), t(CLAVE_FALSA), b(false),
                falta(), falta(), falta(), falta(), b(false), b(false), falta(), b(true)])?.objeto()?;
            // ExportAsFixedFormat(OutputFileName, ExportFormat=wdExportFormatPDF, OpenAfterExport, OptimizeFor=Print, Range=All,
            //      From, To, Item=DocumentContent, IncludeDocProps, KeepIRM, CreateBookmarks, DocStructureTags, BitmapMissingFonts, UseISO19005_1)
            let res = doc.llamar("ExportAsFixedFormat", vec![t(salida), n(17), b(false), n(0), n(0), n(1), n(1), n(0), b(true), b(true),
                n(if op.marcadores { 1 } else { 0 }), b(true), b(true), b(op.pdfa)]);
            let _ = doc.llamar("Close", vec![n(0)]); // wdDoNotSaveChanges
            res.map(|_| ()).map_err(String::from)
        })();
        let _ = app.llamar("Quit", vec![n(0)]);
        r
    }

    fn excel(entrada: &str, salida: &str, op: &Opciones) -> Result<(), String> {
        let app = Obj::crear("Excel.Application", "Excel")?;
        app.poner("Visible", b(false));
        app.poner("DisplayAlerts", b(false));
        app.poner("ScreenUpdating", b(false));
        app.poner("EnableEvents", b(false));
        app.poner("AskToUpdateLinks", b(false));
        app.poner("AutomationSecurity", n(MSO_AUTOMATION_SECURITY_FORCE_DISABLE));
        let r = (|| -> Result<(), String> {
            let libros = app.obj("Workbooks")?;
            // Open(Filename, UpdateLinks, ReadOnly, Format, Password, WriteResPassword, IgnoreReadOnlyRecommended,
            //      Origin, Delimiter, Editable, Notify, Converter, AddToMru)
            let libro = libros.llamar("Open", vec![t(entrada), n(0), b(true), falta(), t(CLAVE_FALSA), falta(), b(true),
                falta(), falta(), falta(), b(false), falta(), b(false)])?.objeto()?;
            let res = (|| -> Result<(), String> {
                if op.excel_ajustar {
                    // Sin comunicar con la impresora en cada cambio (mucho más rápido; Excel 2010+)
                    app.poner("PrintCommunication", b(false));
                    let hojas = libro.obj("Worksheets")?;
                    let total = hojas.get("Count").map_err(String::from)?.entero();
                    for i in 1..=total {
                        if let Ok(hoja) = hojas.invocar("Item", DISPATCH_PROPERTYGET, vec![n(i)]).map_err(String::from).and_then(|v| v.objeto()) {
                            if let Ok(ps) = hoja.obj("PageSetup") {
                                ps.poner("Zoom", b(false));
                                ps.poner("FitToPagesWide", n(1));
                                ps.poner("FitToPagesTall", b(false));
                            }
                        }
                    }
                    app.poner("PrintCommunication", b(true));
                }
                let destino = if op.excel_alcance == "hoja" { libro.obj("ActiveSheet")? } else { Obj(libro.0.clone()) };
                // ExportAsFixedFormat(Type=xlTypePDF, Filename, Quality=Standard, IncludeDocProperties, IgnorePrintAreas)
                destino.llamar("ExportAsFixedFormat", vec![n(0), t(salida), n(0), b(true), b(false)]).map(|_| ()).map_err(String::from)
            })();
            let _ = libro.llamar("Close", vec![b(false)]);
            res
        })();
        let _ = app.llamar("Quit", vec![]);
        r
    }

    fn powerpoint(entrada: &str, salida: &str, op: &Opciones) -> Result<(), String> {
        let app = Obj::crear("PowerPoint.Application", "PowerPoint")?;
        // PowerPoint no admite Visible = false: se abre la presentación sin ventana
        app.poner("DisplayAlerts", n(1)); // ppAlertsNone
        app.poner("AutomationSecurity", n(MSO_AUTOMATION_SECURITY_FORCE_DISABLE));
        let presentaciones = app.obj("Presentations")?;
        // PowerPoint solo tiene una instancia: si el usuario ya lo tenía abierto, no se cierra al terminar
        let ya_abiertas = presentaciones.get("Count").map(|v| v.entero()).unwrap_or(0);
        let r = (|| -> Result<(), String> {
            // Open(FileName, ReadOnly, Untitled, WithWindow)
            let pres = presentaciones.llamar("Open", vec![t(entrada), tri(true), tri(false), tri(false)])?.objeto()?;
            let tipo_salida = match op.ppt_salida.as_str() {
                "notas" => 5,  // ppPrintOutputNotesPages
                "doc2" => 2,   // ppPrintOutputTwoSlideHandouts
                "doc3" => 3,   // ppPrintOutputThreeSlideHandouts
                "doc6" => 4,   // ppPrintOutputSixSlideHandouts
                _ => 1,        // ppPrintOutputSlides
            };
            // ExportAsFixedFormat(Path, FixedFormatType=PDF, Intent=Print, FrameSlides, HandoutOrder, OutputType, PrintHiddenSlides,
            //      PrintRange, RangeType=ppPrintAll, SlideShowName, IncludeDocProperties, KeepIRMSettings, DocStructureTags,
            //      BitmapMissingFonts, UseISO19005_1)
            let mut res = pres.llamar("ExportAsFixedFormat", vec![t(salida), n(2), n(2), tri(tipo_salida != 1), n(1), n(tipo_salida), tri(false),
                falta(), n(1), t(""), b(true), b(true), b(true), b(true), b(op.pdfa)]).map(|_| ()).map_err(String::from);
            // Algunas versiones rechazan ExportAsFixedFormat por automatización: «Guardar como PDF» simple
            if res.is_err() && tipo_salida == 1 && !Path::new(salida).exists() {
                res = pres.llamar("SaveAs", vec![t(salida), n(32)]).map(|_| ()).map_err(String::from); // ppSaveAsPDF
            }
            let _ = pres.llamar("Close", vec![]);
            res
        })();
        if ya_abiertas == 0 { let _ = app.llamar("Quit", vec![]); }
        r
    }

    // ───────────────────────── Procesos de Office ─────────────────────────

    fn pids_de(ejecutable: &str) -> HashSet<u32> {
        let mut r = HashSet::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return r };
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    let fin = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    if String::from_utf16_lossy(&e.szExeFile[..fin]).eq_ignore_ascii_case(ejecutable) { r.insert(e.th32ProcessID); }
                    if Process32NextW(snap, &mut e).is_err() { break; }
                }
            }
            let _ = CloseHandle(snap);
        }
        r
    }

    fn terminar(pid: u32) {
        unsafe {
            if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                let _ = TerminateProcess(h, 1);
                let _ = CloseHandle(h);
            }
        }
    }

    // ───────────────────────── Entrada pública ─────────────────────────

    static CONTADOR: AtomicU32 = AtomicU32::new(0);

    /// Nombre seguro para Office: sin caracteres que Excel no acepta ([ ]) ni rutas largas.
    fn nombre_seguro(ruta: &Path) -> String {
        let base = ruta.file_stem().and_then(|s| s.to_str()).unwrap_or("documento");
        let limpio: String = base.chars().map(|c| if "[]#%{}~&".contains(c) { '_' } else { c }).take(80).collect();
        let ext = ruta.extension().and_then(|e| e.to_str()).unwrap_or("");
        format!("{}.{}", if limpio.trim().is_empty() { "documento".into() } else { limpio }, ext)
    }

    pub fn convertir(entrada: &Path, salida: &Path, op: &Opciones, cancelar: &Arc<AtomicBool>) -> Result<u64, String> {
        let tipo = tipo_de(entrada).ok_or("Formato no admitido: solo documentos de Word, Excel y PowerPoint.")?;
        let mut cab = [0u8; 8];
        {
            use std::io::Read;
            let mut f = std::fs::File::open(entrada).map_err(|e| format!("No se puede leer el documento: {e}"))?;
            let _ = f.read(&mut cab);
        }
        if ooxml_cifrado(entrada, &cab) { return Err(PROTEGIDO.into()); }

        // Carpeta temporal propia: copia del documento y PDF de salida
        let tmp: PathBuf = std::env::temp_dir().join(format!("pdftool-office-{}-{}", std::process::id(), CONTADOR.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&tmp).map_err(|e| format!("No se pudo crear la carpeta temporal: {e}"))?;
        let copia = tmp.join(nombre_seguro(entrada));
        let pdf_tmp = copia.with_extension("pdf");
        let limpiar = || { let _ = std::fs::remove_dir_all(&tmp); };
        if let Err(e) = std::fs::copy(entrada, &copia) { limpiar(); return Err(format!("No se pudo copiar el documento: {e}")); }

        let antes = pids_de(tipo.ejecutable());
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let (c, p, o) = (copia.to_string_lossy().to_string(), pdf_tmp.to_string_lossy().to_string(), op.clone());
        std::thread::spawn(move || {
            unsafe { let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE); }
            let r = match tipo { Tipo::Word => word(&c, &p, &o), Tipo::Excel => excel(&c, &p, &o), Tipo::PowerPoint => powerpoint(&c, &p, &o) };
            unsafe { CoUninitialize(); }
            let _ = tx.send(r);
        });

        let limite = Duration::from_secs(op.tiempo_max.clamp(20, 900));
        let inicio = Instant::now();
        let resultado = loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(r) => break r,
                Err(mpsc::RecvTimeoutError::Disconnected) => break Err(format!("{} terminó de forma inesperada.", tipo.nombre())),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let cancelado = cancelar.load(Ordering::Relaxed);
                    if cancelado || inicio.elapsed() > limite {
                        // Cerrar solo el proceso de Office arrancado para esta conversión
                        let nuevos: Vec<u32> = pids_de(tipo.ejecutable()).difference(&antes).copied().collect();
                        for pid in &nuevos { terminar(*pid); }
                        let _ = rx.recv_timeout(Duration::from_secs(5));
                        break Err(if cancelado {
                            "Operación cancelada".into()
                        } else if nuevos.is_empty() {
                            format!("{} no respondió en {} s. Si lo tienes abierto, revisa si muestra algún aviso y ciérralo.", tipo.nombre(), limite.as_secs())
                        } else {
                            format!("{} no respondió en {} s y se ha cerrado. Puede que el documento pida contraseña o muestre un aviso al abrirlo.", tipo.nombre(), limite.as_secs())
                        });
                    }
                }
            }
        };

        let fin = resultado.and_then(|_| {
            if !pdf_tmp.exists() { return Err(format!("{} terminó sin crear el PDF.", tipo.nombre())); }
            std::fs::copy(&pdf_tmp, salida).map_err(|e| format!("No se pudo guardar el PDF: {e}"))
        });
        // Office puede tardar un instante en soltar los archivos
        for _ in 0..10 { if std::fs::remove_dir_all(&tmp).is_ok() || !tmp.exists() { break; } std::thread::sleep(Duration::from_millis(200)); }
        fin
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;
    use std::path::Path;

    #[test]
    fn tipos_por_extension() {
        assert_eq!(tipo_de(Path::new("a.DOCX")), Some(Tipo::Word));
        assert_eq!(tipo_de(Path::new("c:/x/b.xlsm")), Some(Tipo::Excel));
        assert_eq!(tipo_de(Path::new("c.ppsx")), Some(Tipo::PowerPoint));
        assert_eq!(tipo_de(Path::new("d.csv")), Some(Tipo::Excel));
        assert_eq!(tipo_de(Path::new("e.pdf")), None);
        assert_eq!(tipo_de(Path::new("sin_extension")), None);
    }

    #[test]
    fn deteccion_de_cifrado() {
        let ole = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        let zip = *b"PK\x03\x04\0\0\0\0";
        assert!(ooxml_cifrado(Path::new("a.docx"), &ole));
        assert!(ooxml_cifrado(Path::new("a.xlsm"), &ole));
        assert!(!ooxml_cifrado(Path::new("a.docx"), &zip));
        // los formatos antiguos siempre son OLE: no indica contraseña
        assert!(!ooxml_cifrado(Path::new("a.doc"), &ole));
        assert!(!ooxml_cifrado(Path::new("a.xls"), &ole));
    }

    #[test]
    fn nombres_de_version() {
        assert_eq!(nombre_version(16, "ProPlus2019Volume"), "Microsoft Office 2019");
        assert_eq!(nombre_version(16, "O365ProPlusRetail"), "Microsoft 365");
        assert_eq!(nombre_version(16, "ProPlus2021Volume,VisioPro2021Volume"), "Microsoft Office 2021");
        assert_eq!(nombre_version(16, ""), "Microsoft Office 2016");
        assert_eq!(nombre_version(14, ""), "Microsoft Office 2010");
        assert_eq!(nombre_version(0, ""), "");
    }
}
