//! Validación de firmas de un PDF.
//! - Parte portable (se prueba en cualquier sistema): localiza cada firma, comprueba que el
//!   resumen (hash) de los bytes firmados coincide con el de la firma (integridad) y lee el
//!   firmante, la fecha declarada y los certificados incluidos.
//! - Windows (CryptoAPI): verifica la firma matemática y construye la cadena de confianza con
//!   las raíces de Windows; opcionalmente comprueba la revocación (necesita conexión).

use crate::firma::{atr, atributos, fecha_asn1, hijos, info_de_der, tlv, CertInfo};
use serde::Serialize;
use sha2::{Digest, Sha256, Sha384, Sha512};

#[derive(Serialize, Clone, Debug, Default)]
pub struct ResultadoValidacion {
    pub indice: u32,
    pub nombre: String,
    pub nif: String,
    pub emisor: String,
    pub caduca: String,
    pub fecha_firma: String,
    pub integridad: String,         // "ok" | "modificado" | "no_verificable"
    pub firma: String,              // "ok" | "invalida" | "no_comprobada"
    pub cadena: String,             // "confiable" | "no_confiable" | "parcial" | "no_comprobada"
    pub revocacion: String,         // "ok" | "revocado" | "desconocida" | "no_comprobada"
    pub cubre_todo: bool,           // la firma cubre hasta el final del archivo
    pub sello_tiempo: String,       // fecha del sello de tiempo (vacío si no tiene)
    pub sello_coincide: bool,       // el sello corresponde a esta firma
    pub ltv: bool,                  // el PDF lleva datos de validación (DSS)
    pub nivel: String,              // "ok" | "aviso" | "error"
    pub resumen: String,
    pub detalles: Vec<String>,
}

pub struct Extraida {
    pub rango: [u64; 4],
    pub cms: Vec<u8>,
    pub datos: Vec<u8>,
}

// ───── SHA-1 (solo para comprobar firmas antiguas) ─────
pub fn sha1_pub(d: &[u8]) -> Vec<u8> { sha1(d) }
fn sha1(d: &[u8]) -> Vec<u8> {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut m = d.to_vec();
    m.push(0x80);
    while m.len() % 64 != 56 { m.push(0); }
    m.extend(((d.len() as u64) * 8).to_be_bytes());
    for blq in m.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 { w[i] = u32::from_be_bytes([blq[4 * i], blq[4 * i + 1], blq[4 * i + 2], blq[4 * i + 3]]); }
        for i in 16..80 { w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1); }
        let (mut a, mut b, mut c, mut dd, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i { 0..=19 => ((b & c) | (!b & dd), 0x5A827999u32), 20..=39 => (b ^ c ^ dd, 0x6ED9EBA1), 40..=59 => ((b & c) | (b & dd) | (c & dd), 0x8F1BBCDC), _ => (b ^ c ^ dd, 0xCA62C1D6) };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = dd; dd = c; c = b.rotate_left(30); b = a; a = t;
        }
        h[0] = h[0].wrapping_add(a); h[1] = h[1].wrapping_add(b); h[2] = h[2].wrapping_add(c); h[3] = h[3].wrapping_add(dd); h[4] = h[4].wrapping_add(e);
    }
    h.iter().flat_map(|x| x.to_be_bytes()).collect()
}

fn resumen_hash(oid: &[u8], datos: &[u8]) -> Option<Vec<u8>> {
    match oid {
        [0x2B, 0x0E, 0x03, 0x02, 0x1A] => Some(sha1(datos)),
        [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01] => Some(Sha256::digest(datos).to_vec()),
        [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02] => Some(Sha384::digest(datos).to_vec()),
        [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03] => Some(Sha512::digest(datos).to_vec()),
        _ => None,
    }
}

// ───── Localizar firmas en el PDF ─────
fn hex_a_bytes(h: &[u8]) -> Vec<u8> {
    let v: Vec<u8> = h.iter().copied().filter(|c| c.is_ascii_hexdigit()).collect();
    v.chunks(2).filter(|p| p.len() == 2).map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap_or("0"), 16).unwrap_or(0)).collect()
}

