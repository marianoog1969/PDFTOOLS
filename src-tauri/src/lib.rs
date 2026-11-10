use lopdf::Document;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use base64::Engine;
use tauri::Emitter;
use tauri::Manager;

#[cfg(windows)]
mod bloqueo;

mod imagen_pdf;
mod anotaciones;
mod firma;
mod validar;
mod ltv;
mod edicion;
mod organizar;
mod imprimir;
mod sondeo;
mod office;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Estado compartido entre comandos: señal de cancelación y PID del proceso externo activo.
pub struct EstadoApp {
    pub cancelar: Arc<AtomicBool>,
    pub pid_proceso: Arc<Mutex<Option<u32>>>,
}

impl Default for EstadoApp {
    fn default() -> Self {
        Self {
            cancelar: Arc::new(AtomicBool::new(false)),
            pid_proceso: Arc::new(Mutex::new(None)),
        }
    }
}

fn esta_cancelado(estado: &EstadoApp) -> bool {
    estado.cancelar.load(Ordering::Relaxed)
}

fn ejecutar_con_cancelacion(
    mut child: std::process::Child,
    estado: &EstadoApp,
) -> Result<std::process::ExitStatus, String> {
    *estado.pid_proceso.lock().unwrap() = Some(child.id());
    loop {
        if esta_cancelado(estado) {
            let _ = child.kill();
            // Esperar a que el SO libere de verdad el proceso (y sus handles de fichero)
            // antes de devolver el control; si no, en Windows un remove_dir_all()
            // inmediato después puede fallar con "en uso por otro proceso" y la
            // carpeta temporal queda huérfana para siempre.
            let _ = child.wait();
            *estado.pid_proceso.lock().unwrap() = None;
            return Err("Operación cancelada".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                *estado.pid_proceso.lock().unwrap() = None;
                return Ok(status);
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => {
                *estado.pid_proceso.lock().unwrap() = None;
                return Err(e.to_string());
            }
        }
    }
}

fn comando_silencioso(ruta: &PathBuf) -> Command {
    let mut cmd = Command::new(ruta);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Como comando_silencioso pero añade el directorio del ejecutable al PATH del proceso hijo
/// y establece ese directorio como directorio de trabajo.
/// Necesario para que gswin64c.exe encuentre gsdll64.dll en rutas de red.
fn comando_gs(ruta_gs: &PathBuf) -> Command {
    let mut cmd = Command::new(ruta_gs);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    // Añadir el directorio de GS al PATH para que Windows encuentre gsdll64.dll
    if let Some(dir) = ruta_gs.parent() {
        let path_actual = std::env::var("PATH").unwrap_or_default();
        let nuevo_path = format!("{};{}", dir.display(), path_actual);
        cmd.env("PATH", nuevo_path);
        cmd.current_dir(dir);
    }
    cmd
}

/// Ruta de red de respaldo: si UTILS no está junto al .exe que se está
/// ejecutando (por ejemplo, porque alguien copió el .exe a su escritorio en
/// vez de crear un acceso directo), se busca aquí como segunda opción.
/// Cambia esta ruta si la ubicación de la carpeta compartida varía.
const RUTA_UTILS_RED: &str = r"P:\APPS\PDFTOOLS\UTILS";

fn ruta_util(relativa: &str) -> Result<PathBuf, String> {
    let ruta_red = PathBuf::from(RUTA_UTILS_RED).join(relativa);
    if ruta_red.exists() {
        return Ok(ruta_red);
    }

    let exe = std::env::current_exe().map_err(|e| format!("No se pudo localizar el ejecutable: {}", e))?;
    let carpeta = exe
        .parent()
        .ok_or_else(|| "No se pudo determinar la carpeta del ejecutable".to_string())?;
    let ruta_local = carpeta.join("UTILS").join(relativa);

    if ruta_local.exists() {
        return Ok(ruta_local);
    }

    Err(format!(
        "No se encuentra '{}'.\nProbado en red: {}\nProbado junto al programa: {}",
        relativa,
        ruta_red.display(),
        ruta_local.display()
    ))
}

#[derive(Serialize)]
struct EstadoUtils {
    gs: bool,
    tesseract: bool,
    version_gs: Option<String>,
    version_tesseract: Option<String>,
    carpeta_local: String,
    carpeta_red: String,
}

fn carpeta_utils_local() -> PathBuf {
    std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("UTILS"))).unwrap_or_else(|| PathBuf::from("UTILS"))
}

/// Abre (creándola si no existe) la carpeta UTILS junto al programa, para copiar ahí Ghostscript / Tesseract.
#[tauri::command]
fn abrir_carpeta_utils() -> Result<String, String> {
    let c = carpeta_utils_local();
    fs::create_dir_all(&c).map_err(|e| format!("No se pudo crear {}: {}", c.display(), e))?;
    Command::new("explorer").arg(&c).spawn().map_err(|e| format!("No se pudo abrir el explorador: {}", e))?;
    Ok(c.display().to_string())
}

#[tauri::command]
async fn estado_utils() -> EstadoUtils {
    tauri::async_runtime::spawn_blocking(|| {
        let gs = ruta_util("gs/bin/gswin64c.exe").is_ok();
        let tesseract = ruta_util("tesseract/tesseract.exe").is_ok();

        let version_gs = if gs {
            ruta_util("gs/bin/gswin64c.exe").ok().and_then(|ruta| {
                comando_silencioso(&ruta)
                    .arg("--version")
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .map(|s| s.trim().to_string())
            })
        } else {
            None
        };

        let version_tesseract = if tesseract {
            ruta_util("tesseract/tesseract.exe").ok().and_then(|ruta| {
                comando_silencioso(&ruta)
                    .arg("--version")
                    .output()
                    .ok()
                    .and_then(|o| {
                        let salida = String::from_utf8_lossy(&o.stdout).to_string()
                            + &String::from_utf8_lossy(&o.stderr);
                        salida.lines().next().map(|l| l.trim().to_string())
                    })
            })
        } else {
            None
        };

        EstadoUtils { gs, tesseract, version_gs, version_tesseract,
            carpeta_local: carpeta_utils_local().display().to_string(), carpeta_red: RUTA_UTILS_RED.to_string() }
    })
    .await
    .unwrap_or(EstadoUtils { gs: false, tesseract: false, version_gs: None, version_tesseract: None, carpeta_local: String::new(), carpeta_red: RUTA_UTILS_RED.to_string() })
}

/// Un log por día: `logs\\pdftool_AAAA-MM-DD.log` junto al programa. Se conservan los últimos 30 días.
fn dir_logs() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("logs")))
}

fn fecha_valida(f: &str) -> bool {
    f.len() == 10 && f.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() })
}

fn ruta_log(fecha: &str) -> Option<PathBuf> {
    if !fecha_valida(fecha) { return None; }
    dir_logs().map(|d| d.join(format!("pdftool_{}.log", fecha)))
}

fn purgar_logs_antiguos() {
    const DIAS: u64 = 30;
    if let Some(dir) = dir_logs() {
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.flatten() {
                let nombre = e.file_name().to_string_lossy().to_string();
                if !(nombre.starts_with("pdftool_") && nombre.ends_with(".log")) { continue; }
                let viejo = e.metadata().and_then(|m| m.modified()).ok()
                    .and_then(|t| t.elapsed().ok())
                    .map(|d| d.as_secs() > DIAS * 86400)
                    .unwrap_or(false);
                if viejo { let _ = fs::remove_file(e.path()); }
            }
        }
    }
}

// ───── Log de errores: `logs\errores.log` junto al programa ─────
// Recoge los fallos internos (pánicos de Rust, errores de la interfaz) y las trazas de pasos delicados,
// para poder saber qué pasaba si la aplicación se cierra sola. Se recorta solo al pasar de 1 MB.
fn marca_utc() -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (dias, resto) = (t.div_euclid(86400), t.rem_euclid(86400));
    // Fecha civil a partir de días desde 1970 (algoritmo de H. Hinnant)
    let z = dias + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC", y, m, d, resto / 3600, (resto % 3600) / 60, resto % 60)
}

pub(crate) fn registrar_error(origen: &str, mensaje: &str) {
    use std::io::Write;
    let Some(dir) = dir_logs() else { return };
    let _ = fs::create_dir_all(&dir);
    let ruta = dir.join("errores.log");
    if fs::metadata(&ruta).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = fs::rename(&ruta, dir.join("errores.anterior.log"));
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&ruta) {
        let _ = writeln!(f, "{} [{}] v{} {}", marca_utc(), origen, env!("CARGO_PKG_VERSION"), mensaje);
    }
}

/// Instala un gancho que anota los pánicos (con su ubicación y la pila de llamadas) antes de que la
/// aplicación se cierre: con `panic = "abort"` y sin consola, de otro modo se cerraría sin dejar rastro.
fn instalar_gancho_panico() {
    std::panic::set_hook(Box::new(|info| {
        let donde = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(sin mensaje)".into());
        let pila = std::backtrace::Backtrace::force_capture();
        registrar_error("PANICO", &format!("{} en {}\n{}", msg, donde, pila));
    }));
}

/// Errores de la interfaz (excepciones no capturadas, promesas rechazadas) enviados desde JavaScript.
#[tauri::command]
fn registrar_error_js(origen: String, mensaje: String) {
    registrar_error(&origen.chars().take(40).collect::<String>(), &mensaje.chars().take(4000).collect::<String>());
}

