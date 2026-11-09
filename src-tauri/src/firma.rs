//! Firma de PDF: sello visual (nombre, NIF y fecha del certificado) y firma criptográfica
//! (`adbe.pkcs7.detached`, SHA-256) añadidas como ACTUALIZACIÓN INCREMENTAL: el contenido
//! original no se toca, así que las firmas anteriores siguen siendo válidas.
//!
//! - La parte PDF (este fichero) es independiente de la plataforma y se prueba con openssl.
//! - La firma CMS la hace un `Firmante`; en Windows usa CryptoAPI (`capi`) con el almacén
//!   de certificados (DNIe, FNMT…) o un .pfx.

use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::anotaciones::{caja, rotacion};

/// Tamaño reservado (bytes) para la firma CMS. Sobra para una cadena de 3 certificados.
const RESERVA: usize = 16384;

// ───────────────────────────── Tipos públicos ─────────────────────────────

#[derive(Serialize, Clone, Debug, Default)]
pub struct CertInfo {
    pub id: String,        // SHA-256 del DER (hex)
    pub nombre: String,
    pub nif: String,
    pub emisor: String,
    pub caduca: String,    // AAAA-MM-DD
    pub caducado: bool,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Opciones {
    pub cert_origen: String,           // "almacen" | "pfx"
    pub cert_id: String,
    pub pfx_ruta: Option<String>,
    pub pfx_clave: Option<String>,
    pub criptografica: bool,
    pub visual: bool,
    pub rect: [f64; 4],                // x, y, w, h como fracción de la página tal como se ve
    pub paginas: String,               // "1", "1,3-5", "todas", "ultima"
    pub fecha: bool,
    pub razon: Option<String>,
    pub lugar: Option<String>,
    pub desfase_min: i32,              // minutos al este de UTC (Madrid invierno = 60)
    pub nivel: Option<String>,         // "basica" | "tiempo" | "ltv"
    pub tsa_url: Option<String>,
}

pub trait Firmante {
    /// Devuelve un CMS/PKCS#7 DER *detached* (SHA-256) de `datos`.
    fn firmar(&self, datos: &[u8]) -> Result<Vec<u8>, String>;
}

// ───────────────────────────── Fecha y hora ─────────────────────────────

fn civil(dias: i64) -> (i64, u32, u32) {
    let z = dias + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub(crate) struct Hora { pub(crate) a: i64, pub(crate) m: u32, pub(crate) d: u32, pub(crate) h: u32, pub(crate) mi: u32, pub(crate) s: u32 }

pub(crate) fn hora_local(unix: i64, desfase_min: i32) -> Hora {
    let t = unix + desfase_min as i64 * 60;
    let dias = t.div_euclid(86400);
    let seg = t.rem_euclid(86400);
    let (a, m, d) = civil(dias);
    Hora { a, m, d, h: (seg / 3600) as u32, mi: ((seg % 3600) / 60) as u32, s: (seg % 60) as u32 }
}

pub(crate) fn ahora_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn fecha_pdf(h: &Hora, desfase_min: i32) -> String {
    let signo = if desfase_min < 0 { '-' } else { '+' };
    let a = desfase_min.abs();
    format!("D:{:04}{:02}{:02}{:02}{:02}{:02}{}{:02}'{:02}'", h.a, h.m, h.d, h.h, h.mi, h.s, signo, a / 60, a % 60)
}

// ───────────────────────────── Certificados (DER) ─────────────────────────────

pub(crate) fn tlv(b: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    if b.len() < 2 { return None; }
    let tag = b[0];
    let (len, hdr) = if b[1] < 0x80 { (b[1] as usize, 2) } else {
        let n = (b[1] & 0x7f) as usize;
        if n == 0 || n > 4 || b.len() < 2 + n { return None; }
        let mut l = 0usize;
        for i in 0..n { l = (l << 8) | b[2 + i] as usize; }
        (l, 2 + n)
    };
    if b.len() < hdr + len { return None; }
    Some((tag, &b[hdr..hdr + len], &b[hdr + len..]))
}

pub(crate) fn hijos(mut b: &[u8]) -> Vec<(u8, &[u8])> {
    let mut v = vec![];
    while let Some((t, c, r)) = tlv(b) { v.push((t, c)); b = r; }
    v
}

fn texto_asn1(tag: u8, c: &[u8]) -> String {
    match tag {
        0x1E => {
            let u: Vec<u16> = c.chunks(2).filter(|p| p.len() == 2).map(|p| u16::from_be_bytes([p[0], p[1]])).collect();
            String::from_utf16_lossy(&u)
        }
        0x0C => String::from_utf8_lossy(c).into_owned(),
        _ => match std::str::from_utf8(c) {
            Ok(s) => s.to_string(),
            Err(_) => c.iter().map(|&b| b as char).collect(),
        },
    }
}

/// Atributos de un Name (SEQUENCE de SET de SEQUENCE{OID, valor}).
pub(crate) fn atributos(name: &[u8]) -> Vec<(Vec<u8>, String)> {
    let mut v = vec![];
    for (_, set) in hijos(name) {
        for (_, seq) in hijos(set) {
            let h = hijos(seq);
            if h.len() == 2 && h[0].0 == 0x06 { v.push((h[0].1.to_vec(), texto_asn1(h[1].0, h[1].1))); }
        }
    }
    v
}

pub(crate) fn atr(a: &[(Vec<u8>, String)], oid: &[u8]) -> Option<String> {
    a.iter().find(|(o, _)| o == oid).map(|(_, s)| s.clone())
}

pub(crate) fn fecha_asn1(tag: u8, c: &[u8]) -> String {
    let s = String::from_utf8_lossy(c).into_owned();
    if tag == 0x17 && s.len() >= 6 {
        let yy: u32 = s[0..2].parse().unwrap_or(0);
        let a = if yy < 50 { 2000 + yy } else { 1900 + yy };
        format!("{:04}-{}-{}", a, &s[2..4], &s[4..6])
    } else if s.len() >= 8 {
        format!("{}-{}-{}", &s[0..4], &s[4..6], &s[6..8])
    } else { String::new() }
}

fn limpiar_nombre(cn: &str) -> String {
    let mut n = cn.trim().to_string();
    // FNMT: "NOMBRE APELLIDOS - NIF 12345678Z"
    for sep in [" - NIF", " - DNI", " - CIF"] {
        if let Some(p) = n.find(sep) { n.truncate(p); }
    }
    // DNIe: "APELLIDOS, NOMBRE (AUTENTICACIÓN)"
    if n.ends_with(')') {
        if let Some(p) = n.rfind(" (") { n.truncate(p); }
    }
    n.trim().to_string()
}

fn limpiar_nif(s: &str) -> String {
    let t = s.trim();
    // "IDCES-12345678Z", "PNOES-12345678Z"
    if let Some(p) = t.find('-') {
        if p == 5 && t[..5].chars().all(|c| c.is_ascii_uppercase()) { return t[p + 1..].to_string(); }
    }
    t.to_string()
}

pub fn info_de_der(der: &[u8]) -> Option<CertInfo> {
    use sha2::{Digest, Sha256};
    let (_, cert, _) = tlv(der)?;
    let (_, tbs, _) = tlv(cert)?;
    let mut h = hijos(tbs);
    if h.first().map(|x| x.0) == Some(0xA0) { h.remove(0); }
    // serial, sigalg, issuer, validity, subject
    if h.len() < 5 { return None; }
    let emisor_a = atributos(h[2].1);
    let valid = hijos(h[3].1);
    let subj = atributos(h[4].1);
    let cn = atr(&subj, &[0x55, 4, 3]).unwrap_or_default();
    let given = atr(&subj, &[0x55, 4, 0x2A]);
    let sur = atr(&subj, &[0x55, 4, 4]);
    let nombre = match (given, sur) {
        (Some(g), Some(s)) if !g.trim().is_empty() && !s.trim().is_empty() => format!("{} {}", g.trim(), s.trim()),
        _ => {
            let c = limpiar_nombre(&cn);
            match c.split_once(", ") { Some((ap, no)) => format!("{} {}", no.trim(), ap.trim()), None => c }
        }
    };
    let mut nif = atr(&subj, &[0x55, 4, 5]).map(|s| limpiar_nif(&s)).unwrap_or_default();
    if nif.is_empty() {
        if let Some(p) = cn.find(" - NIF ") { nif = cn[p + 7..].split_whitespace().next().unwrap_or("").to_string(); }
    }
    let emisor = atr(&emisor_a, &[0x55, 4, 3]).or_else(|| atr(&emisor_a, &[0x55, 4, 0x0A])).unwrap_or_default();
    let caduca = valid.get(1).map(|(t, c)| fecha_asn1(*t, c)).unwrap_or_default();
    let hoy = { let a = hora_local(ahora_unix(), 0); format!("{:04}-{:02}-{:02}", a.a, a.m, a.d) };
    let id: String = Sha256::digest(der).iter().map(|b| format!("{:02x}", b)).collect();
    Some(CertInfo { id, nombre, nif, emisor, caducado: !caduca.is_empty() && caduca < hoy, caduca })
}

// ───────────────────────────── Serialización PDF ─────────────────────────────

fn nombre_pdf(n: &[u8], out: &mut Vec<u8>) {
    out.push(b'/');
    for &c in n {
        if c <= 32 || c >= 127 || b"()<>[]{}/%#".contains(&c) { out.extend(format!("#{:02X}", c).bytes()); } else { out.push(c); }
    }
}

fn num_pdf(f: f64) -> String {
    let s = format!("{:.3}", f);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s.is_empty() || s == "-" { "0".into() } else { s }
}

pub(crate) fn ser(o: &Object, out: &mut Vec<u8>) {
    match o {
        Object::Null => out.extend(b"null"),
        Object::Boolean(b) => out.extend(if *b { &b"true"[..] } else { &b"false"[..] }),
        Object::Integer(i) => out.extend(i.to_string().bytes()),
        Object::Real(f) => out.extend(num_pdf(*f as f64).bytes()),
        Object::Name(n) => nombre_pdf(n, out),
        Object::String(s, _) => { out.push(b'<'); for b in s { out.extend(format!("{:02X}", b).bytes()); } out.push(b'>'); }
        Object::Array(a) => { out.push(b'['); for (i, x) in a.iter().enumerate() { if i > 0 { out.push(b' '); } ser(x, out); } out.push(b']'); }
        Object::Dictionary(d) => ser_dic(d, out),
        Object::Stream(s) => {
            let mut d = s.dict.clone();
            d.set("Length", Object::Integer(s.content.len() as i64));
            ser_dic(&d, out);
            out.extend(b"\nstream\n");
            out.extend(&s.content);
            out.extend(b"\nendstream");
        }
        Object::Reference((n, g)) => out.extend(format!("{} {} R", n, g).bytes()),
    }
}

pub(crate) fn ser_dic(d: &Dictionary, out: &mut Vec<u8>) {
    out.extend(b"<<");
    for (k, v) in d.iter() { nombre_pdf(k, out); out.push(b' '); ser(v, out); out.push(b' '); }
    out.extend(b">>");
}

/// Texto PDF: ASCII tal cual, resto UTF-16BE con BOM; siempre en hexadecimal.
fn texto_pdf(s: &str) -> String {
    let mut h = String::from("<");
    if s.is_ascii() {
        for b in s.bytes() { h.push_str(&format!("{:02X}", b)); }
    } else {
        h.push_str("FEFF");
        for u in s.encode_utf16() { h.push_str(&format!("{:04X}", u)); }
    }
    h.push('>');
    h
}

fn winansi(s: &str) -> Vec<u8> {
    let mut v = vec![];
    for c in s.chars() {
        let b = match c { '€' => 0x80, c if (c as u32) < 256 => c as u32 as u8, _ => b'?' };
        if b == b'(' || b == b')' || b == b'\\' { v.push(b'\\'); }
        v.push(b);
    }
    v
}

fn ancho_texto(s: &str, fs: f64) -> f64 {
    s.chars().map(|c| match c {
        ' ' => 0.278,
        'i' | 'j' | 'l' | 'I' | '.' | ',' | ':' | ';' | '\'' => 0.26,
        'm' | 'w' | 'M' | 'W' => 0.82,
        c if c.is_ascii_uppercase() || "ÁÉÍÓÚÑÜ".contains(c) => 0.70,
        c if c.is_ascii_digit() => 0.556,
        _ => 0.52,
    }).sum::<f64>() * fs
}

// ───────────────────────────── Páginas ─────────────────────────────

fn paginas_de(spec: &str, total: u32) -> Vec<u32> {
    let s = spec.trim().to_lowercase();
    let mut v: Vec<u32> = vec![];
    if s == "todas" { v = (1..=total).collect(); }
    else if s == "ultima" || s == "última" { v.push(total); }
    else {
        for parte in s.split(',') {
            let p = parte.trim();
            if let Some((a, b)) = p.split_once('-') {
                if let (Ok(a), Ok(b)) = (a.trim().parse::<u32>(), b.trim().parse::<u32>()) { v.extend(a.min(b)..=a.max(b)); }
            } else if let Ok(n) = p.parse::<u32>() { v.push(n); }
        }
    }
    v.retain(|&n| n >= 1 && n <= total);
    v.sort(); v.dedup();
    v
}

/// Rectángulo visible (fracciones) → rectángulo en espacio de usuario + tamaño visible en puntos + matriz.
fn a_usuario(cj: [f64; 4], rot: i64, r: [f64; 4]) -> ([f64; 4], f64, f64, [i32; 4]) {
    let (bw, bh) = (cj[2] - cj[0], cj[3] - cj[1]);
    let (dw, dh) = if rot == 90 || rot == 270 { (bh, bw) } else { (bw, bh) };
    let (x0, y0, x1, y1) = (r[0].clamp(0.0, 1.0), r[1].clamp(0.0, 1.0), (r[0] + r[2]).clamp(0.0, 1.0), (r[1] + r[3]).clamp(0.0, 1.0));
    let punto = |u: f64, v: f64| -> (f64, f64) {
        let (dx, dy) = (u * dw, v * dh);
        let (a, b) = match rot {
            90 => (dy, dx),
            180 => (bw - dx, dy),
            270 => (bw - dy, bh - dx),
            _ => (dx, bh - dy),
        };
        (cj[0] + a, cj[1] + b)
    };
    let (p1, p2) = (punto(x0, y0), punto(x1, y1));
    let rect = [p1.0.min(p2.0), p1.1.min(p2.1), p1.0.max(p2.0), p1.1.max(p2.1)];
    let m = match rot { 90 => [0, 1, -1, 0], 180 => [-1, 0, 0, -1], 270 => [0, -1, 1, 0], _ => [1, 0, 0, 1] };
    (rect, (x1 - x0) * dw, (y1 - y0) * dh, m)
}

fn contenido_sello(w: f64, h: f64, lineas: &[String]) -> Vec<u8> {
    let n = lineas.len().max(1) as f64;
    let mut fs = (h - 6.0) / (n * 1.25);
    fs = fs.min(11.0);
    let maxw = w - 8.0;
    for l in lineas { let a = ancho_texto(l, 1.0); if a > 0.0 { fs = fs.min(maxw / a); } }
    let fs = fs.max(4.0);
    let mut c: Vec<u8> = vec![];
    c.extend(format!("q 0.12 0.25 0.55 RG 0.8 w 0.4 0.4 {} {} re S\n", num_pdf(w - 0.8), num_pdf(h - 0.8)).bytes());
    c.extend(b"BT 0.1 0.1 0.15 rg\n");
    c.extend(format!("/F1 {} Tf {} TL\n", num_pdf(fs), num_pdf(fs * 1.25)).bytes());
    let alto_texto = fs * 1.25 * n;
    let y0 = (h + alto_texto) / 2.0 - fs * 1.0;
    c.extend(format!("4 {} Td\n", num_pdf(y0)).bytes());
    for (i, l) in lineas.iter().enumerate() {
        c.push(b'(');
        c.extend(winansi(l));
        c.extend(if i + 1 < lineas.len() { &b") Tj T*\n"[..] } else { &b") Tj\n"[..] });
    }
    c.extend(b"ET Q");
    c
}

// ───────────────────────────── Actualización incremental ─────────────────────────────

fn valor<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    if let Object::Reference(id) = o { doc.get_object(*id).unwrap_or(o) } else { o }
}

pub(crate) struct Nuevos { pub(crate) objs: BTreeMap<u32, (u16, Vec<u8>)>, pub(crate) siguiente: u32 }
impl Nuevos {
    pub(crate) fn new(siguiente: u32) -> Nuevos { Nuevos { objs: BTreeMap::new(), siguiente } }
    pub(crate) fn id(&mut self) -> u32 { let i = self.siguiente; self.siguiente += 1; i }
    pub(crate) fn poner(&mut self, id: u32, gen: u16, cuerpo: Vec<u8>) { self.objs.insert(id, (gen, cuerpo)); }
}

pub(crate) fn ultimo_startxref(b: &[u8]) -> Option<usize> {
    let cola = &b[b.len().saturating_sub(2048)..];
    let p = cola.windows(9).rposition(|w| w == b"startxref")?;
    let s = String::from_utf8_lossy(&cola[p + 9..]);
    s.split_whitespace().next()?.parse().ok()
}

fn buscar(h: &[u8], aguja: &[u8], desde: usize) -> Option<usize> {
    h[desde..].windows(aguja.len()).position(|w| w == aguja).map(|p| p + desde)
}

/// Añade a `bytes` una actualización incremental con los objetos nuevos (+ xref y trailer). Devuelve el offset donde empieza.
pub(crate) fn ensamblar(bytes: &mut Vec<u8>, doc: &Document, nuevos: &Nuevos, raiz_id: ObjectId, prev: usize, prev_es_flujo: bool) -> usize {
    if bytes.last() != Some(&b'\n') { bytes.push(b'\n'); }
    let base = bytes.len();
    let mut cola: Vec<u8> = vec![];
    let mut offsets: BTreeMap<u32, (u16, usize)> = BTreeMap::new();
    for (id_obj, (gen, cuerpo)) in &nuevos.objs {
        offsets.insert(*id_obj, (*gen, base + cola.len()));
        cola.extend(format!("{} {} obj\n", id_obj, gen).bytes());
        cola.extend(cuerpo);
        cola.extend(b"\nendobj\n");
    }
    let mut size_nuevo = nuevos.siguiente;
    let xref_pos = base + cola.len();
    let mut extra = String::new();
    if let Ok(i) = doc.trailer.get(b"Info") { let mut b = vec![]; ser(i, &mut b); extra.push_str(&format!("/Info {}", String::from_utf8_lossy(&b))); }
    if let Ok(i) = doc.trailer.get(b"ID") { let mut b = vec![]; ser(i, &mut b); extra.push_str(&format!("/ID {}", String::from_utf8_lossy(&b))); }
    if prev_es_flujo {
        let xid = size_nuevo; size_nuevo += 1;
        offsets.insert(xid, (0, xref_pos));
        let mut grupos: Vec<(u32, u32)> = vec![];
        for &k in offsets.keys() {
            match grupos.last_mut() { Some((s, c)) if *s + *c == k => *c += 1, _ => grupos.push((k, 1)) }
        }
        let mut datos: Vec<u8> = vec![];
        for (k, (g, off)) in &offsets { let _ = k; datos.push(1); datos.extend((*off as u32).to_be_bytes()); datos.extend(g.to_be_bytes()); }
        let index: String = grupos.iter().map(|(s, c)| format!("{} {}", s, c)).collect::<Vec<_>>().join(" ");
        cola.extend(format!("{} 0 obj\n<</Type/XRef/Size {}/W[1 4 2]/Index[{}]/Root {} {} R/Prev {}{}/Length {}>>\nstream\n",
            xid, size_nuevo, index, raiz_id.0, raiz_id.1, prev, extra, datos.len()).bytes());
        cola.extend(&datos);
        cola.extend(b"\nendstream\nendobj\n");
    } else {
        let mut x = String::from("xref\n");
        let claves: Vec<u32> = offsets.keys().copied().collect();
        let mut i = 0;
        while i < claves.len() {
            let mut j = i;
            while j + 1 < claves.len() && claves[j + 1] == claves[j] + 1 { j += 1; }
            x.push_str(&format!("{} {}\n", claves[i], j - i + 1));
            for k in i..=j { let (g, off) = offsets[&claves[k]]; x.push_str(&format!("{:010} {:05} n \n", off, g)); }
            i = j + 1;
        }
        x.push_str(&format!("trailer\n<</Size {}/Root {} {} R/Prev {}{}>>\n", size_nuevo, raiz_id.0, raiz_id.1, prev, extra));
        cola.extend(x.bytes());
    }
    cola.extend(format!("startxref\n{}\n%%EOF\n", xref_pos).bytes());
    bytes.extend(cola);
    base

}

pub fn firmar_pdf(entrada: &str, salida: &str, op: &Opciones, id: &CertInfo, firmante: Option<&dyn Firmante>) -> Result<(), String> {
    if !op.criptografica && !op.visual { return Err("Nada que hacer: activa el sello visual o la firma digital.".into()); }
    if op.criptografica && firmante.is_none() { return Err("No hay certificado para firmar.".into()); }
    let mut bytes = std::fs::read(entrada).map_err(|e| format!("No se pudo leer el PDF: {e}"))?;
    let doc = Document::load_mem(&bytes).map_err(|e| format!("PDF no válido: {e}"))?;
    if doc.is_encrypted() { return Err("El PDF está protegido con contraseña; quita la protección antes de firmarlo.".into()); }
    let prev = ultimo_startxref(&bytes).ok_or("No se encontró startxref")?;
    let prev_es_flujo = !bytes.get(prev..prev + 4).map(|s| s == b"xref").unwrap_or(false);
    let raiz_id = doc.trailer.get(b"Root").and_then(|o| o.as_reference()).map_err(|_| "PDF sin catálogo")?;
    let size_orig = match doc.trailer.get(b"Size") { Ok(Object::Integer(i)) => *i as u32, _ => 0 };
    let mut nuevos = Nuevos { objs: BTreeMap::new(), siguiente: size_orig.max(doc.max_id + 1) };

    let paginas = doc.get_pages();
    let total = paginas.len() as u32;
    if total == 0 { return Err("El PDF no tiene páginas".into()); }
    let mut sel = if op.visual { paginas_de(&op.paginas, total) } else { vec![] };
    if op.visual && sel.is_empty() { return Err("Ninguna de las páginas elegidas existe en este PDF.".into()); }
    let pagina_firma = sel.first().copied().unwrap_or(1);
    if !op.visual { sel.clear(); }

    // Texto del sello
    let ahora = ahora_unix();
    let hl = hora_local(ahora, op.desfase_min);
    let mut lineas = vec![if op.criptografica { "Firmado digitalmente por:".to_string() } else { "Firmado por:".to_string() }, id.nombre.clone()];
    if !id.nif.is_empty() { lineas.push(format!("NIF: {}", id.nif)); }
    if op.fecha { lineas.push(format!("Fecha: {:02}/{:02}/{:04} {:02}:{:02}", hl.d, hl.m, hl.a, hl.h, hl.mi)); }

    // Fuente compartida
    let font_id = nuevos.id();
    nuevos.poner(font_id, 0, b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>".to_vec());

    let marca = format!("Firma_{}", ahora);
    let mut sig_id = 0u32;
    if op.criptografica {
        sig_id = nuevos.id();
        let mut s: Vec<u8> = b"<</Type/Sig/Filter/Adobe.PPKLite/SubFilter/adbe.pkcs7.detached/ByteRange [0 0000000000 0000000000 0000000000]/Contents <".to_vec();
        s.extend(std::iter::repeat(b'0').take(RESERVA * 2));
        s.extend(b">");
        s.extend(format!("/M ({})/Name {}", fecha_pdf(&hl, op.desfase_min), texto_pdf(&id.nombre)).bytes());
        if let Some(r) = op.razon.as_ref().filter(|r| !r.trim().is_empty()) { s.extend(format!("/Reason {}", texto_pdf(r)).bytes()); }
        if let Some(l) = op.lugar.as_ref().filter(|r| !r.trim().is_empty()) { s.extend(format!("/Location {}", texto_pdf(l)).bytes()); }
        s.extend(b">>");
        nuevos.poner(sig_id, 0, s);
    }

    // Anotaciones por página
    let mut campos: Vec<u32> = vec![];
    let paginas_a_tocar: Vec<u32> = if sel.is_empty() { if op.criptografica { vec![pagina_firma] } else { vec![] } } else { sel.clone() };
    for &n in &paginas_a_tocar {
        let pid: ObjectId = *paginas.get(&n).ok_or("Página inexistente")?;
        let cj = caja(&doc, pid);
        let rot = rotacion(&doc, pid);
        let es_firma = op.criptografica && n == pagina_firma;
        let ann_id = nuevos.id();
        let mut a: Vec<u8> = vec![];
        if op.visual {
            let (rect, w, h, m) = a_usuario(cj, rot, op.rect);
            if w < 5.0 || h < 5.0 { return Err("El recuadro de firma es demasiado pequeño.".into()); }
            let ap_id = nuevos.id();
            let cont = contenido_sello(w, h, &lineas);
            let mut ap: Vec<u8> = format!(
                "<</Type/XObject/Subtype/Form/BBox[0 0 {} {}]/Matrix[{} {} {} {} 0 0]/Resources<</Font<</F1 {} 0 R>>>>/Length {}>>\nstream\n",
                num_pdf(w), num_pdf(h), m[0], m[1], m[2], m[3], font_id, cont.len()).into_bytes();
            ap.extend(&cont);
            ap.extend(b"\nendstream");
            nuevos.poner(ap_id, 0, ap);
            let sub = if es_firma { "/Subtype/Widget/FT/Sig" } else { "/Subtype/Stamp" };
            a.extend(format!("<</Type/Annot{} /F 132/Rect[{} {} {} {}]/P {} {} R/AP<</N {} 0 R>>",
                sub, num_pdf(rect[0]), num_pdf(rect[1]), num_pdf(rect[2]), num_pdf(rect[3]), pid.0, pid.1, ap_id).bytes());
            if !es_firma { a.extend(format!("/Contents {}", texto_pdf(&lineas.join(" "))).bytes()); }
        } else {
            a.extend(format!("<</Type/Annot/Subtype/Widget/FT/Sig/F 132/Rect[0 0 0 0]/P {} {} R", pid.0, pid.1).bytes());
        }
        if es_firma {
            a.extend(format!("/T {}/V {} 0 R", texto_pdf(&marca), sig_id).bytes());
            campos.push(ann_id);
        }
        a.extend(b">>");
        nuevos.poner(ann_id, 0, a);

        // Reescribe la página con /Annots ampliado
        let mut pd = doc.get_object(pid).and_then(|o| o.as_dict().cloned()).map_err(|_| "Página ilegible")?;
        match pd.get(b"Annots").ok().cloned() {
            Some(Object::Reference(rid)) => {
                // el array es un objeto aparte: se reescribe una sola vez
                let mut arr = match doc.get_object(rid) { Ok(Object::Array(a)) => a.clone(), _ => vec![] };
                if let Some((_, previo)) = nuevos.objs.get(&rid.0) {
                    // ya reescrito antes por otra estampa de la misma página (no ocurre: 1 estampa/página)
                    let _ = previo;
                }
                arr.push(Object::Reference((ann_id, 0)));
                let mut b = vec![]; ser(&Object::Array(arr), &mut b);
                nuevos.poner(rid.0, rid.1, b);
            }
            Some(Object::Array(mut arr)) => {
                arr.push(Object::Reference((ann_id, 0)));
                pd.set("Annots", Object::Array(arr));
            }
            _ => { pd.set("Annots", Object::Array(vec![Object::Reference((ann_id, 0))])); }
        }
        let mut b = vec![]; ser_dic(&pd, &mut b);
        nuevos.poner(pid.0, pid.1, b);
    }

    // AcroForm (solo si hay campo de firma)
    if !campos.is_empty() {
        let cat = doc.get_object(raiz_id).and_then(|o| o.as_dict().cloned()).map_err(|_| "Catálogo ilegible")?;
        let nuevos_campos: Vec<Object> = campos.iter().map(|&c| Object::Reference((c, 0))).collect();
        let (mut af, af_ref) = match cat.get(b"AcroForm").ok() {
            Some(Object::Reference(r)) => (valor(&doc, &Object::Reference(*r)).as_dict().cloned().unwrap_or_default(), Some(*r)),
            Some(Object::Dictionary(d)) => (d.clone(), None),
            _ => (Dictionary::new(), None),
        };
        match af.get(b"Fields").ok().cloned() {
            Some(Object::Reference(r)) => {
                let mut arr = match doc.get_object(r) { Ok(Object::Array(a)) => a.clone(), _ => vec![] };
                arr.extend(nuevos_campos);
                let mut b = vec![]; ser(&Object::Array(arr), &mut b);
                nuevos.poner(r.0, r.1, b);
            }
            Some(Object::Array(mut arr)) => { arr.extend(nuevos_campos); af.set("Fields", Object::Array(arr)); }
            _ => af.set("Fields", Object::Array(nuevos_campos)),
        }
        af.set("SigFlags", Object::Integer(3));
        match af_ref {
            Some(r) => { let mut b = vec![]; ser_dic(&af, &mut b); nuevos.poner(r.0, r.1, b); }
            None => {
                let mut c = cat.clone();
                c.set("AcroForm", Object::Dictionary(af));
                let mut b = vec![]; ser_dic(&c, &mut b);
                nuevos.poner(raiz_id.0, raiz_id.1, b);
            }
        }
    }

    let base = ensamblar(&mut bytes, &doc, &nuevos, raiz_id, prev, prev_es_flujo);

    // Firma criptográfica
    if op.criptografica {
        let ini = base;
        let br = buscar(&bytes, b"/ByteRange [0 ", ini).ok_or("ByteRange no encontrado")?;
        let ct = buscar(&bytes, b"/Contents <", br).ok_or("Contents no encontrado")? + 10; // posición de '<'
        let fin = ct + 1 + RESERVA * 2 + 1;
        let total_len = bytes.len();
        let rango = format!("/ByteRange [0 {:010} {:010} {:010}]", ct, fin, total_len - fin);
        let origen = &mut bytes[br..br + rango.len()];
        origen.copy_from_slice(rango.as_bytes());
        let mut datos = Vec::with_capacity(total_len);
        datos.extend(&bytes[..ct]);
        datos.extend(&bytes[fin..]);
        let cms = firmante.unwrap().firmar(&datos)?;
        if cms.len() > RESERVA { return Err("La firma generada es demasiado grande para el espacio reservado.".into()); }
        let hex: String = cms.iter().map(|b| format!("{:02X}", b)).collect();
        bytes[ct + 1..ct + 1 + hex.len()].copy_from_slice(hex.as_bytes());
    }
    std::fs::write(salida, &bytes).map_err(|e| format!("No se pudo guardar: {e}"))?;
    Ok(())
}

// ───────────────────────────── Windows: CryptoAPI ─────────────────────────────

#[cfg(any(windows, capi_check))]
pub mod capi {
    use super::{info_de_der, CertInfo, Firmante};
    use sha2::{Digest, Sha256};
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    type Hcs = *mut c_void;
    #[repr(C)] pub struct CertContext { enc: u32, pb: *const u8, cb: u32, info: *const c_void, store: Hcs }
    #[repr(C)] struct Blob { cb: u32, pb: *mut u8 }
    #[repr(C)] struct AlgId { oid: *const u8, params: Blob }
    #[repr(C)] struct SignPara {
        cb_size: u32, enc: u32, cert: *const CertContext, hash: AlgId, aux: *mut c_void,
        n_cert: u32, certs: *mut *const CertContext, n_crl: u32, crls: *mut c_void,
        n_auth: u32, auth: *mut c_void, n_unauth: u32, unauth: *mut c_void,
        flags: u32, inner: u32,
    }
    #[repr(C)] struct UsageMatch { tipo: u32, n: u32, ids: *mut *mut u8 }
    #[repr(C)] struct ChainPara {
        cb_size: u32, uso: UsageMatch, politica: UsageMatch, timeout: u32, check: i32, fresh: u32,
        cache: *mut c_void, strong: *mut c_void, strong_flags: u32,
    }
    #[repr(C)] struct ChainCtx { cb_size: u32, err: u32, info: u32, n_chain: u32, chains: *mut *mut SimpleChain }
    #[repr(C)] struct SimpleChain { cb_size: u32, err: u32, info: u32, n_elem: u32, elems: *mut *mut ChainElem }
    #[repr(C)] struct ChainElem { cb_size: u32, cert: *const CertContext }

