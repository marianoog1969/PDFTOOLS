//! Edición de PDF con lopdf: marca de agua, numeración, tachado real (redacción),
//! metadatos y formularios. Todo trabaja sobre una COPIA (entrada → salida).
//! Las coordenadas de zonas llegan como fracciones (0..1) de la página TAL COMO SE VE
//! (con /Rotate y /CropBox aplicados), igual que en anotaciones.rs.

use crate::anotaciones::{caja, heredado, rotacion, winansi_hex};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

// ───────────────────────── utilidades ─────────────────────────

fn f(n: f64) -> String { format!("{:.3}", n) }

fn num(o: &Object) -> Option<f64> {
    match o { Object::Integer(i) => Some(*i as f64), Object::Real(r) => Some(*r as f64), _ => None }
}

fn resolver<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    if let Object::Reference(id) = o { doc.get_object(*id).unwrap_or(o) } else { o }
}

fn dic<'a>(doc: &'a Document, o: &'a Object) -> Option<&'a Dictionary> {
    match resolver(doc, o) { Object::Dictionary(d) => Some(d), Object::Stream(s) => Some(&s.dict), _ => None }
}

fn nombre_de(o: &Object) -> Option<String> {
    if let Object::Name(n) = o { Some(String::from_utf8_lossy(n).into_owned()) } else { None }
}

/// Texto PDF (PDFDocEncoding / UTF-16BE con BOM) → String.
pub fn texto_pdf(b: &[u8]) -> String {
    if b.len() >= 2 && b[0] == 0xFE && b[1] == 0xFF {
        let u: Vec<u16> = b[2..].chunks(2).filter(|c| c.len() == 2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&u)
    } else { b.iter().map(|&c| c as char).collect() }
}

/// String → texto PDF (literal ASCII/Latin-1 si cabe, si no UTF-16BE con BOM).
pub fn a_texto_pdf(s: &str) -> Object {
    let mut bytes = Vec::new();
    if s.chars().all(|c| (c as u32) < 256) { bytes.extend(s.chars().map(|c| c as u32 as u8)); }
    else { bytes.extend([0xFE, 0xFF]); for u in s.encode_utf16() { bytes.extend(u.to_be_bytes()); } }
    Object::String(bytes, lopdf::StringFormat::Literal)
}

/// Anchos de Helvetica (1/1000 em) para ASCII 32..126; las letras con tilde usan la base.
fn ancho_char(c: char) -> f64 {
    const W: [u16; 95] = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
        556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
        1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
        667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
        333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
        556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
    let base = match c {
        'á'|'à'|'ä'|'â'|'ã'|'å' => 'a', 'é'|'è'|'ë'|'ê' => 'e', 'í'|'ì'|'ï'|'î' => 'i',
        'ó'|'ò'|'ö'|'ô'|'õ' => 'o', 'ú'|'ù'|'ü'|'û' => 'u', 'ñ' => 'n', 'ç' => 'c',
        'Á'|'À'|'Ä'|'Â' => 'A', 'É'|'È'|'Ë'|'Ê' => 'E', 'Í'|'Ì'|'Ï'|'Î' => 'I',
        'Ó'|'Ò'|'Ö'|'Ô'|'Õ' => 'O', 'Ú'|'Ù'|'Ü'|'Û' => 'U', 'Ñ' => 'N', 'Ç' => 'C',
        c => c,
    };
    let n = base as u32;
    if (32..127).contains(&n) { W[(n - 32) as usize] as f64 } else { 556.0 }
}
pub fn ancho_texto(t: &str, tam: f64) -> f64 { t.chars().map(ancho_char).sum::<f64>() * tam / 1000.0 }

/// "todas" | "" | "1-3,5,8-" → lista de páginas (1..=total) en orden y sin repetir.
pub fn paginas_de(spec: &str, total: u32) -> Result<Vec<u32>, String> {
    let s = spec.trim().to_lowercase();
    if s.is_empty() || s == "todas" { return Ok((1..=total).collect()); }
    let mut v: Vec<u32> = vec![];
    for parte in s.split(',') {
        let p = parte.trim();
        if p.is_empty() { continue; }
        let (a, b) = match p.split_once('-') {
            Some((a, b)) => (a.trim(), Some(b.trim())),
            None => (p, None),
        };
        let ini: u32 = if a.is_empty() { 1 } else { a.parse().map_err(|_| format!("Rango no válido: «{}»", p))? };
        let fin: u32 = match b { None => ini, Some("") => total, Some(x) => x.parse().map_err(|_| format!("Rango no válido: «{}»", p))? };
        if ini == 0 || fin < ini { return Err(format!("Rango no válido: «{}»", p)); }
        for n in ini..=fin.min(total) { if !v.contains(&n) { v.push(n); } }
    }
    if v.is_empty() { return Err("Ninguna de las páginas indicadas existe.".into()); }
    v.sort_unstable();
    Ok(v)
}