#[tauri::command]
fn leer_errores() -> Result<String, String> {
    let ruta = dir_logs().map(|d| d.join("errores.log")).ok_or("No se pudo determinar la ruta del log")?;
    match fs::read_to_string(&ruta) {
        Ok(t) => { let n = t.len(); Ok(if n > 200_000 { t[t.char_indices().map(|(i, _)| i).find(|&i| i >= n - 200_000).unwrap_or(0)..].to_string() } else { t }) }
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn escribir_log(linea: String, fecha: String) {
    static PURGADO: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if let Some(ruta) = ruta_log(&fecha) {
        use std::io::Write;
        if let Some(d) = ruta.parent() { let _ = fs::create_dir_all(d); }
        if !PURGADO.swap(true, std::sync::atomic::Ordering::Relaxed) { purgar_logs_antiguos(); }
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&ruta) {
            let _ = writeln!(f, "{}", linea);
        }
    }
}

#[tauri::command]
fn abrir_carpeta(ruta: String) -> Result<(), String> {
    let p = std::path::Path::new(&ruta);
    let carpeta = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
    Command::new("explorer")
        .arg(carpeta)
        .spawn()
        .map_err(|e| format!("No se pudo abrir el explorador: {}", e))?;
    Ok(())
}

#[tauri::command]
fn abrir_archivo(ruta: String) -> Result<(), String> {
    // explorer.exe con la ruta de un archivo lo abre con la app asociada
    // (igual que un doble clic), no es necesario ShellExecute aparte.
    Command::new("explorer")
        .arg(&ruta)
        .spawn()
        .map_err(|e| format!("No se pudo abrir el archivo: {}", e))?;
    Ok(())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Solo se permiten URLs de la lista blanca.
    const PERMITIDAS: [&str; 1] = ["https://www.paypal.me/marianoog"];
    if !PERMITIDAS.contains(&url.as_str()) {
        return Err("URL no permitida".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("No se pudo abrir el enlace: {}", e))?;
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open").arg(&url).spawn().map_err(|e| format!("{}", e))?;
    }
    Ok(())
}

#[derive(Serialize)]
struct ProcesoInfo {
    nombre: String,
    pid: u32,
}

#[tauri::command]
fn comprobar_bloqueo(rutas: Vec<String>) -> Vec<ProcesoInfo> {
    let existentes: Vec<String> = rutas
        .into_iter()
        .filter(|r| std::path::Path::new(r).exists())
        .collect();

    #[cfg(windows)]
    {
        bloqueo::procesos_bloqueando(&existentes)
            .into_iter()
            .map(|p| ProcesoInfo {
                nombre: p.nombre,
                pid: p.pid,
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        let _ = existentes;
        Vec::new()
    }
}

#[tauri::command]
fn cerrar_procesos(pids: Vec<u32>) -> Result<(), String> {
    #[cfg(windows)]
    {
        for pid in pids {
            bloqueo::cerrar_proceso(pid)?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = pids;
        Err("No soportado en este sistema operativo".into())
    }
}

/// Combina una lista de PDFs en uno usando Ghostscript.
/// Usado internamente por el pipeline de OCR y por Extraer páginas.
fn combinar_documentos_gs(rutas: &[String], salida: &str, estado: &EstadoApp) -> Result<(), String> {
    if rutas.is_empty() {
        return Err("No se han indicado archivos".into());
    }

    let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;

    if esta_cancelado(estado) {
        return Err("Operación cancelada".into());
    }

    let mut args = vec![
        "-sDEVICE=pdfwrite".to_string(),
        "-dPDFSETTINGS=/prepress".to_string(),
        "-dCompatibilityLevel=1.6".to_string(),
        "-dNOPAUSE".to_string(),
        "-dBATCH".to_string(),
        "-dQUIET".to_string(),
        format!("-sOutputFile={}", salida),
    ];
    args.extend(rutas.iter().cloned());

    let child = comando_gs(&ruta_gs)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Error lanzando Ghostscript: {}", e))?;

    let status = ejecutar_con_cancelacion(child, estado)?;

    if !status.success() {
        return Err("Ghostscript falló al combinar páginas".into());
    }

    Ok(())
}

#[tauri::command]
async fn combinar_pdfs(
    app: tauri::AppHandle,
    rutas: Vec<String>,
    salida: String,
) -> Result<(), String> {
    if rutas.is_empty() {
        return Err("No se han indicado archivos".into());
    }

    let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;
    let estado = app.state::<EstadoApp>();

    if esta_cancelado(&estado) {
        return Err("Operación cancelada".into());
    }

    let cancelar = estado.cancelar.clone();
    let pid_proceso = estado.pid_proceso.clone();
    let salida_clon = salida.clone();

    let status = tauri::async_runtime::spawn_blocking(move || {
        // Ghostscript acepta múltiples archivos de entrada directamente.
        // -dBATCH -dNOPAUSE aseguran que no pide confirmación.
        // -dPDFSETTINGS=/prepress conserva la máxima calidad al combinar.
        let mut args = vec![
            "-sDEVICE=pdfwrite".to_string(),
            "-dPDFSETTINGS=/prepress".to_string(),
            "-dCompatibilityLevel=1.6".to_string(),
            "-dNOPAUSE".to_string(),
            "-dBATCH".to_string(),
            "-dQUIET".to_string(),
            format!("-sOutputFile={}", salida_clon),
        ];
        // Añadir cada PDF de entrada como argumento final
        args.extend(rutas.iter().cloned());

        let child = comando_gs(&ruta_gs)
            .args(&args)
            .spawn()
            .map_err(|e| format!("Error lanzando Ghostscript: {}", e))?;

        let estado_tmp = EstadoApp { cancelar, pid_proceso };
        ejecutar_con_cancelacion(child, &estado_tmp)
    })
    .await
    .map_err(|e| format!("Error interno: {}", e))??;

    if !status.success() {
        return Err("Ghostscript falló al combinar los PDF".into());
    }

    Ok(())
}

#[derive(Serialize)]
struct ResultadoCompresion {
    tamano_entrada: u64,
    tamano_salida: u64,
    nivel: String,
    cumple: bool,
}

/// Argumentos extra de Ghostscript para que la compresión sea realmente efectiva.
///
/// Los presets /ebook y /printer por sí solos casi no reducen los escaneos:
///  - Ghostscript deja pasar tal cual las imágenes JPEG (PassThroughJPEGImages=true),
///    así que un PDF escaneado ya en JPEG no se recomprime.
///  - Solo baja la resolución si la imagen supera 1,5 veces la del preset
///    (p. ej. >225 ppp en /ebook): un escaneo a 200 ppp no se toca.
/// Se fuerza la recompresión/reducción en screen, ebook y printer. En /prepress
/// (máxima calidad) se respeta el comportamiento original.
fn args_compresion_extra(nivel: &str) -> Vec<String> {
    if nivel == "prepress" {
        return vec![];
    }
    // (resolución objetivo ppp, QFactor JPEG: mayor = más compresión / menos calidad)
    let (ppp, q) = match nivel {
        "extremo" => (50, 2.2),
        "screen" => (72, 1.5),
        "ebook" => (150, 1.2),
        _ => (200, 0.9), // printer
    };
    let mut a: Vec<String> = [
        "-dPassThroughJPEGImages=false",
        "-dDetectDuplicateImages=true",
        "-dDownsampleColorImages=true",
        "-dDownsampleGrayImages=true",
        "-dColorImageDownsampleType=/Bicubic",
        "-dGrayImageDownsampleType=/Bicubic",
        "-dColorImageDownsampleThreshold=1.0",
        "-dGrayImageDownsampleThreshold=1.0",
    ].iter().map(|s| s.to_string()).collect();
    a.push(format!("-dColorImageResolution={}", ppp));
    a.push(format!("-dGrayImageResolution={}", ppp));
    a.push("-c".to_string());
    a.push(format!(
        "<< /ColorACSImageDict << /QFactor {q} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >> \
           /ColorImageDict << /QFactor {q} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >> \
           /GrayACSImageDict << /QFactor {q} /Blend 1 /HSamples [1 1 1 1] /VSamples [1 1 1 1] >> \
           /GrayImageDict << /QFactor {q} /Blend 1 /HSamples [1 1 1 1] /VSamples [1 1 1 1] >> >> setdistillerparams",
        q = q
    ));
    a
}

#[derive(Serialize)]
struct AnalisisCompresion {
    tam: u64,
    tam_imagenes: u64,
    n_imagenes: u32,
    ppp_max: u32,
    /// Tamaño estimado por nivel: [screen, ebook, printer, prepress]
    estimado: [u64; 4],
}

fn nombre_filtros(d: &lopdf::Dictionary) -> Vec<String> {
    match d.get(b"Filter") {
        Ok(lopdf::Object::Name(n)) => vec![String::from_utf8_lossy(n).to_string()],
        Ok(lopdf::Object::Array(a)) => a.iter().filter_map(|o| o.as_name().ok().map(|n| String::from_utf8_lossy(n).to_string())).collect(),
        _ => vec![],
    }
}

fn num(o: Option<&lopdf::Object>) -> Option<f64> {
    o.and_then(|o| o.as_float().ok().map(|f| f as f64).or_else(|| o.as_i64().ok().map(|i| i as f64)))
}

/// Estima, sin comprimir, cuánto reducirá cada nivel. Se basa en las imágenes del PDF
/// (tamaño, resolución aproximada y tipo de compresión). Es solo una aproximación.
#[tauri::command]
async fn analizar_compresion(ruta: String) -> Result<AnalisisCompresion, String> {
    tauri::async_runtime::spawn_blocking(move || analizar_sync(&ruta))
        .await
        .map_err(|e| e.to_string())?
}

fn analizar_sync(ruta: &str) -> Result<AnalisisCompresion, String> {
    {
        let ruta = ruta.to_string();
        let tam = fs::metadata(&ruta).map(|m| m.len()).map_err(|e| e.to_string())?;
        let doc = Document::load(&ruta).map_err(|e| format!("No se pudo analizar: {}", e))?;

        // Ancho de página (pt) de la primera página; A4 si no se encuentra
        let mut ancho_pt = 595.0_f64;
        if let Some((_, id)) = doc.get_pages().into_iter().next() {
            let mut actual = Some(id);
            let mut saltos = 0;
            while let Some(i) = actual {
                if saltos > 8 { break; }
                saltos += 1;
                let Ok(d) = doc.get_dictionary(i) else { break };
                if let Ok(mb) = d.get(b"MediaBox").and_then(|o| o.as_array()) {
                    if mb.len() == 4 {
                        if let (Some(x0), Some(x1)) = (num(mb.first()), num(mb.get(2))) {
                            let w = (x1 - x0).abs();
                            if w > 50.0 { ancho_pt = w; }
                        }
                    }
                    break;
                }
                actual = d.get(b"Parent").ok().and_then(|o| o.as_reference().ok());
            }
        }
        let ancho_in = ancho_pt / 72.0;

        let mut tam_img: u64 = 0;
        let mut n_img: u32 = 0;
        let mut ppp_max: f64 = 0.0;
        let mut est = [0f64; 3]; // screen, ebook, printer (solo imágenes)
        let objetivos = [72.0_f64, 150.0, 200.0];

        for (_, obj) in doc.objects.iter() {
            let lopdf::Object::Stream(st) = obj else { continue };
            let d = &st.dict;
            let es_img = d.get(b"Subtype").ok().and_then(|o| o.as_name().ok()).map(|n| n == b"Image").unwrap_or(false);
            if !es_img { continue; }
            let bytes = st.content.len() as f64;
            let w = num(d.get(b"Width").ok()).unwrap_or(0.0);
            let h = num(d.get(b"Height").ok()).unwrap_or(0.0);
            let bpc = num(d.get(b"BitsPerComponent").ok()).unwrap_or(8.0);
            let mascara = d.get(b"ImageMask").ok().and_then(|o| o.as_bool().ok()).unwrap_or(false);
            n_img += 1;
            tam_img += bytes as u64;
            if w <= 0.0 || h <= 0.0 { for e in est.iter_mut() { *e += bytes; } continue; }
            let ppp = w / ancho_in;
            if ppp > ppp_max { ppp_max = ppp; }
            let filtros = nombre_filtros(d);
            let jpeg = filtros.iter().any(|f| f == "DCTDecode");
            let bitonal = mascara || bpc == 1.0 || filtros.iter().any(|f| f == "CCITTFaxDecode" || f == "JBIG2Decode");
            for k in 0..3 {
                if bitonal { est[k] += bytes; continue; }
                let esc = (objetivos[k] / ppp).min(1.0).powi(2);
                // calidad: JPEG ya comprimido se recomprime poco; Flate/sin comprimir gana mucho al pasar a JPEG
                let calidad: f64 = if jpeg { [0.65, 0.68, 0.75][k] } else { [0.08, 0.13, 0.15][k] };
                let calidad = if esc < 1.0 && jpeg { calidad.max(0.5) } else { calidad };
                est[k] += bytes * esc * calidad;
            }
        }

        let resto = (tam.saturating_sub(tam_img)) as f64;
        let mut estimado = [0u64; 4];
        for k in 0..3 {
            let v = (resto * 0.97 + est[k]).min(tam as f64);
            estimado[k] = v.max(1.0) as u64;
        }
        estimado[3] = tam;
        Ok(AnalisisCompresion { tam, tam_imagenes: tam_img, n_imagenes: n_img, ppp_max: ppp_max.round() as u32, estimado })
    }
}

/// Ejecuta Ghostscript con un nivel (screen/ebook/printer/prepress/extremo) y deja el resultado en `salida`.
async fn ejecutar_compresion(app: &tauri::AppHandle, entrada: &str, salida: &str, nivel: &str) -> Result<(), String> {
    let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;
    let estado = app.state::<EstadoApp>();
    if esta_cancelado(&estado) {
        return Err("Operación cancelada".into());
    }
    let cancelar = estado.cancelar.clone();
    let pid_actual = estado.pid_proceso.clone();
    let entrada_clon = entrada.to_string();
    let salida_clon = salida.to_string();
    let nivel_clon = nivel.to_string();
    let status = tauri::async_runtime::spawn_blocking(move || {
        let preset = if nivel_clon == "extremo" { "screen".to_string() } else { nivel_clon.clone() };
        let mut args: Vec<String> = vec![
            "-sDEVICE=pdfwrite".to_string(),
            format!("-dPDFSETTINGS=/{}", preset),
            "-dCompatibilityLevel=1.5".to_string(),
            "-dNOPAUSE".to_string(),
            "-dBATCH".to_string(),
            "-dQUIET".to_string(),
        ];
        // IMPORTANTE: "-sOutputFile" va ANTES de los extras, porque "-c" (ajuste de
        // calidad JPEG, último elemento de los extras) hace que Ghostscript interprete
        // como PostScript todo lo que le siga hasta encontrar "-f".
        args.push(format!("-sOutputFile={}", salida_clon));
        args.extend(args_compresion_extra(&nivel_clon));
        args.push("-f".to_string());
        args.push(entrada_clon);
        let child = comando_gs(&ruta_gs)
            .args(&args)
            .spawn()
            .map_err(|e| format!("Error lanzando Ghostscript: {}", e))?;
        let estado_tmp = EstadoApp { cancelar, pid_proceso: pid_actual };
        ejecutar_con_cancelacion(child, &estado_tmp)
    })
    .await
    .map_err(|e| format!("Error interno: {}", e))??;
    if !status.success() {
        return Err("Ghostscript falló al comprimir".into());
    }
    Ok(())
}

#[tauri::command]
async fn comprimir_pdf(
    app: tauri::AppHandle,
    entrada: String,
    salida: String,
    nivel: String,
) -> Result<ResultadoCompresion, String> {
    let nivel_valido = match nivel.as_str() {
        "screen" | "ebook" | "printer" | "prepress" => nivel,
        _ => "ebook".to_string(),
    };
    let tamano_entrada = fs::metadata(&entrada).map(|m| m.len()).unwrap_or(0);
    ejecutar_compresion(&app, &entrada, &salida, &nivel_valido).await?;
    let mut tamano_salida = fs::metadata(&salida).map(|m| m.len()).unwrap_or(0);
    // Si no se ha conseguido reducir, se conserva el original (nunca devolver un archivo más grande)
    if tamano_entrada > 0 && tamano_salida >= tamano_entrada {
        if fs::copy(&entrada, &salida).is_ok() { tamano_salida = tamano_entrada; }
    }
    Ok(ResultadoCompresion { tamano_entrada, tamano_salida, nivel: nivel_valido, cumple: true })
}

#[derive(Serialize)]
struct ResultadoTamano {
    tamano_entrada: u64,
    tamano_salida: u64,
    nivel: String,
    cumple: bool,
    pruebas: u32,
}

/// Comprime buscando el nivel de MAYOR calidad cuyo resultado no supere `max_bytes`.
/// Usa la estimación para empezar cerca y verifica con el tamaño real (como máximo 4 pruebas).
#[tauri::command]
async fn comprimir_a_tamano(
    app: tauri::AppHandle,
    entrada: String,
    salida: String,
    max_bytes: u64,
) -> Result<ResultadoTamano, String> {
    let tamano_entrada = fs::metadata(&entrada).map(|m| m.len()).map_err(|e| e.to_string())?;
    if tamano_entrada <= max_bytes {
        fs::copy(&entrada, &salida).map_err(|e| e.to_string())?;
        return Ok(ResultadoTamano { tamano_entrada, tamano_salida: tamano_entrada, nivel: "original".into(), cumple: true, pruebas: 0 });
    }
    // Niveles de mayor a menor calidad
    const NIVELES: [&str; 4] = ["printer", "ebook", "screen", "extremo"];
    // Estimación inicial: primer nivel cuya estimación cabe (con margen)
    let est = {
        let r = entrada.clone();
        tauri::async_runtime::spawn_blocking(move || analizar_sync(&r)).await.ok().and_then(|x| x.ok())
    };
    let mut i = 0usize;
    if let Some(a) = &est {
        let e = [a.estimado[2], a.estimado[1], a.estimado[0], a.estimado[0] * 6 / 10];
        i = e.iter().position(|v| (*v as f64) <= max_bytes as f64 * 1.15).unwrap_or(NIVELES.len() - 1);
    }
    let mut mejor: Option<(String, u64, String)> = None; // (nivel, tamaño, ruta temporal) que cumple
    let mut menor: Option<(String, u64, String)> = None; // el más pequeño probado
    let mut pruebas = 0u32;
    let mut probados: Vec<usize> = vec![];
    let tmp = |k: usize| format!("{}.tmp{}", salida, k);
    let mut sentido_arriba_probado = false;
    loop {
        if probados.contains(&i) || pruebas >= 4 { break; }
        probados.push(i);
        let t = tmp(i);
        let _ = fs::remove_file(&t);
        ejecutar_compresion(&app, &entrada, &t, NIVELES[i]).await?;
        pruebas += 1;
        let tam = fs::metadata(&t).map(|m| m.len()).unwrap_or(u64::MAX);
        if menor.as_ref().map(|m| tam < m.1).unwrap_or(true) { menor = Some((NIVELES[i].to_string(), tam, t.clone())); }
        if tam <= max_bytes {
            if mejor.as_ref().map(|m| i < NIVELES.iter().position(|n| *n == m.0).unwrap_or(99)).unwrap_or(true) {
                mejor = Some((NIVELES[i].to_string(), tam, t.clone()));
            }
            // Cabe: intentar un nivel de más calidad si aún no se ha probado
            if i > 0 && !sentido_arriba_probado && !probados.contains(&(i - 1)) { sentido_arriba_probado = true; i -= 1; continue; }
            break;
        } else {
            if mejor.is_some() { break; }
            if i + 1 < NIVELES.len() { i += 1; sentido_arriba_probado = true; continue; }
            break;
        }
    }
    let elegido = mejor.clone().or(menor.clone()).ok_or("No se pudo comprimir")?;
    let cumple = mejor.is_some();
    let (nivel, mut tam, ruta_t) = elegido;
    if tam >= tamano_entrada {
        fs::copy(&entrada, &salida).map_err(|e| e.to_string())?;
        tam = tamano_entrada;
    } else {
        fs::copy(&ruta_t, &salida).map_err(|e| e.to_string())?;
    }
    for k in 0..NIVELES.len() { let _ = fs::remove_file(tmp(k)); }
    Ok(ResultadoTamano { tamano_entrada, tamano_salida: tam, nivel, cumple, pruebas })
}

#[derive(Clone, Serialize)]
struct ProgresoOcr {
    actual: usize,
    total: usize,
}

#[derive(Clone, Serialize)]
struct ProgresoMiniaturas {
    actual: usize,
    total: usize,
}

#[derive(Clone, Serialize)]
struct ProgresoReordenar {
    actual: usize,
    total: usize,
}

#[tauri::command]
fn archivo_existe(ruta: String) -> bool {
    std::path::Path::new(&ruta).exists()
}

#[tauri::command]
fn borrar_archivos(rutas: Vec<String>) -> Vec<String> {
    // Devuelve lista de errores (vacía si todo fue bien)
    rutas
        .iter()
        .filter_map(|r| fs::remove_file(r).err().map(|e| format!("{}: {}", r, e)))
        .collect()
}

#[derive(Serialize)]
struct InfoPdf {
    paginas: u32,
    protegido: bool,
    corrupto: bool,
    error: Option<String>,
    tamano_bytes: u64,
}

#[tauri::command]
fn comprobar_pdf(ruta: String) -> InfoPdf {
    let tamano_bytes = fs::metadata(&ruta).map(|m| m.len()).unwrap_or(0);
    if !std::path::Path::new(&ruta).exists() {
        return InfoPdf { paginas: 0, protegido: false, corrupto: true, error: Some("El archivo no existe".into()), tamano_bytes: 0 };
    }
    match Document::load(&ruta) {
        Ok(doc) => InfoPdf {
            paginas: doc.get_pages().len() as u32,
            protegido: false, corrupto: false, error: None, tamano_bytes,
        },
        Err(e) => {
            let msg = e.to_string().to_lowercase();
            let protegido = msg.contains("encrypt") || msg.contains("password") || msg.contains("decrypt");
            InfoPdf { paginas: 0, protegido, corrupto: !protegido, error: Some(e.to_string()), tamano_bytes }
        }
    }
}

#[derive(Serialize)]
struct ResultadoValidacion {
    ruta: String,
    ok: bool,
    protegido: bool,
    corrupto: bool,
    error: Option<String>,
}

/// Valida una lista de PDFs antes de procesarlos.
/// Devuelve un resultado por archivo indicando si es válido, protegido o corrupto.
#[tauri::command]
fn validar_pdfs(rutas: Vec<String>) -> Vec<ResultadoValidacion> {
    rutas.into_iter().map(|ruta| {
        if !std::path::Path::new(&ruta).exists() {
            return ResultadoValidacion {
                ruta,
                ok: false,
                protegido: false,
                corrupto: false,
                error: Some("El archivo no existe o no es accesible".into()),
            };
        }
        match Document::load(&ruta) {
            Ok(_) => ResultadoValidacion { ruta, ok: true, protegido: false, corrupto: false, error: None },
            Err(e) => {
                let msg = e.to_string().to_lowercase();
                let protegido = msg.contains("encrypt")
                    || msg.contains("password")
                    || msg.contains("decrypt");
                ResultadoValidacion {
                    ruta,
                    ok: false,
                    protegido,
                    corrupto: !protegido,
                    error: Some(e.to_string()),
                }
            }
        }
    }).collect()
}


/// Devuelve una carpeta temporal junto al ejecutable (evita rutas de usuario con caracteres especiales).
/// Si no es posible, cae de vuelta al temp del sistema.
fn dir_temp_local(sufijo: &str) -> PathBuf {
    let base = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(std::env::temp_dir);
    base.join(format!("pdftool_tmp_{}_{}", sufijo, std::process::id()))
}

/// Borra una carpeta temporal con reintentos: en Windows, justo tras matar un
/// proceso externo (Ghostscript/Tesseract) el SO puede tardar unos milisegundos
/// en soltar los ficheros que tenía abiertos, y un remove_dir_all() inmediato
/// puede fallar con "en uso por otro proceso". Reintentamos unas pocas veces
/// antes de rendirnos (silenciosamente, como antes).
fn limpiar_dir_temp(dir: &std::path::Path) {
    for intento in 0..5 {
        match fs::remove_dir_all(dir) {
            Ok(()) => return,
            Err(_) if intento < 4 => std::thread::sleep(std::time::Duration::from_millis(150)),
            Err(_) => return,
        }
    }
}

/// Borra carpetas temporales huérfanas de ejecuciones anteriores (p. ej. tras un
/// cierre inesperado de la app o una versión previa con este bug) que puedan
/// quedar junto al ejecutable. Se llama una vez al arrancar.
fn limpiar_temporales_huerfanos() {
    let Some(dir_exe) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) else { return };
    let Ok(entradas) = fs::read_dir(&dir_exe) else { return };
    let pid_propio = std::process::id();
    for entrada in entradas.filter_map(|e| e.ok()) {
        let nombre = entrada.file_name();
        let nombre = nombre.to_string_lossy();
        if !nombre.starts_with("pdftool_tmp_") { continue; }
        // No tocar la carpeta de esta misma instancia si por lo que sea ya existiera.
        if nombre.ends_with(&format!("_{}", pid_propio)) { continue; }
        if entrada.path().is_dir() {
            let _ = fs::remove_dir_all(entrada.path());
        }
    }
}

/// Mueve un archivo a otra ruta. Usa rename() cuando es posible (rápido, misma unidad)
/// y cae a copy+delete cuando origen y destino están en discos/unidades distintas
/// (rename() falla en Windows entre unidades con "os error 17").
fn mover_archivo(origen: &std::path::Path, destino: &std::path::Path) -> Result<(), String> {
    match fs::rename(origen, destino) {
        Ok(()) => Ok(()),
        Err(e) => {
            // os error 17 en Windows / EXDEV en Unix = distintas unidades/discos
            fs::copy(origen, destino)
                .map_err(|e2| format!("Error al guardar: {} (y no se pudo copiar como alternativa: {})", e, e2))?;
            fs::remove_file(origen).ok(); // no crítico si falla el borrado del temporal
            Ok(())
        }
    }
}

/// Agrupa páginas en rangos contiguos para GS.
fn agrupar_consecutivos(nums: &[u32]) -> Vec<(u32, u32)> {
    if nums.is_empty() { return vec![]; }
    let mut grupos: Vec<(u32, u32)> = Vec::new();
    let mut inicio = nums[0];
    let mut fin = nums[0];
    for &n in &nums[1..] {
        if n == fin + 1 { fin = n; }
        else { grupos.push((inicio, fin)); inicio = n; fin = n; }
    }
    grupos.push((inicio, fin));
    grupos
}

fn parsear_rango(rango: &str, total: u32) -> Result<Vec<u32>, String> {
    let mut paginas: Vec<u32> = Vec::new();
    for parte in rango.split(',') {
        let parte = parte.trim();
        if parte.is_empty() { continue; }
        if let Some((a, b)) = parte.split_once('-') {
            let inicio: u32 = a.trim().parse()
                .map_err(|_| format!("Número inválido: '{}'", a.trim()))?;
            let fin: u32 = b.trim().parse()
                .map_err(|_| format!("Número inválido: '{}'", b.trim()))?;
            if inicio < 1 || fin > total || inicio > fin {
                return Err(format!("Rango {}-{} fuera de límites (1-{})", inicio, fin, total));
            }
            paginas.extend(inicio..=fin);
        } else {
            let p: u32 = parte.parse()
                .map_err(|_| format!("Número inválido: '{}'", parte))?;
            if p < 1 || p > total {
                return Err(format!("Página {} fuera de límites (1-{})", p, total));
            }
            paginas.push(p);
        }
    }
    if paginas.is_empty() { return Err("No se especificó ninguna página".into()); }
    paginas.sort_unstable();
    paginas.dedup();
    Ok(paginas)
}

#[tauri::command]
fn extraer_paginas(app: tauri::AppHandle, entrada: String, rango: String, salida: String) -> Result<(), String> {
    let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;
    let estado = app.state::<EstadoApp>();
    if esta_cancelado(&estado) { return Err("Operación cancelada".into()); }

    // Usamos lopdf solo para leer el total de páginas, sin escribir nada
    let total = {
        let doc = Document::load(&entrada)
            .map_err(|e| format!("Error al abrir el PDF: {}", e))?;
        doc.get_pages().len() as u32
    };

    let nums = parsear_rango(&rango, total)?;
    let grupos = agrupar_consecutivos(&nums);

    let dir_tmp = dir_temp_local("ext");
    fs::create_dir_all(&dir_tmp).map_err(|e| e.to_string())?;

    let mut partes: Vec<String> = Vec::new();

    for (inicio, fin) in &grupos {
        if esta_cancelado(&estado) {
            limpiar_dir_temp(&dir_tmp);
            return Err("Operación cancelada".into());
        }
        let tmp = dir_tmp.join(format!("parte_{}_{}.pdf", inicio, fin));
        let child = comando_gs(&ruta_gs)
            .args([
                "-sDEVICE=pdfwrite", "-dPDFSETTINGS=/prepress",
                "-dCompatibilityLevel=1.6", "-dNOPAUSE", "-dBATCH", "-dQUIET",
                &format!("-dFirstPage={}", inicio),
                &format!("-dLastPage={}", fin),
                &format!("-sOutputFile={}", tmp.display()),
                &entrada,
            ])
            .spawn()
            .map_err(|e| format!("Error lanzando Ghostscript: {}", e))?;

        let status = ejecutar_con_cancelacion(child, &estado)?;
        if !status.success() {
            limpiar_dir_temp(&dir_tmp);
            return Err(format!("Ghostscript falló al extraer páginas {}-{}", inicio, fin));
        }
        partes.push(tmp.to_string_lossy().to_string());
    }

    let resultado = if partes.len() == 1 {
        mover_archivo(std::path::Path::new(&partes[0]), std::path::Path::new(&salida))
    } else {
        combinar_documentos_gs(&partes, &salida, &estado)
    };
    limpiar_dir_temp(&dir_tmp);
    resultado
}

/// Genera una miniatura PNG (baja resolución) por cada página del PDF y las devuelve
/// como data URLs base64, en orden, para mostrarlas en la pantalla de reordenar páginas.
/// Emite el evento "miniaturas-progreso" mientras Ghostscript va escribiendo cada PNG,
/// y es cancelable en cualquier momento (se mata el proceso de Ghostscript).
#[tauri::command]
fn generar_miniaturas_paginas(app: tauri::AppHandle, entrada: String) -> Result<Vec<String>, String> {
    let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;
    let estado = app.state::<EstadoApp>();
    if esta_cancelado(&estado) { return Err("Operación cancelada".into()); }

    // Nº total de páginas, solo para poder informar del progreso (si falla, se
    // sigue sin barra de progreso exacta pero no se bloquea la generación).
    let total = Document::load(&entrada).map(|d| d.get_pages().len()).unwrap_or(0);

    let dir_tmp = dir_temp_local("mini");
    fs::create_dir_all(&dir_tmp).map_err(|e| e.to_string())?;

    let patron_png = dir_tmp.join("pagina_%04d.png");
    let mut child = comando_gs(&ruta_gs)
        .args([
            "-dNOPAUSE", "-dBATCH", "-dQUIET", "-sDEVICE=png16m",
            "-r55", "-dGraphicsAlphaBits=4", "-dTextAlphaBits=4",
            &format!("-sOutputFile={}", patron_png.display()),
            &entrada,
        ])
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Error lanzando Ghostscript: {}", e))?;

    let contar_pngs = |dir: &PathBuf| -> usize {
        fs::read_dir(dir).map(|it| {
            it.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().map(|x| x == "png").unwrap_or(false))
                .count()
        }).unwrap_or(0)
    };

    *estado.pid_proceso.lock().unwrap() = Some(child.id());
    let status = loop {
        if esta_cancelado(&estado) {
            let _ = child.kill();
            *estado.pid_proceso.lock().unwrap() = None;
            limpiar_dir_temp(&dir_tmp);
            return Err("Operación cancelada".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => { *estado.pid_proceso.lock().unwrap() = None; break status; }
            Ok(None) => {
                let generadas = contar_pngs(&dir_tmp);
                let _ = app.emit("miniaturas-progreso", ProgresoMiniaturas { actual: generadas, total });
                std::thread::sleep(std::time::Duration::from_millis(120));
            }
            Err(e) => {
                *estado.pid_proceso.lock().unwrap() = None;
                limpiar_dir_temp(&dir_tmp);
                return Err(e.to_string());
            }
        }
    };

    if !status.success() {
        limpiar_dir_temp(&dir_tmp);
        return Err("Ghostscript falló al generar las miniaturas".into());
    }

    let mut imagenes: Vec<PathBuf> = fs::read_dir(&dir_tmp)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|p| p.extension().map(|ext| ext == "png").unwrap_or(false))
        .collect();
    imagenes.sort();

    let total_real = imagenes.len();
    let mut resultado = Vec::with_capacity(imagenes.len());
    for (i, ruta) in imagenes.iter().enumerate() {
        if esta_cancelado(&estado) {
            limpiar_dir_temp(&dir_tmp);
            return Err("Operación cancelada".into());
        }
        let bytes = fs::read(ruta).map_err(|e| format!("Error leyendo miniatura: {}", e))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        resultado.push(format!("data:image/png;base64,{}", b64));
        let _ = app.emit("miniaturas-progreso", ProgresoMiniaturas { actual: i + 1, total: total_real });
    }

    limpiar_dir_temp(&dir_tmp);
    Ok(resultado)
}

/// Visor: dibuja UNA página del PDF a la resolución pedida y la devuelve como data URL PNG.
#[tauri::command]
async fn renderizar_pagina(entrada: String, pagina: u32, dpi: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;
        let dir_tmp = dir_temp_local("visor");
        fs::create_dir_all(&dir_tmp).map_err(|e| e.to_string())?;
        let salida = dir_tmp.join("pagina.png");
        let st = comando_gs(&ruta_gs)
            .args([
                "-dNOPAUSE", "-dBATCH", "-dQUIET", "-sDEVICE=png16m", "-dUseCropBox",
                &format!("-r{}", dpi.clamp(30, 300)),
                "-dGraphicsAlphaBits=4", "-dTextAlphaBits=4",
                &format!("-dFirstPage={}", pagina),
                &format!("-dLastPage={}", pagina),
                &format!("-sOutputFile={}", salida.display()),
                &entrada,
            ])
            .status()
            .map_err(|e| format!("Error lanzando Ghostscript: {}", e));
        let r = match st {
            Ok(s) if s.success() => fs::read(&salida)
                .map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&b)))
                .map_err(|e| format!("Error leyendo la página: {}", e)),
            Ok(_) => Err("Ghostscript falló al dibujar la página".to_string()),
            Err(e) => Err(e),
        };
        limpiar_dir_temp(&dir_tmp);
        r
    }).await.map_err(|e| e.to_string())?
}