    #[link(name = "crypt32")]
    extern "system" {
        fn CertOpenSystemStoreW(prov: *mut c_void, nombre: *const u16) -> Hcs;
        fn CertCloseStore(s: Hcs, flags: u32) -> i32;
        fn CertEnumCertificatesInStore(s: Hcs, prev: *const CertContext) -> *const CertContext;
        fn PFXImportCertStore(blob: *const Blob, clave: *const u16, flags: u32) -> Hcs;
        fn CertGetCertificateContextProperty(c: *const CertContext, prop: u32, data: *mut c_void, cb: *mut u32) -> i32;
        fn CertGetCertificateChain(motor: *mut c_void, c: *const CertContext, hora: *const c_void, extra: Hcs, para: *const ChainPara, flags: u32, res: *mut c_void, out: *mut *mut ChainCtx) -> i32;
        fn CertFreeCertificateChain(c: *const ChainCtx);
        fn CryptSignMessage(p: *const SignPara, detached: i32, n: u32, datos: *const *const u8, largos: *const u32, out: *mut u8, cb_out: *mut u32) -> i32;
    }

    const PROP_KEY_PROV_INFO: u32 = 2;
    const PROP_KEY_CONTEXT: u32 = 5;
    const ENC: u32 = 0x0001_0001; // X509_ASN_ENCODING | PKCS_7_ASN_ENCODING

    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }

    unsafe fn der(c: *const CertContext) -> Vec<u8> { std::slice::from_raw_parts((*c).pb, (*c).cb as usize).to_vec() }

    unsafe fn tiene_clave(c: *const CertContext) -> bool {
        let mut n = 0u32;
        CertGetCertificateContextProperty(c, PROP_KEY_PROV_INFO, null_mut(), &mut n) != 0
            || CertGetCertificateContextProperty(c, PROP_KEY_CONTEXT, null_mut(), &mut n) != 0
    }

    /// Almacén abierto (cerrado al soltarlo).
    pub struct Almacen { h: Hcs }
    impl Drop for Almacen { fn drop(&mut self) { unsafe { if !self.h.is_null() { CertCloseStore(self.h, 0); } } } }

    impl Almacen {
        pub fn personal() -> Result<Almacen, String> {
            let h = unsafe { CertOpenSystemStoreW(null_mut(), wide("MY").as_ptr()) };
            if h.is_null() { Err("No se pudo abrir el almacén de certificados de Windows.".into()) } else { Ok(Almacen { h }) }
        }
        pub fn pfx(datos: &[u8], clave: &str) -> Result<Almacen, String> {
            let blob = Blob { cb: datos.len() as u32, pb: datos.as_ptr() as *mut u8 };
            let w = wide(clave);
            // 0x8000 = PKCS12_NO_PERSIST_KEY: la clave no se guarda en el equipo
            let h = unsafe { PFXImportCertStore(&blob, w.as_ptr(), 0x8000) };
            if h.is_null() { Err("No se pudo abrir el .pfx: contraseña incorrecta o archivo dañado.".into()) } else { Ok(Almacen { h }) }
        }
        /// Certificados con clave privada.
        pub fn listar(&self) -> Vec<CertInfo> {
            let mut v = vec![];
            unsafe {
                let mut c: *const CertContext = null();
                loop {
                    c = CertEnumCertificatesInStore(self.h, c);
                    if c.is_null() { break; }
                    if !tiene_clave(c) { continue; }
                    if let Some(i) = info_de_der(&der(c)) { v.push(i); }
                }
            }
            v
        }
        pub fn firmante(&self, id: &str) -> Result<Cert<'_>, String> {
            unsafe {
                let mut c: *const CertContext = null();
                loop {
                    c = CertEnumCertificatesInStore(self.h, c);
                    if c.is_null() { return Err("No se encontró el certificado elegido.".into()); }
                    let d = der(c);
                    let hid: String = Sha256::digest(&d).iter().map(|b| format!("{:02x}", b)).collect();
                    if hid == id {
                        let info = info_de_der(&d).ok_or("Certificado ilegible")?;
                        return Ok(Cert { c, almacen: self, info });
                    }
                }
            }
        }
    }

    // ── Verificación de firmas (usada por validar.rs) ──
    #[repr(C)] struct VerifyPara { cb_size: u32, enc: u32, prov: usize, get_signer: *const c_void, get_arg: *mut c_void }
    #[repr(C)] struct FileTime { lo: u32, hi: u32 }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptVerifyDetachedMessageSignature(p: *const VerifyPara, idx: u32, firma: *const u8, cb_firma: u32, n: u32, datos: *const *const u8, largos: *const u32, cert: *mut *const CertContext) -> i32;
        fn CertFreeCertificateContext(c: *const CertContext) -> i32;
        fn CertOpenStore(prov: usize, enc: u32, hprov: usize, flags: u32, para: *const c_void) -> Hcs;
        fn CertAddEncodedCertificateToStore(s: Hcs, enc: u32, pb: *const u8, cb: u32, disp: u32, out: *mut *const CertContext) -> i32;
    }

    /// Verifica la firma CMS (detached) sobre `datos` y evalúa la cadena de confianza con las raíces de Windows.
    pub fn verificar(cms: &[u8], datos: &[u8], certs: &[Vec<u8>], unix: Option<i64>, revocacion: bool) -> Result<crate::validar::Veredicto, String> {
        unsafe {
            let vp = VerifyPara { cb_size: std::mem::size_of::<VerifyPara>() as u32, enc: ENC, prov: 0, get_signer: null(), get_arg: null_mut() };
            let punteros = [datos.as_ptr()];
            let largos = [datos.len() as u32];
            let mut firmante: *const CertContext = null();
            let ok = CryptVerifyDetachedMessageSignature(&vp, 0, cms.as_ptr(), cms.len() as u32, 1, punteros.as_ptr(), largos.as_ptr(), &mut firmante) != 0;
            let mut v = crate::validar::Veredicto { firma_ok: ok, ..Default::default() };
            if !ok || firmante.is_null() { return Ok(v); }
            // Almacén temporal con los certificados incluidos en la firma (intermedios)
            let mem = CertOpenStore(2 /* CERT_STORE_PROV_MEMORY */, 0, 0, 0, null());
            if !mem.is_null() {
                for c in certs { CertAddEncodedCertificateToStore(mem, ENC, c.as_ptr(), c.len() as u32, 4 /* ADD_ALWAYS */, null_mut()); }
            }
            let para = ChainPara {
                cb_size: std::mem::size_of::<ChainPara>() as u32,
                uso: UsageMatch { tipo: 0, n: 0, ids: null_mut() },
                politica: UsageMatch { tipo: 0, n: 0, ids: null_mut() },
                timeout: 15000, check: 0, fresh: 0, cache: null_mut(), strong: null_mut(), strong_flags: 0,
            };
            let ft = unix.map(|u| { let t = ((u + 11_644_473_600) as u64) * 10_000_000; FileTime { lo: (t & 0xFFFF_FFFF) as u32, hi: (t >> 32) as u32 } });
            let flags: u32 = if revocacion { 0x2000_0000 } else { 0 }; // CERT_CHAIN_REVOCATION_CHECK_CHAIN
            let mut ctx: *mut ChainCtx = null_mut();
            let r = CertGetCertificateChain(null_mut(), firmante, ft.as_ref().map(|f| f as *const FileTime as *const c_void).unwrap_or(null()), mem, &para, flags, null_mut(), &mut ctx);
            if r != 0 && !ctx.is_null() { v.cadena_construida = true; v.error_cadena = (*ctx).err; CertFreeCertificateChain(ctx); }
            else { v.error_cadena = 0x10000; }
            CertFreeCertificateContext(firmante);
            if !mem.is_null() { CertCloseStore(mem, 0); }
            Ok(v)
        }
    }

    pub struct Cert<'a> { c: *const CertContext, almacen: &'a Almacen, pub info: CertInfo }

    impl Firmante for Cert<'_> {
        fn firmar(&self, datos: &[u8]) -> Result<Vec<u8>, String> {
            unsafe {
                // Cadena de certificación para incluirla en la firma (si falla, solo el certificado propio)
                let mut cadena: Vec<*const CertContext> = vec![self.c];
                let mut ctx: *mut ChainCtx = null_mut();
                let para = ChainPara {
                    cb_size: std::mem::size_of::<ChainPara>() as u32,
                    uso: UsageMatch { tipo: 0, n: 0, ids: null_mut() },
                    politica: UsageMatch { tipo: 0, n: 0, ids: null_mut() },
                    timeout: 0, check: 0, fresh: 0, cache: null_mut(), strong: null_mut(), strong_flags: 0,
                };
                if CertGetCertificateChain(null_mut(), self.c, null(), self.almacen.h, &para, 0, null_mut(), &mut ctx) != 0 && !ctx.is_null() {
                    if (*ctx).n_chain > 0 {
                        let sc = *(*ctx).chains;
                        let n = (*sc).n_elem as usize;
                        cadena.clear();
                        for i in 0..n { cadena.push((**(*sc).elems.add(i)).cert); }
                        if cadena.len() > 1 { cadena.pop(); } // sin la raíz
                        if cadena.is_empty() { cadena.push(self.c); }
                    }
                }
                let oid = b"2.16.840.1.101.3.4.2.1\0"; // SHA-256
                let p = SignPara {
                    cb_size: std::mem::size_of::<SignPara>() as u32, enc: ENC, cert: self.c,
                    hash: AlgId { oid: oid.as_ptr(), params: Blob { cb: 0, pb: null_mut() } },
                    aux: null_mut(), n_cert: cadena.len() as u32, certs: cadena.as_mut_ptr(),
                    n_crl: 0, crls: null_mut(), n_auth: 0, auth: null_mut(), n_unauth: 0, unauth: null_mut(),
                    flags: 0, inner: 0,
                };
                let punteros = [datos.as_ptr()];
                let largos = [datos.len() as u32];
                let mut n = 0u32;
                let ok = CryptSignMessage(&p, 1, 1, punteros.as_ptr(), largos.as_ptr(), null_mut(), &mut n);
                let mut salida = vec![0u8; n as usize];
                let ok2 = ok != 0 && CryptSignMessage(&p, 1, 1, punteros.as_ptr(), largos.as_ptr(), salida.as_mut_ptr(), &mut n) != 0;
                if !ctx.is_null() { CertFreeCertificateChain(ctx); }
                if !ok2 { return Err("Windows no pudo firmar (¿PIN cancelado o tarjeta no disponible?).".into()); }
                salida.truncate(n as usize);
                Ok(salida)
            }
        }
    }
}