pub fn extraer_firmas(b: &[u8]) -> Vec<Extraida> {
    let clave = b"/ByteRange";
    let mut v = vec![];
    let mut i = 0usize;
    while let Some(p) = b[i..].windows(clave.len()).position(|w| w == clave) {
        let ini = i + p + clave.len();
        i = ini;
        let fin = (ini + 160).min(b.len());
        let t = String::from_utf8_lossy(&b[ini..fin]).into_owned();
        let (Some(a), Some(c)) = (t.find('['), t.find(']')) else { continue };
        let n: Vec<u64> = t[a + 1..c].split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if n.len() != 4 || n[1] == 0 { continue; }
        let (b1, c1) = (n[1] as usize, n[2] as usize);
        let (Some(fin1), Some(fin2)) = (n[0].checked_add(n[1]), n[2].checked_add(n[3])) else { continue };
        if c1 > b.len() || b1 >= c1 || fin2 > b.len() as u64 || fin1 > n[2] { continue; }
        let contenido = &b[b1..c1];
        if contenido.first() != Some(&b'<') || contenido.last() != Some(&b'>') { continue; }
        let mut cms = hex_a_bytes(&contenido[1..contenido.len() - 1]);
        if let Some((_, c, r)) = tlv(&cms) { let total = cms.len() - r.len(); let _ = c; cms.truncate(total); } else { continue; }
        let mut datos = Vec::with_capacity((n[1] + n[3]) as usize);
        datos.extend(&b[n[0] as usize..(n[0] + n[1]) as usize]);
        datos.extend(&b[c1..(n[2] + n[3]) as usize]);
        v.push(Extraida { rango: [n[0], n[1], n[2], n[3]], cms, datos });
    }
    v
}

// ───── Análisis del CMS ─────
pub struct Cms {
    pub certs: Vec<Vec<u8>>,
    pub firmante: Option<Vec<u8>>,
    pub hash_oid: Vec<u8>,
    pub digest_firmado: Option<Vec<u8>>,   // atributo messageDigest
    pub fecha: Option<(u8, Vec<u8>)>,      // signingTime
}

fn elementos(mut b: &[u8]) -> Vec<(u8, &[u8], &[u8])> {
    let mut v = vec![];
    while let Some((t, c, r)) = tlv(b) { let full = &b[..b.len() - r.len()]; v.push((t, c, full)); b = r; }
    v
}

fn serial_de_cert(der: &[u8]) -> Option<Vec<u8>> {
    let (_, cert, _) = tlv(der)?;
    let (_, tbs, _) = tlv(cert)?;
    let mut h = hijos(tbs);
    if h.first().map(|x| x.0) == Some(0xA0) { h.remove(0); }
    h.first().filter(|x| x.0 == 0x02).map(|x| x.1.to_vec())
}

pub fn analizar_cms(cms: &[u8]) -> Option<Cms> {
    let (_, ci, _) = tlv(cms)?;
    let h = hijos(ci);
    let (_, sd, _) = tlv(h.get(1)?.1)?;
    let sh = elementos(sd);
    let mut certs = vec![];
    for (t, c, _) in sh.iter().skip(3) { if *t == 0xA0 { for (_, _, full) in elementos(c) { certs.push(full.to_vec()); } } }
    let signer_infos = sh.last().filter(|x| x.0 == 0x31)?.1;
    let (_, si, _) = tlv(signer_infos)?;
    let s = elementos(si);
    let sid = hijos(s.get(1)?.1);
    let serial = sid.get(1).filter(|x| x.0 == 0x02).map(|x| x.1.to_vec());
    let hash_oid = hijos(s.get(2)?.1).first().filter(|x| x.0 == 0x06)?.1.to_vec();
    let firmante = serial.and_then(|se| certs.iter().find(|c| serial_de_cert(c).as_deref() == Some(&se)).cloned()).or_else(|| certs.first().cloned());
    let (mut digest, mut fecha) = (None, None);
    if let Some((0xA0, attrs, _)) = s.get(3) {
        for (_, a) in hijos(attrs) {
            let hh = hijos(a);
            if hh.len() < 2 { continue; }
            let oid = hh[0].1;
            if let Some((t, val, _)) = tlv(hh[1].1) {
                if oid == [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x04] { digest = Some(val.to_vec()); }
                if oid == [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x05] { fecha = Some((t, val.to_vec())); }
            }
        }
    }
    Some(Cms { certs, firmante, hash_oid, digest_firmado: digest, fecha })
}