/// Visor: miniaturas pequeñas de todas las páginas (una sola llamada a Ghostscript).
#[tauri::command]
async fn miniaturas_visor(entrada: String, dpi: Option<u32>) -> Result<Vec<String>, String> {
    let dpi = dpi.unwrap_or(36).clamp(24, 150);
    tauri::async_runtime::spawn_blocking(move || {
        let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;
        let dir_tmp = dir_temp_local("visormini");
        fs::create_dir_all(&dir_tmp).map_err(|e| e.to_string())?;
        let patron = dir_tmp.join("m_%04d.png");
        let st = comando_gs(&ruta_gs)
            .args([
                "-dNOPAUSE", "-dBATCH", "-dQUIET", "-sDEVICE=png16m", "-dUseCropBox",
                &format!("-r{}", dpi), "-dGraphicsAlphaBits=4", "-dTextAlphaBits=4",
                &format!("-sOutputFile={}", patron.display()),
                &entrada,
            ])
            .status()
            .map_err(|e| format!("Error lanzando Ghostscript: {}", e));
        let r = match st {
            Ok(s) if s.success() => {
                let mut imgs: Vec<PathBuf> = fs::read_dir(&dir_tmp)
                    .map_err(|e| e.to_string())?
                    .filter_map(|e| e.ok()).map(|e| e.path())
                    .filter(|p| p.extension().map(|x| x == "png").unwrap_or(false))
                    .collect();
                imgs.sort();
                let mut v = Vec::with_capacity(imgs.len());
                for ruta in &imgs {
                    let b = fs::read(ruta).map_err(|e| e.to_string())?;
                    v.push(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&b)));
                }
                Ok(v)
            }
            Ok(_) => Err("Ghostscript falló al generar las miniaturas".to_string()),
            Err(e) => Err(e),
        };
        limpiar_dir_temp(&dir_tmp);
        r
    }).await.map_err(|e| e.to_string())?
}