/// Añade contenido al final de la página (envolviendo el original en q/Q) y recursos nuevos.
/// `extras`: (categoría de recursos, nombre, objeto).
fn agregar_a_pagina(doc: &mut Document, page_id: ObjectId, contenido: String, extras: Vec<(&'static str, String, Object)>) -> Result<(), String> {
    let mut recursos = match heredado(doc, page_id, b"Resources") { Some(Object::Dictionary(d)) => d, _ => Dictionary::new() };
    for (cat, nombre, valor) in extras {
        let mut d = match recursos.get(cat.as_bytes()).ok().map(|o| resolver(doc, o).clone()) {
            Some(Object::Dictionary(d)) => d, _ => Dictionary::new(),
        };
        d.set(nombre.into_bytes(), valor);
        recursos.set(cat.as_bytes().to_vec(), Object::Dictionary(d));
    }
    let originales: Vec<Object> = {
        let p = doc.get_object(page_id).map_err(|e| e.to_string())?.as_dict().map_err(|e| e.to_string())?;
        match p.get(b"Contents") {
            Ok(Object::Array(a)) => a.clone(),
            Ok(Object::Reference(id)) => match doc.get_object(*id) { Ok(Object::Array(a)) => a.clone(), _ => vec![Object::Reference(*id)] },
            _ => vec![],
        }
    };
    let q_ini = doc.add_object(Stream::new(Dictionary::new(), b"q\n".to_vec()));
    let q_fin = doc.add_object(Stream::new(Dictionary::new(), b"\nQ\n".to_vec()));
    let nuestro = doc.add_object(Stream::new(Dictionary::new(), contenido.into_bytes()));
    let mut nuevo = vec![Object::Reference(q_ini)];
    nuevo.extend(originales);
    nuevo.extend([Object::Reference(q_fin), Object::Reference(nuestro)]);
    let p = doc.get_object_mut(page_id).map_err(|e| e.to_string())?.as_dict_mut().map_err(|e| e.to_string())?;
    p.set("Contents", Object::Array(nuevo));
    p.set("Resources", Object::Dictionary(recursos));
    Ok(())
}

fn fuente_helvetica(doc: &mut Document) -> ObjectId {
    let mut d = Dictionary::new();
    d.set("Type", Object::Name(b"Font".to_vec()));
    d.set("Subtype", Object::Name(b"Type1".to_vec()));
    d.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
    d.set("Encoding", Object::Name(b"WinAnsiEncoding".to_vec()));
    doc.add_object(Object::Dictionary(d))
}

fn abrir(ruta: &str) -> Result<Document, String> {
    let d = Document::load(ruta).map_err(|e| format!("Error al abrir el PDF: {}", e))?;
    if d.is_encrypted() { return Err("El PDF está protegido con contraseña.".into()); }
    Ok(d)
}
fn guardar(doc: &mut Document, salida: &str) -> Result<(), String> {
    doc.max_id = doc.objects.keys().map(|k| k.0).max().unwrap_or(0);
    doc.save(salida).map(|_| ()).map_err(|e| format!("Error al guardar el PDF: {}", e))
}

/// Transformación (u,v) fracción visible desde arriba-izquierda → espacio de usuario.
struct Pagina { x0: f64, y0: f64, w: f64, h: f64, rot: i64, dw: f64, dh: f64 }
impl Pagina {
    fn de(doc: &Document, id: ObjectId) -> Pagina {
        let [x0, y0, x1, y1] = caja(doc, id);
        let (w, h) = (x1 - x0, y1 - y0);
        let rot = rotacion(doc, id);
        let (dw, dh) = if rot == 90 || rot == 270 { (h, w) } else { (w, h) };
        Pagina { x0, y0, w, h, rot, dw, dh }
    }
    fn mapa(&self, u: f64, v: f64) -> (f64, f64) {
        let (a, b) = match self.rot { 90 => (v, u), 180 => (1.0 - u, v), 270 => (1.0 - v, 1.0 - u), _ => (u, 1.0 - v) };
        (self.x0 + a * self.w, self.y0 + b * self.h)
    }
}

// ───────────────────── marca de agua y numeración ─────────────────────

#[derive(Deserialize, Clone, Debug)]
pub struct Marca { pub texto: String, pub tam: f64, pub opacidad: f64, pub color: [f64; 3], pub angulo: f64 }
#[derive(Deserialize, Clone, Debug)]
pub struct Numeracion { pub formato: String, pub posicion: String, pub tam: f64, pub inicio: u32, pub color: [f64; 3] }
#[derive(Deserialize, Clone, Debug, Default)]
pub struct Decorado { pub marca: Option<Marca>, pub numeracion: Option<Numeracion>, #[serde(default)] pub paginas: String }

pub fn decorar(entrada: &str, salida: &str, d: &Decorado) -> Result<(), String> {
    if d.marca.is_none() && d.numeracion.is_none() { return Err("No hay nada que añadir: activa la marca de agua o la numeración.".into()); }
    let mut doc = abrir(entrada)?;
    let paginas = doc.get_pages();
    let total = paginas.len() as u32;
    let sel = paginas_de(&d.paginas, total)?;
    let fuente = fuente_helvetica(&mut doc);
    for n in sel {
        let page_id = paginas[&n];
        let pg = Pagina::de(&doc, page_id);
        let ang_pag = (pg.rot as f64).to_radians();
        let mut c = String::new();
        let mut extras: Vec<(&'static str, String, Object)> = vec![("Font", "FDeco".into(), Object::Reference(fuente))];
        if let Some(m) = &d.marca {
            let texto = m.texto.trim();
            if !texto.is_empty() {
                let tam = m.tam.clamp(6.0, 400.0);
                let a = ang_pag + m.angulo.to_radians();
                let (cs, sn) = (a.cos(), a.sin());
                let w = ancho_texto(texto, tam);
                let (cx, cy) = pg.mapa(0.5, 0.5);
                // el texto parte de C − dir·w/2 − perp·(0,3·tam) para quedar centrado
                let px = cx - cs * w / 2.0 + sn * 0.3 * tam;
                let py = cy - sn * w / 2.0 - cs * 0.3 * tam;
                let [r, g, b] = m.color;
                c.push_str(&format!("q /GSDeco gs {} {} {} rg BT /FDeco {} Tf {} {} {} {} {} {} Tm {} Tj ET Q\n",
                    f(r), f(g), f(b), f(tam), f(cs), f(sn), f(-sn), f(cs), f(px), f(py), winansi_hex(texto)));
                let mut gs = Dictionary::new();
                gs.set("Type", Object::Name(b"ExtGState".to_vec()));
                gs.set("ca", Object::Real(m.opacidad.clamp(0.02, 1.0) as f32));
                gs.set("CA", Object::Real(m.opacidad.clamp(0.02, 1.0) as f32));
                extras.push(("ExtGState", "GSDeco".into(), Object::Dictionary(gs)));
            }
        }
        if let Some(nm) = &d.numeracion {
            let tam = nm.tam.clamp(5.0, 48.0);
            let texto = nm.formato.replace("{n}", &(n - 1 + nm.inicio.max(1)).to_string()).replace("{total}", &total.to_string());
            let w = ancho_texto(&texto, tam);
            let margen = 28.0_f64.max(tam);
            let x = if nm.posicion.ends_with("izquierda") { margen } else if nm.posicion.ends_with("derecha") { pg.dw - margen - w } else { (pg.dw - w) / 2.0 };
            let y = if nm.posicion.starts_with("cab") { margen * 0.7 + tam * 0.8 } else { pg.dh - margen * 0.7 };
            let (px, py) = pg.mapa(x / pg.dw, y / pg.dh);
            let (cs, sn) = (ang_pag.cos(), ang_pag.sin());
            let [r, g, b] = nm.color;
            c.push_str(&format!("q {} {} {} rg BT /FDeco {} Tf {} {} {} {} {} {} Tm {} Tj ET Q\n",
                f(r), f(g), f(b), f(tam), f(cs), f(sn), f(-sn), f(cs), f(px), f(py), winansi_hex(&texto)));
        }
        agregar_a_pagina(&mut doc, page_id, c, extras)?;
    }
    guardar(&mut doc, salida)
}

// ───────────────────────── tachado real (redacción) ─────────────────────────

#[derive(Deserialize, Clone, Debug)]
pub struct Zona { pub pagina: u32, pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

/// Cada página con zonas se RASTERIZA (con las zonas en negro) y sustituye a la original:
/// el texto y las imágenes tachados dejan de existir en el archivo. Las demás páginas no cambian.
/// `render(entrada, pagina, dpi)` devuelve un PNG de la página tal como se ve.
pub fn redactar(entrada: &str, salida: &str, zonas: &[Zona], dpi: u32, render: &dyn Fn(&str, u32, u32) -> Result<Vec<u8>, String>) -> Result<(), String> {
    if zonas.is_empty() { return Err("No hay zonas que tachar.".into()); }
    let mut doc = abrir(entrada)?;
    let paginas = doc.get_pages();
    let mut por: BTreeMap<u32, Vec<&Zona>> = BTreeMap::new();
    for z in zonas { por.entry(z.pagina).or_default().push(z); }
    for (n, lista) in por {
        let page_id = *paginas.get(&n).ok_or_else(|| format!("La página {} no existe", n))?;
        let png = render(entrada, n, dpi.clamp(100, 400))?;
        let mut img = image::load_from_memory(&png).map_err(|e| format!("No se pudo leer la imagen de la página {}: {}", n, e))?.to_rgb8();
        let (iw, ih) = (img.width() as f64, img.height() as f64);
        for z in lista {
            // un pequeño margen para no dejar bordes de letras sin cubrir
            let (x0, y0) = (((z.x * iw).floor() - 1.0).max(0.0) as u32, ((z.y * ih).floor() - 1.0).max(0.0) as u32);
            let (x1, y1) = ((((z.x + z.w) * iw).ceil() + 1.0).min(iw) as u32, (((z.y + z.h) * ih).ceil() + 1.0).min(ih) as u32);
            for yy in y0..y1 { for xx in x0..x1 { img.put_pixel(xx, yy, image::Rgb([0, 0, 0])); } }
        }
        let mut jpg: Vec<u8> = vec![];
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 88).encode_image(&img).map_err(|e| e.to_string())?;
        let mut d = Dictionary::new();
        d.set("Type", Object::Name(b"XObject".to_vec()));
        d.set("Subtype", Object::Name(b"Image".to_vec()));
        d.set("Width", Object::Integer(img.width() as i64));
        d.set("Height", Object::Integer(img.height() as i64));
        d.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
        d.set("BitsPerComponent", Object::Integer(8));
        d.set("Filter", Object::Name(b"DCTDecode".to_vec()));
        let img_id = doc.add_object(Object::Stream(Stream::new(d, jpg)));
        // tamaño de la página nueva = el de la imagen (72 puntos por pulgada)
        let (dw, dh) = (img.width() as f64 * 72.0 / dpi.clamp(100, 400) as f64, img.height() as f64 * 72.0 / dpi.clamp(100, 400) as f64);
        let cont = doc.add_object(Stream::new(Dictionary::new(), format!("q {} 0 0 {} 0 0 cm /ImRed Do Q\n", f(dw), f(dh)).into_bytes()));
        let mut xo = Dictionary::new(); xo.set("ImRed", Object::Reference(img_id));
        let mut rec = Dictionary::new(); rec.set("XObject", Object::Dictionary(xo));
        let p = doc.get_object_mut(page_id).map_err(|e| e.to_string())?.as_dict_mut().map_err(|e| e.to_string())?;
        p.set("Contents", Object::Reference(cont));
        p.set("Resources", Object::Dictionary(rec));
        p.set("MediaBox", Object::Array(vec![Object::Integer(0), Object::Integer(0), Object::Real(dw as f32), Object::Real(dh as f32)]));
        for k in ["CropBox", "Annots", "Thumb", "Metadata", "PieceInfo", "AA", "StructParents", "B", "TrimBox", "BleedBox", "ArtBox"] { p.remove(k.as_bytes()); }
        p.set("Rotate", Object::Integer(0));
    }
    // fuera restos que pudieran contener el texto tachado
    let raiz = doc.trailer.get(b"Root").ok().and_then(|o| o.as_reference().ok());
    if let Some(r) = raiz { if let Ok(Object::Dictionary(c)) = doc.get_object_mut(r) { c.remove(b"StructTreeRoot"); c.remove(b"MarkInfo"); c.remove(b"Metadata"); } }
    doc.prune_objects();
    guardar(&mut doc, salida)
}

// ───────────────────────── metadatos ─────────────────────────

#[derive(Serialize, Default, Debug)]
pub struct Meta {
    pub titulo: String, pub autor: String, pub asunto: String, pub claves: String,
    pub creador: String, pub productor: String, pub creado: String, pub modificado: String,
    pub xmp: bool, pub marcadores: bool, pub adjuntos: u32, pub javascript: bool, pub comentarios: u32,
    pub cifrado: bool, pub paginas: u32,
}

const CLAVES_INFO: [(&str, &str); 6] = [("titulo", "Title"), ("autor", "Author"), ("asunto", "Subject"), ("claves", "Keywords"), ("creador", "Creator"), ("productor", "Producer")];
const TIPOS_COMENTARIO: [&str; 18] = ["Text", "FreeText", "Highlight", "Underline", "StrikeOut", "Squiggly", "Stamp", "Ink", "Popup", "Line", "Square", "Circle", "Polygon", "PolyLine", "Caret", "FileAttachment", "Sound", "Redact"];

fn raiz_id(doc: &Document) -> Option<ObjectId> { doc.trailer.get(b"Root").ok()?.as_reference().ok() }
fn info_id(doc: &Document) -> Option<ObjectId> { doc.trailer.get(b"Info").ok()?.as_reference().ok() }

fn fecha_legible(s: &str) -> String {
    let d: String = s.trim_start_matches("D:").chars().take_while(|c| c.is_ascii_digit()).collect();
    if d.len() >= 8 { format!("{}-{}-{}{}", &d[0..4], &d[4..6], &d[6..8], if d.len() >= 12 { format!(" {}:{}", &d[8..10], &d[10..12]) } else { String::new() }) } else { s.to_string() }
}

pub fn leer_meta(ruta: &str) -> Result<Meta, String> {
    let doc = Document::load(ruta).map_err(|e| format!("Error al abrir el PDF: {}", e))?;
    let mut m = Meta { cifrado: doc.is_encrypted(), paginas: doc.get_pages().len() as u32, ..Default::default() };
    if let Some(id) = info_id(&doc) {
        if let Ok(Object::Dictionary(d)) = doc.get_object(id) {
            let g = |k: &str| d.get(k.as_bytes()).ok().and_then(|o| if let Object::String(b, _) = resolver(&doc, o) { Some(texto_pdf(b)) } else { None }).unwrap_or_default();
            m.titulo = g("Title"); m.autor = g("Author"); m.asunto = g("Subject"); m.claves = g("Keywords");
            m.creador = g("Creator"); m.productor = g("Producer");
            m.creado = fecha_legible(&g("CreationDate")); m.modificado = fecha_legible(&g("ModDate"));
        }
    }
    if let Some(r) = raiz_id(&doc) {
        if let Ok(Object::Dictionary(c)) = doc.get_object(r) {
            m.xmp = c.has(b"Metadata");
            m.marcadores = c.has(b"Outlines");
            if let Ok(n) = c.get(b"Names") {
                if let Some(nd) = dic(&doc, n) {
                    if let Ok(e) = nd.get(b"EmbeddedFiles") {
                        if let Some(ed) = dic(&doc, e) {
                            if let Ok(Object::Array(a)) = ed.get(b"Names").map(|o| resolver(&doc, o)) { m.adjuntos = (a.len() / 2) as u32; }
                            else if ed.has(b"Kids") { m.adjuntos = 1; }
                        }
                    }
                    if nd.has(b"JavaScript") { m.javascript = true; }
                }
            }
            if c.has(b"OpenAction") || c.has(b"AA") { m.javascript = m.javascript || c.get(b"OpenAction").ok().and_then(|o| dic(&doc, o)).map(|d| d.has(b"JS") || d.get(b"S").ok().and_then(nombre_de).as_deref() == Some("JavaScript")).unwrap_or(false); }
        }
    }
    for (_, pid) in doc.get_pages() {
        if let Ok(p) = doc.get_object(pid).and_then(|o| o.as_dict()) {
            if let Ok(an) = p.get(b"Annots").map(|o| resolver(&doc, o)) {
                if let Object::Array(a) = an {
                    for x in a { if let Some(d) = dic(&doc, x) { if let Some(st) = d.get(b"Subtype").ok().and_then(nombre_de) { if TIPOS_COMENTARIO.contains(&st.as_str()) { m.comentarios += 1; } } } }
                }
            }
        }
    }
    Ok(m)
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct LimpiarMeta {
    /// Campos de Info a fijar (clave: titulo, autor, asunto, claves, creador, productor). Vacío = borrar.
    #[serde(default)] pub campos: HashMap<String, String>,
    #[serde(default)] pub borrar_info: bool,
    #[serde(default)] pub quitar_xmp: bool,
    #[serde(default)] pub quitar_marcadores: bool,
    #[serde(default)] pub quitar_adjuntos: bool,
    #[serde(default)] pub quitar_javascript: bool,
    #[serde(default)] pub quitar_comentarios: bool,
}

pub fn limpiar_meta(entrada: &str, salida: &str, o: &LimpiarMeta) -> Result<(), String> {
    let mut doc = abrir(entrada)?;
    // Info
    if o.borrar_info || !o.campos.is_empty() {
        let id = match info_id(&doc) {
            Some(i) => i,
            None => { let i = doc.add_object(Object::Dictionary(Dictionary::new())); doc.trailer.set("Info", Object::Reference(i)); i }
        };
        if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
            if o.borrar_info {
                let claves: Vec<Vec<u8>> = d.iter().map(|(k, _)| k.clone()).collect();
                for k in claves { d.remove(&k); }
            }
            for (k, v) in &o.campos {
                if let Some((_, pdf)) = CLAVES_INFO.iter().find(|(a, _)| a == k) {
                    if v.trim().is_empty() { d.remove(pdf.as_bytes()); } else { d.set(pdf.as_bytes().to_vec(), a_texto_pdf(v.trim())); }
                }
            }
        }
    }
    if let Some(r) = raiz_id(&doc) {
        let nombres: Option<Object> = if let Ok(Object::Dictionary(c)) = doc.get_object(r) { c.get(b"Names").ok().cloned() } else { None };
        // /Names puede ser referencia: la editamos en su sitio
        let nombres_id = nombres.as_ref().and_then(|n| n.as_reference().ok());
        if let Ok(Object::Dictionary(c)) = doc.get_object_mut(r) {
            if o.quitar_xmp { c.remove(b"Metadata"); }
            if o.quitar_marcadores { c.remove(b"Outlines"); if matches!(c.get(b"PageMode"), Ok(Object::Name(n)) if n == b"UseOutlines") { c.set("PageMode", Object::Name(b"UseNone".to_vec())); } }
            if o.quitar_adjuntos { c.remove(b"AF"); }
            if o.quitar_javascript { c.remove(b"OpenAction"); c.remove(b"AA"); }
            if let Some(Object::Dictionary(nd)) = c.get_mut(b"Names").ok().map(|o| o as &mut Object) {
                if o.quitar_adjuntos { nd.remove(b"EmbeddedFiles"); }
                if o.quitar_javascript { nd.remove(b"JavaScript"); }
            }
        }
        if let Some(nid) = nombres_id {
            if let Ok(Object::Dictionary(nd)) = doc.get_object_mut(nid) {
                if o.quitar_adjuntos { nd.remove(b"EmbeddedFiles"); }
                if o.quitar_javascript { nd.remove(b"JavaScript"); }
            }
        }
    }
    if o.quitar_comentarios {
        let paginas: Vec<ObjectId> = doc.get_pages().values().cloned().collect();
        for pid in paginas {
            let anots: Vec<Object> = match doc.get_object(pid).ok().and_then(|p| p.as_dict().ok()).and_then(|p| p.get(b"Annots").ok()).map(|a| resolver(&doc, a).clone()) {
                Some(Object::Array(a)) => a, _ => continue,
            };
            let nuevas: Vec<Object> = anots.into_iter().filter(|x| {
                let st = dic(&doc, x).and_then(|d| d.get(b"Subtype").ok().and_then(nombre_de)).unwrap_or_default();
                !TIPOS_COMENTARIO.contains(&st.as_str())
            }).collect();
            if let Ok(Object::Dictionary(p)) = doc.get_object_mut(pid) { p.set("Annots", Object::Array(nuevas)); }
        }
    }
    doc.prune_objects();
    guardar(&mut doc, salida)
}

// ───────────────────────── formularios (AcroForm) ─────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct Campo {
    pub nombre: String, pub tipo: String, pub valor: String, pub opciones: Vec<String>,
    pub pagina: u32, pub solo_lectura: bool, pub multilinea: bool,
}

struct Terminal { nombre: String, ft: String, ff: i64, widgets: Vec<ObjectId>, id: ObjectId }

fn campo_heredado(doc: &Document, id: ObjectId, clave: &[u8]) -> Option<Object> {
    let mut cur = id;
    for _ in 0..32 {
        let d = doc.get_object(cur).ok()?.as_dict().ok()?;
        if let Ok(v) = d.get(clave) { return Some(resolver(doc, v).clone()); }
        cur = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn recorrer(doc: &Document, id: ObjectId, prefijo: &str, fuera: &mut Vec<Terminal>, prof: u32) {
    if prof > 24 { return; }
    let Ok(Object::Dictionary(d)) = doc.get_object(id) else { return };
    let t = d.get(b"T").ok().and_then(|o| if let Object::String(b, _) = resolver(doc, o) { Some(texto_pdf(b)) } else { None });
    let nombre = match (&t, prefijo.is_empty()) { (Some(t), true) => t.clone(), (Some(t), false) => format!("{}.{}", prefijo, t), (None, _) => prefijo.to_string() };
    let hijos: Vec<ObjectId> = match d.get(b"Kids").ok().map(|o| resolver(doc, o)) {
        Some(Object::Array(a)) => a.iter().filter_map(|o| o.as_reference().ok()).collect(), _ => vec![],
    };
    let hay_campos_hijos = hijos.iter().any(|h| matches!(doc.get_object(*h), Ok(Object::Dictionary(k)) if k.has(b"T") || k.has(b"Kids")));
    if hay_campos_hijos {
        for h in hijos { recorrer(doc, h, &nombre, fuera, prof + 1); }
    } else {
        let ft = campo_heredado(doc, id, b"FT").and_then(|o| nombre_de(&o)).unwrap_or_default();
        if ft.is_empty() { return; }
        let ff = campo_heredado(doc, id, b"Ff").and_then(|o| num(&o)).unwrap_or(0.0) as i64;
        let widgets = if hijos.is_empty() { vec![id] } else { hijos };
        fuera.push(Terminal { nombre, ft, ff, widgets, id });
    }
}

fn terminales(doc: &Document) -> Vec<Terminal> {
    let mut v = vec![];
    let Some(r) = raiz_id(doc) else { return v };
    let Ok(Object::Dictionary(c)) = doc.get_object(r) else { return v };
    let Some(af) = c.get(b"AcroForm").ok().and_then(|o| dic(doc, o)) else { return v };
    if let Ok(Object::Array(a)) = af.get(b"Fields").map(|o| resolver(doc, o)) {
        for o in a { if let Ok(id) = o.as_reference() { recorrer(doc, id, "", &mut v, 0); } }
    }
    v
}

fn tipo_campo(t: &Terminal) -> &'static str {
    match t.ft.as_str() {
        "Tx" => "texto",
        "Ch" => if t.ff & 131072 != 0 { "desplegable" } else { "lista" },
        "Btn" => if t.ff & 65536 != 0 { "boton" } else if t.ff & 32768 != 0 { "radio" } else { "casilla" },
        "Sig" => "firma",
        _ => "otro",
    }
}

fn estados_widget(doc: &Document, w: ObjectId) -> Vec<String> {
    let Ok(Object::Dictionary(d)) = doc.get_object(w) else { return vec![] };
    let Some(ap) = d.get(b"AP").ok().and_then(|o| dic(doc, o)) else { return vec![] };
    let Some(n) = ap.get(b"N").ok().and_then(|o| dic(doc, o)) else { return vec![] };
    n.iter().map(|(k, _)| String::from_utf8_lossy(k).into_owned()).filter(|k| k != "Off").collect()
}

fn pagina_de_widget(doc: &Document, w: ObjectId, mapa: &BTreeMap<u32, ObjectId>) -> u32 {
    for (n, pid) in mapa {
        if let Ok(Object::Dictionary(p)) = doc.get_object(*pid) {
            if let Ok(Object::Array(a)) = p.get(b"Annots").map(|o| resolver(doc, o)) {
                if a.iter().any(|o| o.as_reference().ok() == Some(w)) { return *n; }
            }
        }
    }
    0
}

pub fn leer_campos(ruta: &str) -> Result<Vec<Campo>, String> {
    let doc = Document::load(ruta).map_err(|e| format!("Error al abrir el PDF: {}", e))?;
    let paginas = doc.get_pages();
    let mut v = vec![];
    for t in terminales(&doc) {
        let tipo = tipo_campo(&t);
        if tipo == "boton" || tipo == "firma" || tipo == "otro" { continue; }
        let vo = campo_heredado(&doc, t.id, b"V");
        let mut valor = match &vo { Some(Object::String(b, _)) => texto_pdf(b), Some(Object::Name(n)) => String::from_utf8_lossy(n).into_owned(), _ => String::new() };
        let mut opciones: Vec<String> = vec![];
        match tipo {
            "casilla" => { valor = if valor.is_empty() || valor == "Off" { "false".into() } else { "true".into() }; }
            "radio" => { for w in &t.widgets { for e in estados_widget(&doc, *w) { if !opciones.contains(&e) { opciones.push(e); } } } if valor == "Off" { valor.clear(); } }
            "lista" | "desplegable" => {
                if let Some(Object::Array(a)) = campo_heredado(&doc, t.id, b"Opt") {
                    for o in a { match resolver(&doc, &o) {
                        Object::String(b, _) => opciones.push(texto_pdf(b)),
                        Object::Array(p) => if let Some(Object::String(b, _)) = p.get(1).map(|x| resolver(&doc, x)) { opciones.push(texto_pdf(b)); },
                        _ => {}
                    } }
                }
            }
            _ => {}
        }
        let pagina = t.widgets.first().map(|w| pagina_de_widget(&doc, *w, &paginas)).unwrap_or(0);
        v.push(Campo { nombre: t.nombre.clone(), tipo: tipo.into(), valor, opciones, pagina, solo_lectura: t.ff & 1 != 0, multilinea: tipo == "texto" && t.ff & 4096 != 0 });
    }
    Ok(v)
}

fn color_op(doc: &Document, da: &str) -> (f64, String) {
    let _ = doc;
    let t: Vec<&str> = da.split_whitespace().collect();
    let mut tam = 0.0; let mut col = "0 g".to_string();
    for (i, x) in t.iter().enumerate() {
        match *x {
            "Tf" if i >= 1 => tam = t[i - 1].parse().unwrap_or(0.0),
            "g" if i >= 1 => col = format!("{} g", t[i - 1]),
            "rg" if i >= 3 => col = format!("{} {} {} rg", t[i - 3], t[i - 2], t[i - 1]),
            "k" if i >= 4 => col = format!("{} {} {} {} k", t[i - 4], t[i - 3], t[i - 2], t[i - 1]),
            _ => {}
        }
    }
    (tam, col)
}

fn rect_de(doc: &Document, d: &Dictionary) -> Option<[f64; 4]> {
    let Object::Array(a) = resolver(doc, d.get(b"Rect").ok()?) else { return None };
    let v: Vec<f64> = a.iter().filter_map(|o| num(resolver(doc, o))).collect();
    if v.len() == 4 { Some([v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])]) } else { None }
}

fn color_mk(doc: &Document, mk: Option<&Dictionary>, clave: &[u8], trazo: bool) -> Option<String> {
    let Object::Array(a) = resolver(doc, mk?.get(clave).ok()?) else { return None };
    let v: Vec<f64> = a.iter().filter_map(|o| num(resolver(doc, o))).collect();
    Some(match (v.len(), trazo) {
        (1, false) => format!("{} g", f(v[0])), (1, true) => format!("{} G", f(v[0])),
        (3, false) => format!("{} {} {} rg", f(v[0]), f(v[1]), f(v[2])), (3, true) => format!("{} {} {} RG", f(v[0]), f(v[1]), f(v[2])),
        (4, false) => format!("{} {} {} {} k", f(v[0]), f(v[1]), f(v[2]), f(v[3])), (4, true) => format!("{} {} {} {} K", f(v[0]), f(v[1]), f(v[2]), f(v[3])),
        _ => return None,
    })
}

fn ajustar_lineas(texto: &str, tam: f64, ancho: f64, multi: bool) -> Vec<String> {
    if !multi { return vec![texto.replace(['\r', '\n'], " ")]; }
    let mut v = vec![];
    for parrafo in texto.replace("\r\n", "\n").split('\n') {
        let mut actual = String::new();
        for pal in parrafo.split(' ') {
            let prueba = if actual.is_empty() { pal.to_string() } else { format!("{} {}", actual, pal) };
            if ancho_texto(&prueba, tam) > ancho && !actual.is_empty() { v.push(std::mem::take(&mut actual)); actual = pal.to_string(); } else { actual = prueba; }
        }
        v.push(actual);
    }
    v
}

/// Crea (o reemplaza) la apariencia /AP /N de un widget de texto o lista con el valor dado.
fn apariencia_texto(doc: &mut Document, w: ObjectId, valor: &str, fuente: ObjectId, multi: bool, da_campo: &str, q_campo: i64) -> Result<(), String> {
    let (rect, mk, bw, da, q) = {
        let Ok(Object::Dictionary(d)) = doc.get_object(w) else { return Ok(()) };
        let rect = match rect_de(doc, d) { Some(r) => r, None => return Ok(()) };
        let mk = d.get(b"MK").ok().and_then(|o| dic(doc, o)).cloned();
        let bw = d.get(b"BS").ok().and_then(|o| dic(doc, o)).and_then(|b| b.get(b"W").ok().and_then(num)).unwrap_or(1.0);
        let da = d.get(b"DA").ok().and_then(|o| if let Object::String(b, _) = resolver(doc, o) { Some(texto_pdf(b)) } else { None }).unwrap_or_else(|| da_campo.to_string());
        let q = d.get(b"Q").ok().and_then(num).map(|x| x as i64).unwrap_or(q_campo);
        (rect, mk, bw, da, q)
    };
    let (ancho, alto) = (rect[2] - rect[0], rect[3] - rect[1]);
    let (mut tam, col) = color_op(doc, &da);
    if tam <= 0.0 { tam = if multi { 11.0 } else { (alto * 0.62).clamp(6.0, 14.0) }; }
    let mut c = String::new();
    if let Some(bg) = color_mk(doc, mk.as_ref(), b"BG", false) { c.push_str(&format!("q {}\n0 0 {} {} re f Q\n", bg, f(ancho), f(alto))); }
    if let Some(bc) = color_mk(doc, mk.as_ref(), b"BC", true) { c.push_str(&format!("q {} {} w {} {} {} {} re S Q\n", bc, f(bw), f(bw / 2.0), f(bw / 2.0), f(ancho - bw), f(alto - bw))); }
    let pad = 2.0 + bw;
    let lineas = ajustar_lineas(valor, tam, ancho - 2.0 * pad, multi);
    c.push_str(&format!("/Tx BMC q {} {} {} {} re W n BT /Helv {} Tf {}\n", f(pad / 2.0), f(pad / 2.0), f(ancho - pad), f(alto - pad), f(tam), col));
    for (i, l) in lineas.iter().enumerate() {
        let y = if multi { alto - pad - tam * (0.85 + 1.15 * i as f64) } else { (alto - tam) / 2.0 + tam * 0.22 };
        let wl = ancho_texto(l, tam);
        let x = match q { 1 => (ancho - wl) / 2.0, 2 => ancho - pad - wl, _ => pad };
        c.push_str(&format!("1 0 0 1 {} {} Tm {} Tj\n", f(x), f(y), winansi_hex(l)));
    }
    c.push_str("ET Q EMC\n");
    let mut fd = Dictionary::new(); fd.set("Helv", Object::Reference(fuente));
    let mut rec = Dictionary::new(); rec.set("Font", Object::Dictionary(fd));
    let mut sd = Dictionary::new();
    sd.set("Type", Object::Name(b"XObject".to_vec()));
    sd.set("Subtype", Object::Name(b"Form".to_vec()));
    sd.set("BBox", Object::Array(vec![Object::Integer(0), Object::Integer(0), Object::Real(ancho as f32), Object::Real(alto as f32)]));
    sd.set("Resources", Object::Dictionary(rec));
    let ap_id = doc.add_object(Object::Stream(Stream::new(sd, c.into_bytes())));
    let mut n = Dictionary::new(); n.set("N", Object::Reference(ap_id));
    if let Ok(Object::Dictionary(d)) = doc.get_object_mut(w) { d.set("AP", Object::Dictionary(n)); d.remove(b"AS"); }
    Ok(())
}

fn poner_valor(doc: &mut Document, id: ObjectId, v: Object) {
    if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) { d.set("V", v); }
}