// ───────────────────────────── Pruebas ─────────────────────────────

#[cfg(test)]
mod pruebas {
    use super::*;
    use std::process::Command;

    struct OpenSsl { cert: String, clave: String }
    impl Firmante for OpenSsl {
        fn firmar(&self, datos: &[u8]) -> Result<Vec<u8>, String> {
            let d = std::env::temp_dir().join(format!("fd_{}", std::process::id()));
            std::fs::write(&d, datos).unwrap();
            let o = Command::new("openssl").args(["cms", "-sign", "-binary", "-in", d.to_str().unwrap(), "-signer", &self.cert, "-inkey", &self.clave, "-outform", "DER", "-md", "sha256"]).output().unwrap();
            if !o.status.success() { return Err(String::from_utf8_lossy(&o.stderr).into()); }
            Ok(o.stdout)
        }
    }

    fn op() -> Opciones {
        Opciones { cert_origen: "pfx".into(), cert_id: "".into(), pfx_ruta: None, pfx_clave: None, criptografica: true, visual: true,
            rect: [0.55, 0.85, 0.4, 0.1], paginas: "todas".into(), fecha: true, razon: Some("Prueba".into()), lugar: None, desfase_min: 60, nivel: None, tsa_url: None }
    }

    #[test]
    fn firma_y_verifica() {
        let dir = std::env::var("FIRMA_DIR").unwrap_or("/tmp/firma_test".into());
        let cert = format!("{dir}/cert.pem"); let clave = format!("{dir}/key.pem");
        if !std::path::Path::new(&cert).exists() { eprintln!("sin material de prueba"); return; }
        let der = Command::new("openssl").args(["x509", "-in", &cert, "-outform", "DER"]).output().unwrap().stdout;
        let id = info_de_der(&der).unwrap();
        eprintln!("{:?}", id);
        let f = OpenSsl { cert, clave };
        for pdf in std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "pdf").unwrap_or(false)) {
            let n = pdf.file_name().unwrap().to_str().unwrap().to_string();
            if n.starts_with("out_") { continue; }
            let salida = format!("{dir}/out_{n}");
            firmar_pdf(pdf.to_str().unwrap(), &salida, &op(), &id, Some(&f)).unwrap();
            eprintln!("generado {salida}");
        }
    }
}