/// Aplica la organización de páginas (orden, eliminadas, rotación, páginas en blanco) a una copia.
#[tauri::command]
async fn aplicar_organizacion(entrada: String, salida: String, paginas: Vec<organizar::PaginaOrg>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || organizar::aplicar(&entrada, &salida, &paginas))
        .await.map_err(|e| e.to_string())?
}

// ───────────── Cola de archivos mixtos, borrado de copias y búsqueda de texto ─────────────

const EXTS_IMAGEN: [&str; 8] = ["jpg", "jpeg", "png", "bmp", "tif", "tiff", "gif", "webp"];

fn es_ruta_imagen(ruta: &str) -> bool {
    let ext = ruta.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    EXTS_IMAGEN.contains(&ext.as_str()) || ext == "heic" || ext == "heif"
}

#[derive(serde::Serialize)]
struct MixtoPreparado { dir: String, rutas: Vec<String> }

/// Convierte cada imagen en un PDF temporal (A4) y deja los PDF tal cual, conservando el orden.
#[tauri::command]
async fn preparar_mixto(rutas: Vec<String>) -> Result<MixtoPreparado, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = dir_temp_local("cola");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut salida = Vec::with_capacity(rutas.len());
        for (i, r) in rutas.iter().enumerate() {
            if es_ruta_imagen(r) {
                let pdf = dir.join(format!("{:04}.pdf", i));
                if let Err(e) = imagen_pdf::imagenes_a_pdf_nativo(&[r.clone()], &pdf.to_string_lossy(), &|| false) {
                    limpiar_dir_temp(&dir);
                    return Err(e);
                }
                salida.push(pdf.to_string_lossy().to_string());
            } else {
                salida.push(r.clone());
            }
        }
        Ok(MixtoPreparado { dir: dir.to_string_lossy().to_string(), rutas: salida })
    }).await.map_err(|e| e.to_string())?
}

/// Borra la carpeta temporal creada por `preparar_mixto` (solo si lleva el prefijo esperado).
#[tauri::command]
fn limpiar_carpeta_cola(dir: String) {
    let p = PathBuf::from(&dir);
    let ok = p.file_name().map(|n| n.to_string_lossy().starts_with("pdftool_tmp_cola_")).unwrap_or(false);
    if ok && p.is_dir() { limpiar_dir_temp(&p); }
}

/// «Deshacer» tras guardar: borra una copia PDF generada por la app.
#[tauri::command]
fn eliminar_archivo(ruta: String) -> Result<(), String> {
    let p = PathBuf::from(&ruta);
    let es_pdf = p.extension().map(|e| e.to_string_lossy().eq_ignore_ascii_case("pdf")).unwrap_or(false);
    if !es_pdf { return Err("Solo se pueden eliminar archivos PDF generados por la app".into()); }
    fs::remove_file(&p).map_err(|e| format!("No se pudo eliminar {}: {}", ruta, e))
}

#[derive(serde::Serialize)]
struct AciertoTexto { pagina: u32, cuenta: u32, fragmento: String }
#[derive(serde::Serialize)]
struct ResultadoBusqueda { hay_texto: bool, aciertos: Vec<AciertoTexto> }

/// Minúsculas y sin tildes, SIEMPRE un carácter por carácter (los índices coinciden con el original).
fn plegar(s: &str) -> Vec<char> {
    s.chars().map(|c| {
        let c = c.to_lowercase().next().unwrap_or(c);
        match c {
            'á' | 'à' | 'ä' | 'â' | 'ã' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            c if c.is_whitespace() => ' ',
            c => c,
        }
    }).collect()
}

fn buscar_en_pdf(ruta_gs: &PathBuf, entrada: &str, consulta: &str) -> Result<ResultadoBusqueda, String> {
    let q = plegar(consulta.trim());
    if q.is_empty() { return Ok(ResultadoBusqueda { hay_texto: true, aciertos: vec![] }); }
    let dir = dir_temp_local("buscar");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let patron = dir.join("p_%04d.txt");
    let st = comando_gs(ruta_gs)
        .args(["-dNOPAUSE", "-dBATCH", "-dQUIET", "-sDEVICE=txtwrite", &format!("-sOutputFile={}", patron.display()), entrada])
        .status().map_err(|e| format!("Error lanzando Ghostscript: {}", e));
    let r = match st {
        Ok(s) if s.success() => {
            let mut ficheros: Vec<PathBuf> = fs::read_dir(&dir).map_err(|e| e.to_string())?
                .filter_map(|e| e.ok()).map(|e| e.path()).collect();
            ficheros.sort();
            let mut hay_texto = false;
            let mut aciertos = Vec::new();
            for (i, f) in ficheros.iter().enumerate() {
                let bytes = fs::read(f).unwrap_or_default();
                let texto = String::from_utf8_lossy(&bytes).to_string();
                if texto.chars().any(|c| !c.is_whitespace()) { hay_texto = true; }
                let orig: Vec<char> = texto.chars().collect();
                let p = plegar(&texto);
                let mut cuenta = 0u32;
                let mut primero: Option<usize> = None;
                let mut j = 0;
                while j + q.len() <= p.len() {
                    if p[j..j + q.len()] == q[..] {
                        cuenta += 1;
                        if primero.is_none() { primero = Some(j); }
                        j += q.len();
                    } else { j += 1; }
                }
                if let Some(pos) = primero {
                    let ini = pos.saturating_sub(40);
                    let fin = (pos + q.len() + 60).min(orig.len());
                    let frag: String = orig[ini..fin].iter().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
                    aciertos.push(AciertoTexto { pagina: (i + 1) as u32, cuenta, fragmento: frag });
                }
            }
            Ok(ResultadoBusqueda { hay_texto, aciertos })
        }
        Ok(_) => Err("Ghostscript falló al extraer el texto".to_string()),
        Err(e) => Err(e),
    };
    limpiar_dir_temp(&dir);
    r
}

/// Busca texto (sin distinguir mayúsculas ni tildes) en un PDF; devuelve las páginas con coincidencias.
#[tauri::command]
async fn buscar_texto(entrada: String, consulta: String) -> Result<ResultadoBusqueda, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;
        buscar_en_pdf(&ruta_gs, &entrada, &consulta)
    }).await.map_err(|e| e.to_string())?
}

// ───────────────────────────── Firma digital ─────────────────────────────

#[derive(serde::Serialize)]
struct ResultadoFirma { entrada: String, salida: String, ok: bool, error: String, aviso: String }

fn salida_firmada(entrada: &str, carpeta: Option<&str>) -> PathBuf {
    let p = PathBuf::from(entrada);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "documento".into());
    let dir = match carpeta { Some(c) if !c.trim().is_empty() => PathBuf::from(c), _ => p.parent().map(|d| d.to_path_buf()).unwrap_or_default() };
    let mut cand = dir.join(format!("{stem}_firmado.pdf"));
    let mut n = 2;
    while cand.exists() { cand = dir.join(format!("{stem}_firmado ({n}).pdf")); n += 1; }
    cand
}

#[cfg(windows)]
fn abrir_almacen(origen: &str, pfx_ruta: &Option<String>, pfx_clave: &Option<String>) -> Result<firma::capi::Almacen, String> {
    if origen == "pfx" {
        let r = pfx_ruta.as_deref().ok_or("Elige el archivo .pfx / .p12")?;
        let datos = std::fs::read(r).map_err(|e| format!("No se pudo leer el certificado: {e}"))?;
        firma::capi::Almacen::pfx(&datos, pfx_clave.as_deref().unwrap_or(""))
    } else {
        firma::capi::Almacen::personal()
    }
}

/// Tras firmar: sello de tiempo y/o datos de validación si se pidió (necesita conexión). Devuelve un aviso si falla.
fn aviso_ltv(ruta: &str, op: &firma::Opciones) -> String {
    let nivel = op.nivel.as_deref().unwrap_or("basica");
    if !op.criptografica || (nivel != "tiempo" && nivel != "ltv") { return String::new(); }
    let tsa = op.tsa_url.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| ltv::TSA_POR_DEFECTO.to_string());
    match ltv::completar_pdf(ruta, ruta, nivel, &tsa, ltv::http_sistema().as_ref()) {
        Ok(inf) => if inf.avisos.is_empty() { String::new() } else { inf.avisos.join(" · ") },
        Err(e) => format!("Firmado, pero no se pudo completar el sello/validación a largo plazo: {e}"),
    }
}