/// Segundos Unix de un UTCTime/GeneralizedTime ("YYMMDDHHMMSSZ" / "YYYYMMDDHHMMSSZ").
pub fn unix_de_asn1(tag: u8, c: &[u8]) -> Option<i64> {
    let s = std::str::from_utf8(c).ok()?;
    let (a, r) = if tag == 0x17 { let yy: i64 = s.get(0..2)?.parse().ok()?; (if yy < 50 { 2000 + yy } else { 1900 + yy }, s.get(2..)?) } else { (s.get(0..4)?.parse().ok()?, s.get(4..)?) };
    let n = |i: usize| -> Option<i64> { r.get(i..i + 2)?.parse().ok() };
    let (m, d, h, mi) = (n(0)?, n(2)?, n(4).unwrap_or(0), n(6).unwrap_or(0));
    let se = n(8).unwrap_or(0);
    let y = if m <= 2 { a - 1 } else { a };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let dias = era * 146097 + doe - 719468;
    Some(dias * 86400 + h * 3600 + mi * 60 + se)
}

fn texto_fecha(u: i64) -> String {
    let t = crate::firma::hora_local(u, 0);
    format!("{:02}/{:02}/{:04} {:02}:{:02} UTC", t.d, t.m, t.a, t.h, t.mi)
}

// ───── Windows ─────
#[derive(Default, Clone, Debug)]
pub struct Veredicto { pub firma_ok: bool, pub error_cadena: u32, pub cadena_construida: bool }

#[cfg(any(windows, capi_check))]
pub fn verificar_windows(cms: &[u8], datos: &[u8], certs: &[Vec<u8>], unix: Option<i64>, revocacion: bool) -> Result<Veredicto, String> {
    crate::firma::capi::verificar(cms, datos, certs, unix, revocacion)
}
#[cfg(not(any(windows, capi_check)))]
pub fn verificar_windows(_: &[u8], _: &[u8], _: &[Vec<u8>], _: Option<i64>, _: bool) -> Result<Veredicto, String> {
    Err("La verificación de certificados solo está disponible en Windows.".into())
}

pub fn interpretar_cadena(err: u32, revocacion: bool, r: &mut ResultadoValidacion) {
    const NO_VALIDO_TIEMPO: u32 = 0x1; const REVOCADO: u32 = 0x4; const FIRMA_CADENA: u32 = 0x8;
    const RAIZ_NO_CONFIABLE: u32 = 0x20; const REV_DESCONOCIDA: u32 = 0x40; const PARCIAL: u32 = 0x10000; const OFFLINE: u32 = 0x1000000;
    r.cadena = "confiable".into();
    if err & PARCIAL != 0 { r.cadena = "parcial".into(); r.detalles.push("No se pudo completar la cadena de certificados (falta algún certificado intermedio).".into()); }
    if err & RAIZ_NO_CONFIABLE != 0 { r.cadena = "no_confiable".into(); r.detalles.push("La autoridad que emitió el certificado no está entre las de confianza de este equipo.".into()); }
    if err & FIRMA_CADENA != 0 { r.cadena = "no_confiable".into(); r.detalles.push("Algún certificado de la cadena tiene una firma incorrecta.".into()); }
    if err & NO_VALIDO_TIEMPO != 0 { r.detalles.push("El certificado no estaba vigente en la fecha de la firma.".into()); r.nivel = "error".into(); }
    if revocacion {
        r.revocacion = if err & REVOCADO != 0 { "revocado".into() } else if err & (REV_DESCONOCIDA | OFFLINE) != 0 { "desconocida".into() } else { "ok".into() };
        match r.revocacion.as_str() {
            "revocado" => r.detalles.push("El certificado está REVOCADO.".into()),
            "desconocida" => r.detalles.push("No se pudo comprobar si el certificado está revocado (¿sin conexión o servidor bloqueado?).".into()),
            _ => {}
        }
    }
}