pub fn rellenar(entrada: &str, salida: &str, valores: &HashMap<String, String>, aplanar: bool) -> Result<(), String> {
    let mut doc = abrir(entrada)?;
    let campos = terminales(&doc);
    if campos.is_empty() { return Err("El PDF no tiene campos de formulario.".into()); }
    let fuente = fuente_helvetica(&mut doc);
    let (da_form, q_form) = {
        let r = raiz_id(&doc).ok_or("PDF sin catálogo")?;
        let af = match doc.get_object(r) { Ok(Object::Dictionary(c)) => c.get(b"AcroForm").ok().and_then(|o| dic(&doc, o)).cloned(), _ => None };
        (af.as_ref().and_then(|a| a.get(b"DA").ok().and_then(|o| if let Object::String(b, _) = resolver(&doc, o) { Some(texto_pdf(b)) } else { None })).unwrap_or_else(|| "/Helv 0 Tf 0 g".into()),
         af.as_ref().and_then(|a| a.get(b"Q").ok().and_then(num)).map(|x| x as i64).unwrap_or(0))
    };
    for t in &campos {
        let Some(valor) = valores.get(&t.nombre) else { continue };
        if t.ff & 1 != 0 { continue; } // solo lectura
        match tipo_campo(t) {
            "texto" | "lista" | "desplegable" => {
                poner_valor(&mut doc, t.id, a_texto_pdf(valor));
                if let Ok(Object::Dictionary(d)) = doc.get_object_mut(t.id) { d.remove(b"I"); } // índice seleccionado antiguo
                let da = campo_heredado(&doc, t.id, b"DA").and_then(|o| if let Object::String(b, _) = o { Some(texto_pdf(&b)) } else { None }).unwrap_or_else(|| da_form.clone());
                let q = campo_heredado(&doc, t.id, b"Q").and_then(|o| num(&o)).map(|x| x as i64).unwrap_or(q_form);
                for w in &t.widgets { apariencia_texto(&mut doc, *w, valor, fuente, t.ff & 4096 != 0 && tipo_campo(t) == "texto", &da, q)?; }
            }
            "casilla" => {
                let marcada = matches!(valor.to_lowercase().as_str(), "true" | "1" | "si" | "sí" | "on" | "yes" | "x");
                for w in &t.widgets {
                    let on = estados_widget(&doc, *w).into_iter().next().unwrap_or_else(|| "Yes".into());
                    let est = if marcada { on } else { "Off".into() };
                    if let Ok(Object::Dictionary(d)) = doc.get_object_mut(*w) { d.set("AS", Object::Name(est.clone().into_bytes())); if *w == t.id { d.set("V", Object::Name(est.into_bytes())); } }
                    if *w != t.id { let e = if marcada { estados_widget(&doc, *w).into_iter().next().unwrap_or_else(|| "Yes".into()) } else { "Off".into() }; poner_valor(&mut doc, t.id, Object::Name(e.into_bytes())); }
                }
            }
            "radio" => {
                for w in &t.widgets {
                    let on = estados_widget(&doc, *w).into_iter().next().unwrap_or_default();
                    let est = if !on.is_empty() && &on == valor { on } else { "Off".into() };
                    if let Ok(Object::Dictionary(d)) = doc.get_object_mut(*w) { d.set("AS", Object::Name(est.into_bytes())); }
                }
                poner_valor(&mut doc, t.id, if valor.is_empty() { Object::Name(b"Off".to_vec()) } else { Object::Name(valor.clone().into_bytes()) });
            }
            _ => {}
        }
    }
    if aplanar { aplanar_campos(&mut doc, &campos)?; }
    else if let Some(r) = raiz_id(&doc) {
        let af_id = match doc.get_object(r) { Ok(Object::Dictionary(c)) => c.get(b"AcroForm").ok().cloned(), _ => None };
        match af_id {
            Some(Object::Reference(i)) => { if let Ok(Object::Dictionary(a)) = doc.get_object_mut(i) { a.set("NeedAppearances", Object::Boolean(true)); } }
            Some(Object::Dictionary(_)) => { if let Ok(Object::Dictionary(c)) = doc.get_object_mut(r) { if let Ok(Object::Dictionary(a)) = c.get_mut(b"AcroForm") { a.set("NeedAppearances", Object::Boolean(true)); } } }
            _ => {}
        }
    }
    guardar(&mut doc, salida)
}