/// Añade sello de tiempo y/o datos de validación a PDF ya firmados (necesita conexión). Crea «_ltv».
#[tauri::command]
async fn completar_firma(rutas: Vec<String>, nivel: String, tsa_url: Option<String>) -> Result<Vec<ResultadoFirma>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ResultadoFirma>, String> {
        let tsa = tsa_url.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| ltv::TSA_POR_DEFECTO.to_string());
        let http = ltv::http_sistema();
        let mut v = vec![];
        for e in &rutas {
            let p = PathBuf::from(e);
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let mut cand = p.with_file_name(format!("{stem}_ltv.pdf")); let mut n = 2;
            while cand.exists() { cand = p.with_file_name(format!("{stem}_ltv ({n}).pdf")); n += 1; }
            let s = cand.to_string_lossy().into_owned();
            v.push(match ltv::completar_pdf(e, &s, &nivel, &tsa, http.as_ref()) {
                Ok(inf) => ResultadoFirma { entrada: e.clone(), salida: s, ok: true, error: String::new(), aviso: inf.avisos.join(" · ") },
                Err(err) => { let _ = std::fs::remove_file(&s); ResultadoFirma { entrada: e.clone(), salida: String::new(), ok: false, error: err, aviso: String::new() } }
            });
        }
        Ok(v)
    }).await.map_err(|e| e.to_string())?
}

/// Certificados con clave privada del almacén de Windows (DNIe, FNMT…) o de un .pfx.
#[tauri::command]
async fn listar_certificados(origen: String, pfx_ruta: Option<String>, pfx_clave: Option<String>) -> Result<Vec<firma::CertInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<firma::CertInfo>, String> {
        #[cfg(windows)]
        { Ok(abrir_almacen(&origen, &pfx_ruta, &pfx_clave)?.listar()) }
        #[cfg(not(windows))]
        { let _ = (origen, pfx_ruta, pfx_clave); Err("La firma con certificado solo está disponible en Windows.".into()) }
    }).await.map_err(|e| e.to_string())?
}

/// Firma (y/o sella) varios PDF con el mismo certificado y la misma posición.
#[tauri::command]
async fn firmar_pdfs(app: tauri::AppHandle, entradas: Vec<String>, carpeta_salida: Option<String>, opciones: firma::Opciones) -> Result<Vec<ResultadoFirma>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ResultadoFirma>, String> {
        #[cfg(windows)]
        {
            let alm = abrir_almacen(&opciones.cert_origen, &opciones.pfx_ruta, &opciones.pfx_clave)?;
            let cert = alm.firmante(&opciones.cert_id)?;
            if cert.info.caducado { return Err(format!("El certificado de {} caducó el {}.", cert.info.nombre, cert.info.caduca)); }
            let mut v = vec![];
            let total = entradas.len();
            for (i, e) in entradas.iter().enumerate() {
                let _ = app.emit("firma-progreso", serde_json::json!({ "actual": i, "total": total }));
                let s = salida_firmada(e, carpeta_salida.as_deref());
                let r = firma::firmar_pdf(e, &s.to_string_lossy(), &opciones, &cert.info, if opciones.criptografica { Some(&cert) } else { None });
                v.push(match r {
                    Ok(()) => ResultadoFirma { entrada: e.clone(), salida: s.to_string_lossy().into_owned(), ok: true, error: String::new(), aviso: aviso_ltv(&s.to_string_lossy(), &opciones) },
                    Err(err) => { let _ = std::fs::remove_file(&s); ResultadoFirma { entrada: e.clone(), salida: String::new(), ok: false, error: err, aviso: String::new() } }
                });
            }
            let _ = app.emit("firma-progreso", serde_json::json!({ "actual": total, "total": total }));
            Ok(v)
        }
        #[cfg(not(windows))]
        { let _ = (app, entradas, carpeta_salida, opciones); Err("La firma con certificado solo está disponible en Windows.".into()) }
    }).await.map_err(|e| e.to_string())?
}


/// Firmas detectadas en un PDF (no valida certificados: solo informa de cuántas hay y si hay cambios posteriores).
#[derive(serde::Serialize)]
struct EstadoFirmas { firmas: u32, cubre_todo: bool, ltv: bool }

#[tauri::command]
async fn estado_firmas(ruta: String) -> Result<EstadoFirmas, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<EstadoFirmas, String> {
        let b = std::fs::read(&ruta).map_err(|e| e.to_string())?;
        let clave = b"/ByteRange";
        let (mut n, mut cubre) = (0u32, false);
        let mut i = 0usize;
        while let Some(p) = b[i..].windows(clave.len()).position(|w| w == clave) {
            let ini = i + p + clave.len();
            let fin = (ini + 120).min(b.len());
            let t = String::from_utf8_lossy(&b[ini..fin]).into_owned();
            if let (Some(a), Some(c)) = (t.find('['), t.find(']')) {
                let v: Vec<u64> = t[a + 1..c].split_whitespace().filter_map(|x| x.parse().ok()).collect();
                if v.len() == 4 && v[1] > 0 { n += 1; cubre = v[2] + v[3] >= b.len() as u64 - 4; }
            }
            i = ini;
        }
        let ltv = b.windows(4).any(|w| w == b"/DSS");
        Ok(EstadoFirmas { firmas: n, cubre_todo: cubre, ltv })
    }).await.map_err(|e| e.to_string())?
}

/// Valida las firmas de un PDF (integridad, firmante, cadena de confianza y, si se pide, revocación).
#[tauri::command]
async fn validar_firmas(ruta: String, revocacion: bool) -> Result<Vec<validar::ResultadoValidacion>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<validar::ResultadoValidacion>, String> {
        registrar_error("TRAZA", &format!("validar_firmas: inicio ({}) revocacion={}", ruta, revocacion));
        let b = std::fs::read(&ruta).map_err(|e| { let m = format!("No se pudo leer el PDF: {e}"); registrar_error("ERROR", &m); m })?;
        let r = validar::validar_pdf(&b, revocacion);
        registrar_error("TRAZA", &format!("validar_firmas: fin ({} firma(s))", r.len()));
        Ok(r)
    }).await.map_err(|e| e.to_string())?
}

/// Renderiza una página con Ghostscript (PNG) para el tachado real.
fn render_gs_png(entrada: &str, pagina: u32, dpi: u32) -> Result<Vec<u8>, String> {
    let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;
    let dir = dir_temp_local("redac");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join("p.png");
    let st = comando_gs(&ruta_gs)
        .args(["-dNOPAUSE", "-dBATCH", "-dQUIET", "-sDEVICE=png16m", "-dUseCropBox", "-dGraphicsAlphaBits=4", "-dTextAlphaBits=4",
               &format!("-r{}", dpi), &format!("-dFirstPage={}", pagina), &format!("-dLastPage={}", pagina),
               &format!("-sOutputFile={}", out.display()), entrada])
        .status().map_err(|e| format!("Error lanzando Ghostscript: {}", e));
    let r = match st {
        Ok(s) if s.success() => fs::read(&out).map_err(|e| e.to_string()),
        Ok(_) => Err("Ghostscript falló al dibujar la página".to_string()),
        Err(e) => Err(e),
    };
    limpiar_dir_temp(&dir);
    r
}

/// Guarda las anotaciones (texto, resaltado) y, si las hay, el tachado real (tipo "tachar") sobre una copia del PDF.
#[tauri::command]
async fn guardar_anotaciones(entrada: String, salida: String, anotaciones: Vec<anotaciones::Anotacion>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tachar, normales): (Vec<_>, Vec<_>) = anotaciones.into_iter().partition(|a| a.tipo == "tachar");
        if tachar.is_empty() { return anotaciones::aplicar(&entrada, &salida, &normales); }
        let zonas: Vec<edicion::Zona> = tachar.iter().map(|a| edicion::Zona { pagina: a.pagina, x: a.x, y: a.y, w: a.w, h: a.h }).collect();
        if normales.is_empty() { return edicion::redactar(&entrada, &salida, &zonas, 200, &render_gs_png); }
        let dir = dir_temp_local("anotred");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let tmp = dir.join("paso1.pdf");
        let r = anotaciones::aplicar(&entrada, &tmp.to_string_lossy(), &normales)
            .and_then(|_| edicion::redactar(&tmp.to_string_lossy(), &salida, &zonas, 200, &render_gs_png));
        limpiar_dir_temp(&dir);
        r
    }).await.map_err(|e| e.to_string())?
}

/// Agrupa una secuencia de números de página en tramos consecutivos (mismo valor y
/// posición avanzando juntos), para minimizar el número de llamadas a Ghostscript
/// al reconstruir el PDF en el nuevo orden.
fn agrupar_consecutivos_en_orden(orden: &[u32]) -> Vec<(u32, u32)> {
    if orden.is_empty() { return vec![]; }
    let mut grupos: Vec<(u32, u32)> = Vec::new();
    let mut inicio = orden[0];
    let mut fin = orden[0];
    for &n in &orden[1..] {
        if n == fin + 1 {
            fin = n;
        } else {
            grupos.push((inicio, fin));
            inicio = n;
            fin = n;
        }
    }
    grupos.push((inicio, fin));
    grupos
}

#[derive(Clone, Serialize)]
struct ProgresoDividir {
    actual: usize,
    total: usize,
}

/// Divide un PDF en varios archivos según los tramos de páginas indicados
/// (1-indexados, inclusive). Cada tramo se escribe directamente como PDF
/// independiente junto al archivo de origen; si el nombre ya existe, se le
/// añade un sufijo numérico para no sobrescribir nada en silencio.
#[tauri::command]
fn dividir_pdf(app: tauri::AppHandle, entrada: String, rangos: Vec<(u32, u32)>) -> Result<Vec<String>, String> {
    let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;
    let estado = app.state::<EstadoApp>();
    if esta_cancelado(&estado) { return Err("Operación cancelada".into()); }
    if rangos.is_empty() { return Err("No se han indicado partes para dividir".into()); }

    let ruta_entrada = std::path::Path::new(&entrada);
    let carpeta = ruta_entrada.parent().unwrap_or_else(|| std::path::Path::new("."));
    let base = ruta_entrada.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "dividido".into());

    let total_partes = rangos.len();
    let mut generados: Vec<String> = Vec::new();

    for (idx, (inicio, fin)) in rangos.iter().enumerate() {
        if esta_cancelado(&estado) { return Err("Operación cancelada".into()); }

        let nombre_base = if total_partes > 1 {
            format!("{}_parte{:02}_p{}-{}", base, idx + 1, inicio, fin)
        } else {
            format!("{}_p{}-{}", base, inicio, fin)
        };
        let mut destino = carpeta.join(format!("{}.pdf", nombre_base));
        let mut n = 2;
        while destino.exists() {
            destino = carpeta.join(format!("{}_{}.pdf", nombre_base, n));
            n += 1;
        }

        let child = comando_gs(&ruta_gs)
            .args([
                "-sDEVICE=pdfwrite", "-dPDFSETTINGS=/prepress",
                "-dCompatibilityLevel=1.6", "-dNOPAUSE", "-dBATCH", "-dQUIET",
                &format!("-dFirstPage={}", inicio),
                &format!("-dLastPage={}", fin),
                &format!("-sOutputFile={}", destino.display()),
                &entrada,
            ])
            .spawn()
            .map_err(|e| format!("Error lanzando Ghostscript: {}", e))?;

        let status = ejecutar_con_cancelacion(child, &estado)?;
        if !status.success() {
            return Err(format!("Ghostscript falló al dividir las páginas {}-{}", inicio, fin));
        }
        generados.push(destino.to_string_lossy().to_string());
        let _ = app.emit("dividir-progreso", ProgresoDividir { actual: idx + 1, total: total_partes });
    }

    Ok(generados)
}


/// Reconstruye el PDF con las páginas en el orden indicado (array de números de
/// página originales, 1-indexado). Extrae tramos consecutivos con Ghostscript y
/// los combina en el orden solicitado.
#[tauri::command]
fn reordenar_paginas(app: tauri::AppHandle, entrada: String, orden: Vec<u32>, salida: String) -> Result<(), String> {
    let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;
    let estado = app.state::<EstadoApp>();
    if esta_cancelado(&estado) { return Err("Operación cancelada".into()); }
    if orden.is_empty() { return Err("No se ha indicado ningún orden de páginas".into()); }

    let dir_tmp = dir_temp_local("orden");
    fs::create_dir_all(&dir_tmp).map_err(|e| e.to_string())?;

    let grupos = agrupar_consecutivos_en_orden(&orden);
    let mut partes: Vec<String> = Vec::new();
    let total_paginas = orden.len();
    let mut hechas: usize = 0;

    for (idx, (inicio, fin)) in grupos.iter().enumerate() {
        if esta_cancelado(&estado) {
            limpiar_dir_temp(&dir_tmp);
            return Err("Operación cancelada".into());
        }
        let tmp = dir_tmp.join(format!("parte_{:04}.pdf", idx));
        let child = comando_gs(&ruta_gs)
            .args([
                "-sDEVICE=pdfwrite", "-dPDFSETTINGS=/prepress",
                "-dCompatibilityLevel=1.6", "-dNOPAUSE", "-dBATCH", "-dQUIET",
                &format!("-dFirstPage={}", inicio),
                &format!("-dLastPage={}", fin),
                &format!("-sOutputFile={}", tmp.display()),
                &entrada,
            ])
            .spawn()
            .map_err(|e| format!("Error lanzando Ghostscript: {}", e))?;

        let status = ejecutar_con_cancelacion(child, &estado)?;
        if !status.success() {
            limpiar_dir_temp(&dir_tmp);
            return Err(format!("Ghostscript falló al extraer páginas {}-{}", inicio, fin));
        }
        partes.push(tmp.to_string_lossy().to_string());
        hechas += (fin - inicio + 1) as usize;
        let _ = app.emit("reordenar-progreso", ProgresoReordenar { actual: hechas, total: total_paginas });
    }

    let resultado = if partes.len() == 1 {
        mover_archivo(std::path::Path::new(&partes[0]), std::path::Path::new(&salida))
    } else {
        combinar_documentos_gs(&partes, &salida, &estado)
    };
    limpiar_dir_temp(&dir_tmp);
    resultado
}