pub fn validar_pdf(bytes: &[u8], revocacion: bool) -> Vec<ResultadoValidacion> {
    let firmas = extraer_firmas(bytes);
    let n = firmas.len();
    let mut out = vec![];
    for (i, f) in firmas.iter().enumerate() {
        let mut r = ResultadoValidacion { indice: i as u32 + 1, integridad: "no_verificable".into(), firma: "no_comprobada".into(), cadena: "no_comprobada".into(), revocacion: "no_comprobada".into(), nivel: "ok".into(), ..Default::default() };
        r.cubre_todo = f.rango[2] + f.rango[3] >= (bytes.len() as u64).saturating_sub(4);
        let Some(c) = analizar_cms(&f.cms) else {
            r.nivel = "error".into(); r.resumen = "Firma ilegible o con un formato no reconocido.".into(); out.push(r); continue;
        };
        let info: Option<CertInfo> = c.firmante.as_deref().and_then(info_de_der);
        if let Some(inf) = &info { r.nombre = inf.nombre.clone(); r.nif = inf.nif.clone(); r.emisor = inf.emisor.clone(); r.caduca = inf.caduca.clone(); }
        let mut unix = c.fecha.as_ref().and_then(|(t, v)| unix_de_asn1(*t, v));
        r.ltv = bytes.windows(4).any(|w| w == b"/DSS") && (bytes.windows(6).any(|w| w == b"/OCSPs") || bytes.windows(5).any(|w| w == b"/CRLs"));
        if let Some(tok) = crate::ltv::token_sello(&f.cms) {
            if let Some((u, h)) = crate::ltv::info_sello(&tok) {
                r.sello_tiempo = texto_fecha(u);
                r.sello_coincide = crate::ltv::valor_firma(&f.cms).map(|v| Sha256::digest(&v).to_vec() == h).unwrap_or(false);
                if r.sello_coincide { unix = Some(u); } else { r.detalles.push("El sello de tiempo NO corresponde a esta firma.".into()); }
            }
        }
        r.fecha_firma = match (&c.fecha, unix) { (Some((t, v)), Some(u)) => { let _ = (t, v); texto_fecha(u) } _ => String::new() };
        // Integridad
        match (&c.digest_firmado, resumen_hash(&c.hash_oid, &f.datos)) {
            (Some(a), Some(b)) => { r.integridad = if *a == b { "ok".into() } else { "modificado".into() }; }
            (None, _) => r.detalles.push("La firma no incluye atributos firmados; no se puede comprobar la integridad por este método.".into()),
            (_, None) => r.detalles.push("Algoritmo de resumen no reconocido.".into()),
        }
        // Windows: firma + cadena
        if r.integridad != "modificado" {
            crate::registrar_error("TRAZA", &format!("firma {}: comprobando con Windows (cms {} B, datos {} B, {} certs)", i + 1, f.cms.len(), f.datos.len(), c.certs.len()));
            let veredicto = verificar_windows(&f.cms, &f.datos, &c.certs, unix, revocacion);
            crate::registrar_error("TRAZA", &format!("firma {}: Windows respondió", i + 1));
            match veredicto {
                Ok(v) => {
                    r.firma = if v.firma_ok { "ok".into() } else { "invalida".into() };
                    if v.firma_ok { interpretar_cadena(v.error_cadena, revocacion, &mut r); }
                }
                Err(e) => r.detalles.push(e),
            }
        }
        // Resumen y nivel
        let ultima = i + 1 == n;
        if r.integridad == "modificado" || r.firma == "invalida" {
            r.nivel = "error".into();
            r.resumen = "NO VÁLIDA: el documento se modificó después de firmarlo o la firma está dañada.".into();
        } else if r.nivel == "error" {
            r.resumen = "Firma íntegra, pero el certificado no era válido en la fecha de la firma.".into();
        } else if r.revocacion == "revocado" {
            r.nivel = "error".into(); r.resumen = "Firma íntegra, pero el certificado está revocado.".into();
        } else if r.firma == "ok" && r.cadena == "confiable" && r.revocacion != "desconocida" {
            r.resumen = if r.revocacion == "ok" { "VÁLIDA: íntegra, firmante de confianza y certificado no revocado.".into() } else { "VÁLIDA: íntegra y firmante de confianza (revocación no comprobada).".into() };
        } else if r.firma == "ok" {
            r.nivel = "aviso".into();
            r.resumen = match (r.cadena.as_str(), r.revocacion.as_str()) {
                ("no_confiable", _) => "Íntegra, pero el emisor del certificado no es de confianza en este equipo.".into(),
                ("parcial", _) => "Íntegra, pero no se pudo completar la cadena de certificados.".into(),
                (_, "desconocida") => "Íntegra y de confianza, pero no se pudo comprobar la revocación.".into(),
                _ => "Íntegra, con avisos.".into(),
            };
        } else if r.integridad == "ok" {
            r.nivel = "aviso".into();
            r.resumen = "Íntegra: el contenido no ha cambiado desde la firma. La verificación del certificado solo se puede hacer en Windows.".into();
        } else { r.nivel = "aviso".into(); r.resumen = "No se pudo comprobar la firma.".into(); }
        if !r.sello_tiempo.is_empty() && r.sello_coincide { r.detalles.push(format!("Sello de tiempo del {} (se comprueba que corresponde a la firma; no se valida el certificado de la TSA).", r.sello_tiempo)); }
        if r.ltv { r.detalles.push("El PDF incluye datos de validación a largo plazo (certificados y revocación).".into()); }
        if !ultima && r.nivel != "error" { r.detalles.push("Hay firmas posteriores: es normal, cada firma cubre hasta su momento.".into()); }
        if ultima && !r.cubre_todo {
            let resto = &bytes[((f.rango[2] + f.rango[3]) as usize).min(bytes.len())..];
            let contiene = |t: &[u8]| resto.windows(t.len()).any(|w| w == t);
            let solo_validacion = r.ltv && !["/Annots", "/Subtype/Widget", "/Subtype/Stamp", "/Subtype /Widget", "/Contents", "/MediaBox", "/Type/Page"].iter().any(|t| contiene(t.as_bytes()));
            if solo_validacion { r.detalles.push("Después de la firma solo se añadieron datos de validación (DSS): es lo normal en una firma de larga duración.".into()); }
            else { r.nivel = if r.nivel == "error" { "error".into() } else { "aviso".into() }; r.detalles.push("Hay contenido añadido después de esta firma (cambios posteriores).".into()); }
            if solo_validacion { r.cubre_todo = true; }
        }
        if let Some(inf) = &info { if inf.caducado { r.detalles.push(format!("El certificado caducó el {} (puede ser normal si la firma es anterior).", inf.caduca)); } }
        let _ = (atr, atributos, fecha_asn1);
        out.push(r);
    }
    out
}

#[cfg(test)]
mod pruebas {
    use super::*;
    #[test]
    fn sha1_vector() {
        let h: String = sha1(b"abc").iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(h, "a9993e364706816aba3e25717850c26c9cd0d89d");
    }
    #[test]
    fn valida_firmas_de_prueba() {
        let dir = std::env::var("FIRMA_DIR").unwrap_or("/tmp/firma_test".into());
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = e.path();
            let n = p.file_name().unwrap().to_string_lossy().to_string();
            if !n.starts_with("out_") || !n.ends_with(".pdf") { continue; }
            let b = std::fs::read(&p).unwrap();
            let r = validar_pdf(&b, false);
            eprintln!("{n}: {:?}", r.iter().map(|x| (&x.integridad, &x.nombre, &x.fecha_firma, &x.resumen)).collect::<Vec<_>>());
            assert!(!r.is_empty());
            assert!(r.iter().all(|x| x.integridad == "ok"));
            // alterar un byte dentro de lo firmado → debe detectarse
            let mut m = b.clone(); m[20] ^= 0x01;
            let r2 = validar_pdf(&m, false);
            assert!(r2.iter().any(|x| x.integridad == "modificado"), "no detectó la modificación en {n}");
        }
    }
}