/// Dibuja las apariencias de los widgets en el contenido de la página y elimina los campos (salvo firmas).
fn aplanar_campos(doc: &mut Document, campos: &[Terminal]) -> Result<(), String> {
    let paginas = doc.get_pages();
    // fuentes por defecto del formulario (/DR): las apariencias las heredan al estar dentro del campo, no al dibujarlas en la página
    let dr_fuentes: Dictionary = raiz_id(doc).and_then(|r| match doc.get_object(r) { Ok(Object::Dictionary(c)) => c.get(b"AcroForm").ok().and_then(|o| dic(doc, o)).cloned(), _ => None })
        .and_then(|af| af.get(b"DR").ok().and_then(|o| dic(doc, o)).cloned())
        .and_then(|dr| dr.get(b"Font").ok().and_then(|o| dic(doc, o)).cloned())
        .unwrap_or_default();
    let mut por_pagina: BTreeMap<u32, Vec<ObjectId>> = BTreeMap::new();
    let mut quitar: Vec<ObjectId> = vec![];
    for t in campos {
        if t.ft == "Sig" { continue; }
        for w in &t.widgets { por_pagina.entry(pagina_de_widget(doc, *w, &paginas)).or_default().push(*w); quitar.push(*w); }
    }
    for (n, widgets) in por_pagina {
        let Some(&page_id) = paginas.get(&n) else { continue };
        let mut c = String::new();
        let mut extras: Vec<(&'static str, String, Object)> = vec![];
        for (i, w) in widgets.iter().enumerate() {
            let Ok(Object::Dictionary(d)) = doc.get_object(*w) else { continue };
            let flags = d.get(b"F").ok().and_then(num).unwrap_or(0.0) as i64;
            if flags & 2 != 0 || flags & 32 != 0 { continue; } // oculto
            let Some(rect) = rect_de(doc, d) else { continue };
            let as_ = d.get(b"AS").ok().and_then(nombre_de);
            let Some(n_obj) = d.get(b"AP").ok().and_then(|o| dic(doc, o)).and_then(|ap| ap.get(b"N").ok()) else { continue };
            let ap_ref: ObjectId = match n_obj {
                Object::Reference(r) => match doc.get_object(*r) {
                    Ok(Object::Stream(_)) => *r,
                    Ok(Object::Dictionary(sub)) => match as_.as_ref().and_then(|k| sub.get(k.as_bytes()).ok()).and_then(|o| o.as_reference().ok()) { Some(r2) => r2, None => continue },
                    _ => continue,
                },
                Object::Dictionary(sub) => match as_.as_ref().and_then(|k| sub.get(k.as_bytes()).ok()).and_then(|o| o.as_reference().ok()) { Some(r2) => r2, None => continue },
                _ => continue,
            };
            let Ok(Object::Stream(s)) = doc.get_object(ap_ref) else { continue };
            let bbox: Vec<f64> = match s.dict.get(b"BBox").ok().map(|o| resolver(doc, o)) { Some(Object::Array(a)) => a.iter().filter_map(|o| num(resolver(doc, o))).collect(), _ => continue };
            if bbox.len() != 4 { continue; }
            let m: Vec<f64> = match s.dict.get(b"Matrix").ok().map(|o| resolver(doc, o)) { Some(Object::Array(a)) => a.iter().filter_map(|o| num(resolver(doc, o))).collect(), _ => vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0] };
            let m = if m.len() == 6 { m } else { vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0] };
            // caja transformada por /Matrix
            let esq = [(bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[0], bbox[3]), (bbox[2], bbox[3])];
            let tr: Vec<(f64, f64)> = esq.iter().map(|(x, y)| (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])).collect();
            let (tx0, ty0) = (tr.iter().map(|p| p.0).fold(f64::MAX, f64::min), tr.iter().map(|p| p.1).fold(f64::MAX, f64::min));
            let (tx1, ty1) = (tr.iter().map(|p| p.0).fold(f64::MIN, f64::max), tr.iter().map(|p| p.1).fold(f64::MIN, f64::max));
            let (tw, th) = ((tx1 - tx0).max(1e-6), (ty1 - ty0).max(1e-6));
            let (sx, sy) = ((rect[2] - rect[0]) / tw, (rect[3] - rect[1]) / th);
            let nombre = format!("FlatF{}", i);
            if !dr_fuentes.is_empty() {
                let mut rec = match doc.get_object(ap_ref) { Ok(Object::Stream(s)) => s.dict.get(b"Resources").ok().and_then(|o| dic(doc, o)).cloned().unwrap_or_default(), _ => Dictionary::new() };
                let mut fuentes = rec.get(b"Font").ok().and_then(|o| dic(doc, o)).cloned().unwrap_or_default();
                for (k, v) in dr_fuentes.iter() { if !fuentes.has(k) { fuentes.set(k.clone(), v.clone()); } }
                rec.set("Font", Object::Dictionary(fuentes));
                if let Ok(Object::Stream(s)) = doc.get_object_mut(ap_ref) { s.dict.set("Resources", Object::Dictionary(rec)); }
            }
            c.push_str(&format!("q {} 0 0 {} {} {} cm /{} Do Q\n", f(sx), f(sy), f(rect[0] - sx * tx0), f(rect[1] - sy * ty0), nombre));
            extras.push(("XObject", nombre, Object::Reference(ap_ref)));
        }
        if !c.is_empty() { agregar_a_pagina(doc, page_id, c, extras)?; }
    }
    // quitar los widgets de /Annots de cada página
    for (_, pid) in doc.get_pages() {
        let anots: Vec<Object> = match doc.get_object(pid).ok().and_then(|p| p.as_dict().ok()).and_then(|p| p.get(b"Annots").ok()).map(|a| resolver(doc, a).clone()) { Some(Object::Array(a)) => a, _ => continue };
        let nuevas: Vec<Object> = anots.into_iter().filter(|o| o.as_reference().map(|r| !quitar.contains(&r)).unwrap_or(true)).collect();
        if let Ok(Object::Dictionary(p)) = doc.get_object_mut(pid) { p.set("Annots", Object::Array(nuevas)); }
    }
    // AcroForm: se conservan solo las firmas
    if let Some(r) = raiz_id(doc) {
        let firmas: Vec<Object> = campos.iter().filter(|t| t.ft == "Sig").map(|t| Object::Reference(t.id)).collect();
        if firmas.is_empty() { if let Ok(Object::Dictionary(c)) = doc.get_object_mut(r) { c.remove(b"AcroForm"); } }
        else {
            let af = match doc.get_object(r) { Ok(Object::Dictionary(c)) => c.get(b"AcroForm").ok().cloned(), _ => None };
            let id = match af { Some(Object::Reference(i)) => Some(i), _ => None };
            if let Some(i) = id { if let Ok(Object::Dictionary(a)) = doc.get_object_mut(i) { a.set("Fields", Object::Array(firmas)); a.remove(b"NeedAppearances"); } }
        }
    }
    doc.prune_objects();
    Ok(())
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn rangos() {
        assert_eq!(paginas_de("todas", 4).unwrap(), vec![1, 2, 3, 4]);
        assert_eq!(paginas_de("2-3,4-", 6).unwrap(), vec![2, 3, 4, 5, 6]);
        assert!(paginas_de("0", 3).is_err());
        assert!(paginas_de("x", 3).is_err());
    }
    /// Prueba de extremo a extremo: necesita /tmp/edic_test/{normal,rotado,form}.pdf (los crea el script de pruebas).
    #[test]
    fn extremo_a_extremo() {
        let dir = "/tmp/edic_test";
        if !std::path::Path::new(&format!("{dir}/normal.pdf")).exists() { eprintln!("sin PDF de prueba: se omite"); return; }
        for nombre in ["normal", "rotado"] {
            let d = Decorado {
                marca: Some(Marca { texto: "CONFIDENCIAL".into(), tam: 60.0, opacidad: 0.25, color: [0.8, 0.0, 0.0], angulo: 45.0 }),
                numeracion: Some(Numeracion { formato: "Página {n} de {total}".into(), posicion: "pie-derecha".into(), tam: 10.0, inicio: 1, color: [0.0, 0.0, 0.0] }),
                paginas: "todas".into(),
            };
            decorar(&format!("{dir}/{nombre}.pdf"), &format!("{dir}/{nombre}_deco.pdf"), &d).unwrap();
            let zonas = vec![Zona { pagina: 1, x: 0.1, y: 0.1, w: 0.5, h: 0.08 }];
            let render = |ruta: &str, pag: u32, dpi: u32| -> Result<Vec<u8>, String> {
                let out = format!("{dir}/render_tmp.png");
                let st = std::process::Command::new("gs").args(["-dNOPAUSE", "-dBATCH", "-dQUIET", "-sDEVICE=png16m", &format!("-r{}", dpi), "-dUseCropBox", &format!("-dFirstPage={}", pag), &format!("-dLastPage={}", pag), &format!("-sOutputFile={}", out), ruta]).status().map_err(|e| e.to_string())?;
                if !st.success() { return Err("gs falló".into()); }
                std::fs::read(&out).map_err(|e| e.to_string())
            };
            redactar(&format!("{dir}/{nombre}.pdf"), &format!("{dir}/{nombre}_red.pdf"), &zonas, 150, &render).unwrap();
        }
        // metadatos
        let m = leer_meta(&format!("{dir}/normal.pdf")).unwrap();
        eprintln!("{:?}", m);
        assert_eq!(m.autor, "Mariano Prueba");
        let mut o = LimpiarMeta { borrar_info: true, quitar_xmp: true, quitar_marcadores: true, quitar_adjuntos: true, quitar_javascript: true, quitar_comentarios: true, ..Default::default() };
        o.campos.insert("titulo".into(), "Documento limpio".into());
        limpiar_meta(&format!("{dir}/normal.pdf"), &format!("{dir}/normal_meta.pdf"), &o).unwrap();
        let m2 = leer_meta(&format!("{dir}/normal_meta.pdf")).unwrap();
        assert!(m2.autor.is_empty() && m2.titulo == "Documento limpio" && !m2.marcadores && m2.comentarios == 0);
        // formulario
        let campos = leer_campos(&format!("{dir}/form.pdf")).unwrap();
        eprintln!("{:#?}", campos);
        assert!(campos.len() >= 4);
        let mut v = HashMap::new();
        v.insert("nombre".to_string(), "José Ángel Núñez".to_string());
        v.insert("notas".to_string(), "Línea uno de las notas del formulario que es larga y debe partirse en varias líneas.".to_string());
        v.insert("acepto".to_string(), "true".to_string());
        v.insert("sexo".to_string(), "Mujer".to_string());
        v.insert("pais".to_string(), "España".to_string());
        rellenar(&format!("{dir}/form.pdf"), &format!("{dir}/form_ok.pdf"), &v, false).unwrap();
        rellenar(&format!("{dir}/form.pdf"), &format!("{dir}/form_plano.pdf"), &v, true).unwrap();
        let c2 = leer_campos(&format!("{dir}/form_ok.pdf")).unwrap();
        assert_eq!(c2.iter().find(|c| c.nombre == "nombre").unwrap().valor, "José Ángel Núñez");
        assert!(leer_campos(&format!("{dir}/form_plano.pdf")).unwrap().is_empty());
    }
    #[test]
    fn anchos() { assert!((ancho_texto("Hello", 10.0) - 22.78).abs() < 0.1); }
}