fn ejecutar_ocr(app: &tauri::AppHandle, entrada: &str, salida: &str, idioma: &str, dpi: u32, corregir_orientacion: bool) -> Result<(), String> {
    let ruta_gs = ruta_util("gs/bin/gswin64c.exe")?;
    let ruta_tess = ruta_util("tesseract/tesseract.exe")?;
    let estado = app.state::<EstadoApp>();
    if esta_cancelado(&estado) { return Err("Operación cancelada".into()); }

    let dir_temp = dir_temp_local("ocr");
    fs::create_dir_all(&dir_temp).map_err(|e| e.to_string())?;

    let patron_png = dir_temp.join("pagina_%04d.png");
    let dpi_str = format!("-r{}", dpi);
    let mut child_gs = comando_gs(&ruta_gs)
        .args(["-dNOPAUSE", "-dBATCH", "-dQUIET", "-sDEVICE=png16m",
               &dpi_str, &format!("-sOutputFile={}", patron_png.display()), entrada])
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Error lanzando Ghostscript: {}", e))?;

    // Leer stderr antes de esperar (evita deadlock en buffers pequeños)
    let stderr_gs = child_gs.stderr.take().and_then(|mut s| {
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut s, &mut buf).ok().map(|_| buf)
    }).unwrap_or_default();

    let status_gs = ejecutar_con_cancelacion(child_gs, &estado)?;
    if !status_gs.success() {
        limpiar_dir_temp(&dir_temp);
        let detalle = stderr_gs.lines().find(|l| !l.trim().is_empty()).unwrap_or("sin detalle");
        return Err(format!("Ghostscript (rasterizado) falló: {}", detalle));
    }

    let mut imagenes: Vec<PathBuf> = fs::read_dir(&dir_temp)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|p| p.extension().map(|ext| ext == "png").unwrap_or(false))
        .collect();
    imagenes.sort();

    if imagenes.is_empty() {
        limpiar_dir_temp(&dir_temp);
        return Err("Ghostscript no generó ninguna página de imagen".to_string());
    }

    let total = imagenes.len();
    let mut pdfs_paginas: Vec<String> = Vec::new();
    // psm 1: detección de orientación (corrige 90°/180°/270°) y segmentación automática
    // psm 3: segmentación automática sin OSD (más rápido, por defecto)
    let psm = if corregir_orientacion { "1" } else { "3" };

    for (i, img) in imagenes.iter().enumerate() {
        if esta_cancelado(&estado) {
            limpiar_dir_temp(&dir_temp);
            return Err("Operación cancelada".into());
        }
        let base = img.with_extension("");
        let child_tess = comando_silencioso(&ruta_tess)
            .args([img.to_str().unwrap_or_default(), base.to_str().unwrap_or_default(),
                   "-l", idioma, "--psm", psm, "pdf"])
            .spawn()
            .map_err(|e| format!("Error lanzando Tesseract: {}", e))?;

        if let Err(e) = ejecutar_con_cancelacion(child_tess, &estado) {
            limpiar_dir_temp(&dir_temp);
            return Err(e);
        }
        pdfs_paginas.push(format!("{}.pdf", base.display()));
        let _ = app.emit("ocr-progreso", ProgresoOcr { actual: i + 1, total });
    }

    let resultado = combinar_documentos_gs(&pdfs_paginas, salida, &estado);
    limpiar_dir_temp(&dir_temp);
    resultado
}

#[tauri::command]
async fn ocr_pdf(
    app: tauri::AppHandle, entrada: String, salida: String, idioma: String,
    dpi: Option<u32>, corregir_orientacion: Option<bool>,
) -> Result<(), String> {
    let dpi_val = dpi.unwrap_or(300).clamp(72, 600);
    let corregir = corregir_orientacion.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        ejecutar_ocr(&app, &entrada, &salida, &idioma, dpi_val, corregir)
    })
    .await
    .map_err(|e| format!("Error interno en OCR: {}", e))?
}

/// Convierte una sola imagen a PDF A4 con ruta de salida explícita.
/// Usado por el frontend en modo "PDF separado" para poder gestionar
/// la comprobación de sobrescritura antes de convertir.
///
/// NOTA: no se usa Ghostscript porque no puede abrir imágenes sueltas
/// (JPG/PNG/BMP/TIFF): las interpreta como PostScript y falla.
/// Se decodifican con la crate `image` y se incrustan con `lopdf` (módulo imagen_pdf).
#[tauri::command]
async fn imagen_a_pdf(app: tauri::AppHandle, ruta: String, salida: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let estado = app.state::<EstadoApp>();
        if esta_cancelado(&estado) { return Err("Operación cancelada".to_string()); }
        imagen_pdf::imagenes_a_pdf_nativo(&[ruta], &salida, &|| esta_cancelado(&estado))
    })
    .await
    .map_err(|e| format!("Error interno al convertir imagen: {}", e))?
}

/// Convierte imágenes (JPG, PNG, BMP, TIFF, GIF, WEBP) a PDF tamaño A4.
/// Si separados=false → todas las imágenes en un único PDF.
/// Si separados=true  → un PDF por cada imagen (junto a la imagen original).
/// Devuelve la lista de archivos PDF generados.
#[tauri::command]
async fn imagenes_a_pdf(
    app: tauri::AppHandle,
    rutas: Vec<String>,
    salida: String,       // usado solo cuando separados=false
    separados: bool,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let estado = app.state::<EstadoApp>();
        if esta_cancelado(&estado) {
            return Err("Operación cancelada".to_string());
        }
        let cancelado = || esta_cancelado(&estado);

        if !separados {
            imagen_pdf::imagenes_a_pdf_nativo(&rutas, &salida, &cancelado)?;
            Ok(vec![salida])
        } else {
            let mut generados: Vec<String> = Vec::new();
            for ruta in &rutas {
                if cancelado() {
                    return Err("Operación cancelada".to_string());
                }
                let salida_img = std::path::Path::new(ruta)
                    .with_extension("pdf")
                    .to_string_lossy()
                    .to_string();
                imagen_pdf::imagenes_a_pdf_nativo(std::slice::from_ref(ruta), &salida_img, &cancelado)?;
                generados.push(salida_img);
            }
            Ok(generados)
        }
    })
    .await
    .map_err(|e| format!("Error interno al convertir imágenes: {}", e))?
}

#[tauri::command]
fn cancelar_operacion(app: tauri::AppHandle) {
    let estado = app.state::<EstadoApp>();
    estado.cancelar.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn resetear_cancelacion(app: tauri::AppHandle) {
    let estado = app.state::<EstadoApp>();
    estado.cancelar.store(false, Ordering::Relaxed);
}

#[tauri::command]
fn leer_log(fecha: String) -> Result<String, String> {
    if let Some(ruta) = ruta_log(&fecha) {
        if ruta.exists() {
            fs::read_to_string(&ruta).map_err(|e| e.to_string())
        } else {
            Ok(String::new())
        }
    } else {
        Err("No se pudo determinar la ruta del log".into())
    }
}

#[tauri::command]
fn cerrar_ventana(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.destroy();
    }
}


// ───────────────────── Edición: marca de agua, metadatos, formularios ─────────────────────

#[tauri::command]
async fn decorar_pdf(entrada: String, salida: String, decorado: edicion::Decorado) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || edicion::decorar(&entrada, &salida, &decorado)).await.map_err(|e| e.to_string())?
}

/// Vista previa (data URL PNG) de la primera página seleccionada con la marca / numeración aplicadas.
#[tauri::command]
async fn vista_previa_decorado(entrada: String, decorado: edicion::Decorado) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let dir = dir_temp_local("vpdeco");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let tmp = dir.join("v.pdf");
        let total = Document::load(&entrada).map_err(|e| e.to_string())?.get_pages().len() as u32;
        let primera = edicion::paginas_de(&decorado.paginas, total)?.first().copied().unwrap_or(1);
        let r = edicion::decorar(&entrada, &tmp.to_string_lossy(), &decorado)
            .and_then(|_| render_gs_png(&tmp.to_string_lossy(), primera, 80))
            .map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&b)));
        limpiar_dir_temp(&dir);
        r
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn leer_metadatos(ruta: String) -> Result<edicion::Meta, String> {
    tauri::async_runtime::spawn_blocking(move || edicion::leer_meta(&ruta)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn limpiar_metadatos(entrada: String, salida: String, opciones: edicion::LimpiarMeta) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || edicion::limpiar_meta(&entrada, &salida, &opciones)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn leer_formulario(ruta: String) -> Result<Vec<edicion::Campo>, String> {
    tauri::async_runtime::spawn_blocking(move || edicion::leer_campos(&ruta)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn rellenar_formulario(entrada: String, salida: String, valores: std::collections::HashMap<String, String>, aplanar: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || edicion::rellenar(&entrada, &salida, &valores, aplanar)).await.map_err(|e| e.to_string())?
}
/// Vista previa de un formulario rellenado (primera página con campos).
#[tauri::command]
async fn vista_previa_formulario(entrada: String, valores: std::collections::HashMap<String, String>, pagina: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let dir = dir_temp_local("vpform");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let tmp = dir.join("v.pdf");
        let r = edicion::rellenar(&entrada, &tmp.to_string_lossy(), &valores, false)
            .and_then(|_| render_gs_png(&tmp.to_string_lossy(), pagina.max(1), 80))
            .map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&b)));
        limpiar_dir_temp(&dir);
        r
    }).await.map_err(|e| e.to_string())?
}

// ───────────────────── Lotes y perfiles ─────────────────────

/// Lista los PDF de una carpeta (opcionalmente con subcarpetas), ordenados. `excluir`: carpeta que no se recorre (la de salida).
#[tauri::command]
fn listar_pdfs_carpeta(ruta: String, recursivo: bool, excluir: Option<String>, office: Option<bool>) -> Result<Vec<String>, String> {
    fn rec(dir: &std::path::Path, recursivo: bool, excl: &Option<PathBuf>, office: bool, v: &mut Vec<String>, prof: u32) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if recursivo && prof < 12 && excl.as_ref().map(|x| x != &p).unwrap_or(true) { rec(&p, recursivo, excl, office, v, prof + 1); }
            } else if p.extension().map(|x| x.to_string_lossy().eq_ignore_ascii_case("pdf")).unwrap_or(false) {
                v.push(p.to_string_lossy().into_owned());
            } else if office && office::tipo_de(&p).is_some() {
                // «~$Informe.docx» es el archivo de bloqueo que crea Office mientras el documento está abierto
                let nombre = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if !nombre.starts_with("~$") { v.push(p.to_string_lossy().into_owned()); }
            }
        }
    }
    let base = PathBuf::from(&ruta);
    if !base.is_dir() { return Err("La carpeta no existe.".into()); }
    let excl = excluir.filter(|e| !e.trim().is_empty()).map(PathBuf::from);
    let mut v = vec![];
    rec(&base, recursivo, &excl, office.unwrap_or(false), &mut v, 0);
    v.sort_by_key(|s| s.to_lowercase());
    Ok(v)
}

#[derive(serde::Deserialize, Clone)]
#[serde(tag = "tipo", rename_all = "snake_case")]
enum Paso {
    /// Word, Excel o PowerPoint → PDF con el Office instalado. Siempre el primer paso; los PDF lo pasan sin cambios.
    Convertir { opciones: office::Opciones },
    Comprimir { nivel: String },
    Ocr { idioma: String },
    Decorar { decorado: edicion::Decorado },
    Metadatos { opciones: edicion::LimpiarMeta },
    Aplanar,
    Firmar { opciones: firma::Opciones },
    /// Imprime el PDF tal como está en ese punto de la cadena (no lo modifica). Puede ir después de la firma.
    Imprimir { ajustes: imprimir::Ajustes },
}

#[derive(serde::Serialize)]
struct ResultadoLote { entrada: String, salida: String, ok: bool, error: String, tamano_entrada: u64, tamano_salida: u64, aviso: String }

fn destino_lote(entrada: &str, base: &Option<String>, carpeta: &str, sufijo: &str) -> PathBuf {
    let ent = PathBuf::from(entrada);
    let rel_dir: PathBuf = match base {
        Some(b) if !b.trim().is_empty() => ent.parent().and_then(|p| p.strip_prefix(b).ok()).map(|p| p.to_path_buf()).unwrap_or_default(),
        _ => PathBuf::new(),
    };
    let dir = PathBuf::from(carpeta).join(rel_dir);
    let stem = ent.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "documento".into());
    let mut cand = dir.join(format!("{stem}{sufijo}.pdf"));
    if cand == ent { cand = dir.join(format!("{stem}_proc.pdf")); }
    let mut n = 2;
    while cand.exists() { cand = dir.join(format!("{stem}{sufijo} ({n}).pdf")); n += 1; }
    cand
}

/// Aplica una secuencia de pasos a cada PDF y guarda el resultado en `carpeta_salida`.
// ═══════════════════════════════ IMPRESIÓN ═══════════════════════════════

#[tauri::command]
fn listar_impresoras() -> Result<Vec<imprimir::Impresora>, String> {
    #[cfg(windows)]
    { imprimir::win::listar() }
    #[cfg(not(windows))]
    { Ok(vec![]) }
}

#[derive(Serialize)]
struct InfoImpresion { sumatra: bool }

#[tauri::command]
fn info_impresion() -> InfoImpresion { InfoImpresion { sumatra: ruta_util("sumatra/SumatraPDF.exe").is_ok() } }

/// ¿Acepta PDF esta impresora? Pregunta por IPP y SNMP. Con `direccion` (escrita por el usuario) no hace falta
/// averiguarla a partir de la configuración de Windows.
#[tauri::command]
async fn sondear_impresora(impresora: String, direccion: Option<String>) -> Result<sondeo::Sondeo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(d) = direccion.as_deref().map(str::trim).filter(|d| !d.is_empty()) { return sondeo::sondear_direccion(d); }
        #[cfg(windows)]
        {
            match imprimir::win::direccion(&impresora) {
                Ok(d) => sondeo::sondear_direccion(&d),
                Err(motivo) => sondeo::Sondeo { pide_direccion: true, ..sondeo::Sondeo::desconocido(format!("{motivo} Si sabes su dirección IP, escríbela para comprobarla."), "") },
            }
        }
        #[cfg(not(windows))]
        { let _ = &impresora; sondeo::Sondeo { pide_direccion: true, ..sondeo::Sondeo::desconocido("Escribe la dirección IP de la impresora para comprobarla.", "") } }
    }).await.map_err(|e| e.to_string())
}

/// Fallo de un método de impresión. `reintentable = false` si pudo llegar a imprimirse algo
/// (p. ej. tiempo agotado): entonces no se prueba otro método, para no imprimir dos veces.
struct FalloImpresion { msg: String, reintentable: bool }
impl From<String> for FalloImpresion { fn from(msg: String) -> Self { FalloImpresion { msg, reintentable: true } } }

#[cfg(windows)]
static VENTANAS_IMPRESION: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Abre el PDF en una ventana WebView2 propia y espera a que termine de cargar.
/// `dialogo = false`: ventana fuera de pantalla, sin barra de tareas (impresión directa con ajustes).
#[cfg(windows)]
async fn ventana_pdf(app: &tauri::AppHandle, ruta: &str, dialogo: bool) -> Result<tauri::WebviewWindow, String> {
    use std::sync::mpsc;
    let url = tauri::Url::from_file_path(ruta).map_err(|_| "Ruta de archivo no válida.".to_string())?;
    let label = format!("imprimir-{}", VENTANAS_IMPRESION.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = mpsc::channel::<()>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let nombre = PathBuf::from(ruta).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut b = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(url))
        .title(format!("Imprimir — {nombre}"))
        .on_page_load(move |_w, p| {
            if p.event() == tauri::webview::PageLoadEvent::Finished {
                if let Some(t) = tx.lock().ok().and_then(|mut g| g.take()) { let _ = t.send(()); }
            }
        });
    b = if dialogo {
        b.inner_size(960.0, 760.0).center().focused(true)
    } else {
        // visible pero fuera de pantalla: así WebView2 sí dibuja el documento
        b.position(-32000.0, -32000.0).inner_size(800.0, 1000.0).skip_taskbar(true).decorations(false).focused(false)
    };
    let win = b.build().map_err(|e| format!("No se pudo preparar la impresión: {e}"))?;
    let cargado = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(25)).is_ok())
        .await.unwrap_or(false);
    if !cargado { let _ = win.destroy(); return Err("El documento tardó demasiado en abrirse en WebView2.".into()); }
    // el visor de PDF de WebView2 termina de montarse un poco después del evento de carga
    tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(1500))).await.ok();
    Ok(win)
}

#[cfg(windows)]
async fn imprimir_por_webview(app: &tauri::AppHandle, ruta: &str, aj: &imprimir::Ajustes) -> Result<Vec<String>, FalloImpresion> {
    use std::sync::mpsc;
    let win = ventana_pdf(app, ruta, false).await?;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let (aj2, tx_err) = (aj.clone(), tx.clone());
    let lanzado = win.with_webview(move |wv| {
        if let Err(e) = imprimir::win::imprimir_webview(&wv, &aj2, tx) { let _ = tx_err.send(Err(e)); }
    });
    if let Err(e) = lanzado { let _ = win.destroy(); return Err(format!("WebView2 no disponible: {e}").into()); }
    let r = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(300)))
        .await.map_err(|e| FalloImpresion::from(e.to_string()))?;
    let _ = win.destroy();
    match r {
        Ok(Ok(())) => Ok(vec![]),
        Ok(Err(e)) => Err(e.into()),
        Err(_) => Err(FalloImpresion { msg: "La impresora no respondió en 5 minutos. Revisa la cola de impresión antes de volver a intentarlo.".into(), reintentable: false }),
    }
}

fn avisos_no_admitidos(aj: &imprimir::Ajustes, metodo: &str) -> Vec<String> {
    let mut no: Vec<&str> = vec![];
    let (pjl, sumatra) = (metodo == "directo", metodo == "sumatra");
    if aj.por_hoja > 1 { no.push("varias páginas por hoja"); }
    if aj.orientacion != "auto" { no.push("orientación"); }
    if !pjl && !sumatra && aj.doble_cara != "auto" { no.push("doble cara"); }
    if !pjl && !sumatra && aj.color != "auto" { no.push("color"); }
    if no.is_empty() { vec![] } else { vec![format!("Con {} no se aplica: {}. Se usa la configuración de la impresora.", imprimir::nombre_metodo(metodo), no.join(", "))] }
}

#[cfg(windows)]
fn impresora_o_predeterminada(aj: &imprimir::Ajustes) -> Result<String, String> {
    aj.impresora.clone().filter(|s| !s.trim().is_empty()).or_else(imprimir::win::predeterminada)
        .ok_or_else(|| "No hay ninguna impresora predeterminada en Windows. Elige una impresora.".to_string())
}

/// Copia temporal con las páginas pedidas (o el original si son todas).
fn preparar_paginas(ruta: &str, aj: &imprimir::Ajustes, dir: &std::path::Path) -> Result<String, String> {
    if aj.paginas.trim().is_empty() { return Ok(ruta.to_string()); }
    let total = Document::load(ruta).map_err(|e| format!("No se pudo abrir el PDF: {e}"))?.get_pages().len() as u32;
    let nums = parsear_rango(&aj.paginas, total)?;
    Ok(imprimir::subconjunto(ruta, &nums, total, dir)?.map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| ruta.to_string()))
}

#[cfg(windows)]
fn imprimir_por_programa(metodo: &str, ruta: &str, aj: &imprimir::Ajustes) -> Result<Vec<String>, String> {
    let impresora = impresora_o_predeterminada(aj)?;
    let dir = dir_temp_local("imprimir");
    let r = (|| -> Result<(), String> {
        match metodo {
            "directo" => {
                let archivo = preparar_paginas(ruta, aj, &dir)?;
                let pdf = fs::read(&archivo).map_err(|e| format!("No se pudo leer el PDF: {e}"))?;
                let titulo = PathBuf::from(ruta).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "PDF".into());
                imprimir::win::enviar_raw(&impresora, &titulo, &imprimir::trabajo_pjl(&pdf, aj))
            }
            "sumatra" => {
                let exe = ruta_util("sumatra/SumatraPDF.exe").map_err(|_| "No está SumatraPDF en UTILS\\sumatra\\SumatraPDF.exe.".to_string())?;
                let st = comando_silencioso(&exe)
                    .args(["-print-to", &impresora, "-print-settings", &imprimir::ajustes_sumatra(aj), "-silent", ruta])
                    .status().map_err(|e| format!("No se pudo ejecutar SumatraPDF: {e}"))?;
                if st.success() { Ok(()) } else { Err("SumatraPDF no pudo imprimir el documento.".into()) }
            }
            "ghostscript" => {
                let gs = ruta_util("gs/bin/gswin64c.exe")?;
                let archivo = preparar_paginas(ruta, aj, &dir)?;
                for _ in 0..aj.copias.clamp(1, 50) {
                    let st = comando_gs(&gs)
                        .args(["-dNOPAUSE", "-dBATCH", "-dQUIET", "-dNoCancel", "-dFitPage", "-sDEVICE=mswinpr2",
                               &format!("-sOutputFile=%printer%{impresora}"), &archivo])
                        .status().map_err(|e| format!("No se pudo ejecutar Ghostscript: {e}"))?;
                    if !st.success() { return Err("Ghostscript no pudo imprimir el documento.".into()); }
                }
                Ok(())
            }
            _ => Err("Método de impresión desconocido.".into()),
        }
    })();
    limpiar_dir_temp(&dir);
    r.map(|_| avisos_no_admitidos(aj, metodo))
}

/// Imprime un PDF. En modo «auto» prueba WebView2 → SumatraPDF (si está) → Ghostscript.
#[tauri::command]
async fn imprimir_pdf(app: tauri::AppHandle, ruta: String, ajustes: imprimir::Ajustes) -> Result<imprimir::Resultado, String> {
    imprimir_archivo(&app, &ruta, &ajustes).await
}

/// Lógica común de impresión (panel «Imprimir» y paso «Imprimir» de Lotes).
async fn imprimir_archivo(app: &tauri::AppHandle, ruta: &str, ajustes: &imprimir::Ajustes) -> Result<imprimir::Resultado, String> {
    if !std::path::Path::new(ruta).exists() { return Err("No se encuentra el archivo.".into()); }
    #[cfg(not(windows))]
    { let _ = (app, ajustes); Err("La impresión solo está disponible en Windows.".into()) }
    #[cfg(windows)]
    {
        // Marca o pie solo en la copia impresa: se imprime una copia temporal decorada.
        let dir_copia = dir_temp_local("impcopia");
        let ruta_imp = match ajustes.decorado_copia() {
            Some(d) => {
                fs::create_dir_all(&dir_copia).map_err(|e| e.to_string())?;
                let tmp = dir_copia.join(PathBuf::from(ruta).file_name().unwrap_or_default());
                let (a, b) = (ruta.to_string(), tmp.to_string_lossy().into_owned());
                let b2 = b.clone();
                tauri::async_runtime::spawn_blocking(move || edicion::decorar(&a, &b2, &d)).await.map_err(|e| e.to_string())??;
                b
            }
            None => ruta.to_string(),
        };
        let r = imprimir_con_metodos(app, &ruta_imp, ajustes).await;
        limpiar_dir_temp(&dir_copia);
        r
    }
}

#[cfg(windows)]
async fn imprimir_con_metodos(app: &tauri::AppHandle, ruta: &str, ajustes: &imprimir::Ajustes) -> Result<imprimir::Resultado, String> {
    let hay_sumatra = ruta_util("sumatra/SumatraPDF.exe").is_ok();
    let orden: Vec<&str> = match ajustes.metodo.as_str() {
        "auto" => if hay_sumatra { vec!["webview", "sumatra", "ghostscript"] } else { vec!["webview", "ghostscript"] },
        m => vec![m],
    };
    let mut fallos: Vec<String> = vec![];
    for m in orden {
        let r: Result<Vec<String>, FalloImpresion> = if m == "webview" {
            imprimir_por_webview(app, ruta, ajustes).await
        } else {
            let (m2, ruta2, aj2) = (m.to_string(), ruta.to_string(), ajustes.clone());
            tauri::async_runtime::spawn_blocking(move || imprimir_por_programa(&m2, &ruta2, &aj2))
                .await.map_err(|e| e.to_string()).and_then(|x| x).map_err(FalloImpresion::from)
        };
        match r {
            Ok(mut av) => {
                let mut avisos = vec![];
                if !fallos.is_empty() { avisos.push(format!("Se imprimió con {} porque antes falló: {}", imprimir::nombre_metodo(m), fallos.join(" · "))); }
                avisos.append(&mut av);
                return Ok(imprimir::Resultado { metodo: m.into(), avisos });
            }
            Err(f) => {
                let nombre = imprimir::nombre_metodo(m);
                let nombre = nombre[..1].to_uppercase() + &nombre[1..];
                fallos.push(format!("{nombre}: {}", f.msg));
                if !f.reintentable { break; }
            }
        }
    }
    Err(fallos.join("\n"))
}

/// Abre el PDF en una ventana y muestra el diálogo de impresión de Windows (bandejas, grapado, preferencias del driver…).
#[tauri::command]
async fn dialogo_impresion(app: tauri::AppHandle, ruta: String) -> Result<(), String> {
    if !std::path::Path::new(&ruta).exists() { return Err("No se encuentra el archivo.".into()); }
    #[cfg(not(windows))]
    { let _ = &app; Err("La impresión solo está disponible en Windows.".into()) }
    #[cfg(windows)]
    {
        let win = ventana_pdf(&app, &ruta, true).await?;
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        win.with_webview(move |wv| { let _ = tx.send(imprimir::win::dialogo_sistema(&wv)); }).map_err(|e| e.to_string())?;
        let r = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(20)).unwrap_or(Ok(())))
            .await.map_err(|e| e.to_string())?;
        if r.is_err() { let _ = win.destroy(); }
        r
    }
}

/// Firma (en un único hilo, abriendo el certificado una vez) los PDF intermedios de un lote.
/// Si no se puede abrir el certificado, todos quedan con ese error.
fn firmar_pendientes_lote(opciones: &firma::Opciones, pend: &[(usize, PathBuf, PathBuf, PathBuf)]) -> Vec<Result<PathBuf, String>> {
    #[cfg(windows)]
    {
        let preparar = || -> Result<firma::capi::Almacen, String> { abrir_almacen(&opciones.cert_origen, &opciones.pfx_ruta, &opciones.pfx_clave) };
        let alm = match preparar() { Ok(a) => a, Err(e) => return pend.iter().map(|_| Err(e.clone())).collect() };
        let cert = match alm.firmante(&opciones.cert_id) {
            Ok(c) if c.info.caducado => { let e = format!("El certificado de {} caducó el {}.", c.info.nombre, c.info.caduca); return pend.iter().map(|_| Err(e.clone())).collect(); }
            Ok(c) => c,
            Err(e) => return pend.iter().map(|_| Err(e.clone())).collect(),
        };
        pend.iter().map(|(_, intermedio, dir, dest)| {
            let firmado = dir.join("firmado.pdf");
            let (a, b) = (intermedio.to_string_lossy().into_owned(), firmado.to_string_lossy().into_owned());
            firma::firmar_pdf(&a, &b, opciones, &cert.info, if opciones.criptografica { Some(&cert) } else { None })?;
            mover_archivo(&firmado, dest)?;
            Ok(dest.clone())
        }).collect()
    }
    #[cfg(not(windows))]
    { let _ = opciones; pend.iter().map(|_| Err("La firma con certificado solo está disponible en Windows.".to_string())).collect() }
}

/// La firma, si existe, debe ser el último paso (cualquier cambio posterior la invalidaría).
#[tauri::command]
async fn ejecutar_lote(app: tauri::AppHandle, entradas: Vec<String>, base: Option<String>, carpeta_salida: String, sufijo: String, pasos: Vec<Paso>) -> Result<Vec<ResultadoLote>, String> {
    if pasos.is_empty() { return Err("El perfil no tiene ningún paso.".into()); }
    if pasos.iter().skip(1).any(|p| matches!(p, Paso::Convertir { .. })) {
        return Err("«Convertir a PDF» tiene que ser el primer paso del perfil.".into());
    }
    let con_conversion = matches!(pasos.first(), Some(Paso::Convertir { .. }));
    if carpeta_salida.trim().is_empty() { return Err("Elige la carpeta de salida.".into()); }
    if let Some(i) = pasos.iter().position(|p| matches!(p, Paso::Firmar { .. })) {
        if pasos[i + 1..].iter().any(|p| !matches!(p, Paso::Imprimir { .. })) {
            return Err("La firma debe ser el último paso que modifica el PDF (después solo puede ir «Imprimir»).".into());
        }
    }
    #[cfg(not(windows))]
    if pasos.iter().any(|p| matches!(p, Paso::Firmar { .. })) { return Err("La firma con certificado solo está disponible en Windows.".into()); }
    {
        let st = app.state::<EstadoApp>();
        st.cancelar.store(false, Ordering::SeqCst);
    }
    fs::create_dir_all(&carpeta_salida).map_err(|e| format!("No se pudo crear la carpeta de salida: {e}"))?;
    let total = entradas.len();
    let mut res: Vec<ResultadoLote> = vec![];
    // Archivos que esperan la firma (último paso): (posición en `res`, PDF intermedio, carpeta temporal, destino).
    // La firma se hace al final, en un hilo propio y con el certificado abierto una sola vez: sus punteros de
    // CryptoAPI no pueden cruzar los `await` de los demás pasos.
    let firma_final = pasos.iter().find_map(|p| match p { Paso::Firmar { opciones } => Some(opciones.clone()), _ => None });
    // impresiones que van después de la firma (se hacen sobre el PDF ya firmado)
    let imprimir_tras_firma: Vec<imprimir::Ajustes> = pasos.iter().skip_while(|p| !matches!(p, Paso::Firmar { .. }))
        .filter_map(|p| match p { Paso::Imprimir { ajustes } => Some(ajustes.clone()), _ => None }).collect();
    let mut pend_firma: Vec<(usize, PathBuf, PathBuf, PathBuf)> = vec![];
    for (i, ent) in entradas.iter().enumerate() {
        let _ = app.emit("lote-progreso", serde_json::json!({ "actual": i, "total": total, "archivo": ent }));
        if esta_cancelado(&app.state::<EstadoApp>()) { res.push(ResultadoLote { entrada: ent.clone(), salida: String::new(), ok: false, error: "Cancelado".into(), tamano_entrada: 0, tamano_salida: 0, aviso: String::new() }); continue; }
        let tam_in = fs::metadata(ent).map(|m| m.len()).unwrap_or(0);
        let dir = dir_temp_local(&format!("lote{}", i));
        let mut avisos: Vec<String> = vec![];
        let r: Result<PathBuf, String> = async {
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let mut actual = PathBuf::from(ent);
            let es_office = office::tipo_de(&actual).is_some();
            if es_office && !con_conversion { return Err("Es un documento de Office: añade el paso «Convertir a PDF» al principio del perfil.".into()); }
            if !es_office && !actual.extension().map(|x| x.to_string_lossy().eq_ignore_ascii_case("pdf")).unwrap_or(false) {
                return Err("Formato no admitido: solo PDF y documentos de Office.".into());
            }
            for (k, paso) in pasos.iter().enumerate() {
                if matches!(paso, Paso::Firmar { .. }) { break; } // se firma después, todos juntos
                let sig = dir.join(format!("paso{}.pdf", k));
                let (a, b) = (actual.to_string_lossy().into_owned(), sig.to_string_lossy().into_owned());
                if let Paso::Convertir { opciones } = paso {
                    if !es_office { continue; } // los PDF no necesitan conversión
                    let _ = app.emit("lote-progreso", serde_json::json!({ "actual": i, "total": total, "archivo": ent, "fase": "Convirtiendo a PDF" }));
                    let (op, cancelar) = (opciones.clone(), app.state::<EstadoApp>().cancelar.clone());
                    tauri::async_runtime::spawn_blocking(move || office::convertir(std::path::Path::new(&a), std::path::Path::new(&b), &op, &cancelar))
                        .await.map_err(|e| e.to_string())??;
                    actual = sig;
                    continue;
                }
                if let Paso::Imprimir { ajustes } = paso {
                    // un fallo al imprimir no invalida el archivo procesado: queda como aviso
                    match imprimir_archivo(&app, &a, ajustes).await {
                        Ok(r) => { avisos.push("Impreso".into()); avisos.extend(r.avisos); }
                        Err(e) => avisos.push(format!("No se pudo imprimir: {}", e.replace('\n', " · "))),
                    }
                    continue;
                }
                match paso {
                    Paso::Comprimir { nivel } => {
                        ejecutar_compresion(&app, &a, &b, nivel).await?;
                        let (ta, tb) = (fs::metadata(&a).map(|m| m.len()).unwrap_or(0), fs::metadata(&b).map(|m| m.len()).unwrap_or(0));
                        if ta > 0 && tb >= ta { fs::copy(&a, &b).map_err(|e| e.to_string())?; }
                    }
                    Paso::Ocr { idioma } => {
                        let app2 = app.clone(); let idioma = idioma.clone();
                        tauri::async_runtime::spawn_blocking(move || ejecutar_ocr(&app2, &a, &b, &idioma, 300, false)).await.map_err(|e| e.to_string())??;
                    }
                    Paso::Decorar { decorado } => edicion::decorar(&a, &b, decorado)?,
                    Paso::Metadatos { opciones } => edicion::limpiar_meta(&a, &b, opciones)?,
                    Paso::Aplanar => {
                        // aplanar todos los campos (si no hay formulario, se copia sin cambios)
                        match edicion::rellenar(&a, &b, &std::collections::HashMap::new(), true) {
                            Ok(()) => {}
                            Err(e) if e.contains("no tiene campos") => { fs::copy(&a, &b).map_err(|e| e.to_string())?; }
                            Err(e) => return Err(e),
                        }
                    }
                    Paso::Firmar { .. } | Paso::Imprimir { .. } | Paso::Convertir { .. } => unreachable!(),
                }
                actual = sig;
            }
            let dest = destino_lote(ent, &base, &carpeta_salida, &sufijo);
            if let Some(p) = dest.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            if firma_final.is_some() { return Ok(actual); } // queda pendiente de firmar
            mover_archivo(&actual, &dest)?;
            Ok(dest)
        }.await;
        if firma_final.is_some() {
            if let Ok(intermedio) = &r {
                pend_firma.push((res.len(), intermedio.clone(), dir.clone(), destino_lote(ent, &base, &carpeta_salida, &sufijo)));
                res.push(ResultadoLote { entrada: ent.clone(), salida: String::new(), ok: false, error: "Pendiente de firma".into(), tamano_entrada: tam_in, tamano_salida: 0, aviso: avisos.join(" · ") });
                continue;
            }
        }
        limpiar_dir_temp(&dir);
        res.push(match r {
            Ok(d) => ResultadoLote { entrada: ent.clone(), tamano_salida: fs::metadata(&d).map(|m| m.len()).unwrap_or(0), salida: d.to_string_lossy().into_owned(), ok: true, error: String::new(), tamano_entrada: tam_in, aviso: avisos.join(" · ") },
            Err(e) => ResultadoLote { entrada: ent.clone(), salida: String::new(), ok: false, error: e, tamano_entrada: tam_in, tamano_salida: 0, aviso: avisos.join(" · ") },
        });
    }
    if let (Some(opciones), false) = (firma_final, pend_firma.is_empty()) {
        let _ = app.emit("lote-progreso", serde_json::json!({ "actual": total, "total": total, "archivo": "Firmando…" }));
        let pend = pend_firma.clone();
        let firmados = tauri::async_runtime::spawn_blocking(move || firmar_pendientes_lote(&opciones, &pend))
            .await.map_err(|e| e.to_string())?;
        for ((pos, _, dir, _), r) in pend_firma.iter().zip(firmados) {
            limpiar_dir_temp(dir);
            let it = &mut res[*pos];
            match r {
                Ok(d) => {
                    it.tamano_salida = fs::metadata(&d).map(|m| m.len()).unwrap_or(0); it.salida = d.to_string_lossy().into_owned(); it.ok = true; it.error.clear();
                    for aj in &imprimir_tras_firma {
                        match imprimir_archivo(&app, &it.salida, aj).await {
                            Ok(_) => { if !it.aviso.is_empty() { it.aviso.push_str(" · "); } it.aviso.push_str("Impreso"); }
                            Err(e) => { if !it.aviso.is_empty() { it.aviso.push_str(" · "); } it.aviso.push_str(&format!("No se pudo imprimir: {}", e.replace('\n', " · "))); }
                        }
                    }
                }
                Err(e) => { it.error = e; }
            }
        }
    }
    let _ = app.emit("lote-progreso", serde_json::json!({ "actual": total, "total": total, "archivo": "" }));
    Ok(res)
}

// ───────────── Office a PDF ─────────────

#[tauri::command]
async fn info_office() -> office::InfoOffice {
    tauri::async_runtime::spawn_blocking(office::info).await.unwrap_or_default()
}

/// Convierte un documento de Word, Excel o PowerPoint a PDF con el Office instalado. Devuelve el tamaño del PDF.
#[tauri::command]
async fn convertir_office(app: tauri::AppHandle, entrada: String, salida: String, opciones: office::Opciones) -> Result<u64, String> {
    let estado = app.state::<EstadoApp>();
    if esta_cancelado(&estado) { return Err("Operación cancelada".into()); }
    let cancelar = estado.cancelar.clone();
    tauri::async_runtime::spawn_blocking(move || {
        office::convertir(std::path::Path::new(&entrada), std::path::Path::new(&salida), &opciones, &cancelar)
    })
    .await
    .map_err(|e| format!("Error interno: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    instalar_gancho_panico();
    registrar_error("INICIO", "aplicación iniciada");
    tauri::Builder::default()
        .manage(EstadoApp::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            // Limpia carpetas temporales huérfanas de ejecuciones anteriores
            // (cierres inesperados, o quedadas de versiones previas con el bug
            // de limpieza tras cancelar OCR).
            limpiar_temporales_huerfanos();
            Ok(())
        })
        .on_window_event(|window, event| {
            // Solo la ventana principal pregunta antes de cerrar; las de impresión se cierran sin más.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    window.emit("close-requested", ()).ok();
                }
            }
            // Al cerrar la ventana principal se cierra la app, aunque quede abierta alguna ventana de impresión.
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" { window.app_handle().exit(0); }
            }
        })
        .invoke_handler(tauri::generate_handler![
            combinar_pdfs,
            decorar_pdf,
            vista_previa_decorado,
            leer_metadatos,
            limpiar_metadatos,
            leer_formulario,
            rellenar_formulario,
            vista_previa_formulario,
            listar_pdfs_carpeta,
            ejecutar_lote,
            listar_impresoras,
            sondear_impresora,
            info_office,
            convertir_office,
            info_impresion,
            imprimir_pdf,
            dialogo_impresion,
            comprimir_pdf,
            ocr_pdf,
            estado_utils,
            abrir_carpeta,
            abrir_archivo,
            analizar_compresion,
            comprimir_a_tamano,
            abrir_carpeta_utils,
            open_url,
            comprobar_bloqueo,
            cerrar_procesos,
            borrar_archivos,
            archivo_existe,
            comprobar_pdf,
            validar_pdfs,
            extraer_paginas,
            generar_miniaturas_paginas,
            renderizar_pagina,
            guardar_anotaciones,
            listar_certificados,
            firmar_pdfs,
            estado_firmas,
            validar_firmas,
            completar_firma,
            aplicar_organizacion,
            preparar_mixto,
            limpiar_carpeta_cola,
            eliminar_archivo,
            buscar_texto,
            miniaturas_visor,
            reordenar_paginas,
            dividir_pdf,
            escribir_log,
            registrar_error_js,
            leer_errores,
            cancelar_operacion,
            resetear_cancelacion,
            leer_log,
            cerrar_ventana,
            imagenes_a_pdf,
            imagen_a_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error al ejecutar la aplicación");
}
