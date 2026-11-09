//! Firma de larga duración (PAdES-B-T / B-LT):
//! - Sello de tiempo RFC 3161: se pide a una TSA el sello del valor de la firma y se incrusta como
//!   atributo no firmado del CMS (no invalida la firma: /Contents queda fuera del ByteRange).
//! - Datos de validación (DSS): cadena de certificados + respuestas OCSP / CRL, guardados en el PDF
//!   como una actualización incremental posterior (no invalida ninguna firma).
//! Necesita conexión a internet en el momento de completar la firma.

use crate::firma::{ensamblar, ser_dic, ultimo_startxref, Nuevos};
use crate::validar::{analizar_cms, extraer_firmas, sha1_pub, unix_de_asn1, Cms};
use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const TSA_POR_DEFECTO: &str = "http://timestamp.digicert.com";

// ───────────────────────────── HTTP ─────────────────────────────

pub trait Http {
    fn get(&self, url: &str) -> Result<Vec<u8>, String>;
    fn post(&self, url: &str, tipo: &str, cuerpo: &[u8]) -> Result<Vec<u8>, String>;
}

/// Cliente del sistema: WinHTTP en Windows (usa el proxy configurado en el equipo) y curl en el resto.
pub fn http_sistema() -> Box<dyn Http> {
    #[cfg(any(windows, capi_check))]
    { Box::new(winhttp::WinHttp) }
    #[cfg(not(any(windows, capi_check)))]
    { Box::new(Curl) }
}

#[cfg(not(any(windows, capi_check)))]
pub struct Curl;
#[cfg(not(any(windows, capi_check)))]
impl Http for Curl {
    fn get(&self, url: &str) -> Result<Vec<u8>, String> {
        let o = std::process::Command::new("curl").args(["-sS", "-L", "--fail", "--max-time", "20", url]).output().map_err(|e| format!("curl: {e}"))?;
        if o.status.success() { Ok(o.stdout) } else { Err(format!("No se pudo descargar {url}: {}", String::from_utf8_lossy(&o.stderr).trim())) }
    }
    fn post(&self, url: &str, tipo: &str, cuerpo: &[u8]) -> Result<Vec<u8>, String> {
        use std::io::Write;
        let mut h = std::process::Command::new("curl")
            .args(["-sS", "--fail", "--max-time", "20", "-H", &format!("Content-Type: {tipo}"), "--data-binary", "@-", url])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|e| format!("curl: {e}"))?;
        h.stdin.take().unwrap().write_all(cuerpo).map_err(|e| e.to_string())?;
        let o = h.wait_with_output().map_err(|e| e.to_string())?;
        if o.status.success() { Ok(o.stdout) } else { Err(format!("No se pudo contactar con {url}: {}", String::from_utf8_lossy(&o.stderr).trim())) }
    }
}

#[cfg(any(windows, capi_check))]
mod winhttp {
    use super::Http;
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    type H = *mut c_void;
    #[link(name = "winhttp")]
    extern "system" {
        fn WinHttpOpen(agente: *const u16, tipo: u32, proxy: *const u16, bypass: *const u16, flags: u32) -> H;
        fn WinHttpSetTimeouts(h: H, resolver: i32, conectar: i32, enviar: i32, recibir: i32) -> i32;
        fn WinHttpConnect(s: H, host: *const u16, puerto: u16, reservado: u32) -> H;
        fn WinHttpOpenRequest(c: H, verbo: *const u16, ruta: *const u16, version: *const u16, referer: *const u16, aceptar: *const *const u16, flags: u32) -> H;
        fn WinHttpSendRequest(r: H, cabeceras: *const u16, long_cab: u32, datos: *const c_void, long_datos: u32, total: u32, ctx: usize) -> i32;
        fn WinHttpReceiveResponse(r: H, reservado: *mut c_void) -> i32;
        fn WinHttpQueryHeaders(r: H, nivel: u32, nombre: *const u16, buf: *mut c_void, long: *mut u32, indice: *mut u32) -> i32;
        fn WinHttpReadData(r: H, buf: *mut c_void, largo: u32, leidos: *mut u32) -> i32;
        fn WinHttpCloseHandle(h: H) -> i32;
    }

    fn w(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }

    /// (https, host, puerto, ruta)
    pub fn partir_url(url: &str) -> Result<(bool, String, u16, String), String> {
        let (https, resto) = if let Some(r) = url.strip_prefix("https://") { (true, r) } else if let Some(r) = url.strip_prefix("http://") { (false, r) } else { return Err(format!("URL no válida: {url}")) };
        let (hostport, ruta) = match resto.find('/') { Some(p) => (&resto[..p], &resto[p..]), None => (resto, "/") };
        let (host, puerto) = match hostport.rsplit_once(':') { Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => (h.to_string(), p.parse().unwrap_or(80)), _ => (hostport.to_string(), if https { 443 } else { 80 }) };
        Ok((https, host, puerto, ruta.to_string()))
    }

    pub struct WinHttp;
    impl WinHttp {
        fn peticion(&self, verbo: &str, url: &str, tipo: Option<&str>, cuerpo: &[u8]) -> Result<Vec<u8>, String> {
            let (https, host, puerto, ruta) = partir_url(url)?;
            unsafe {
                let agente = w("PDFTool");
                // 4 = proxy automático del sistema (Windows 8.1+); si falla, 0 = proxy por defecto
                let mut ses = WinHttpOpen(agente.as_ptr(), 4, null(), null(), 0);
                if ses.is_null() { ses = WinHttpOpen(agente.as_ptr(), 0, null(), null(), 0); }
                if ses.is_null() { return Err("No se pudo iniciar la conexión de red.".into()); }
                WinHttpSetTimeouts(ses, 10000, 10000, 20000, 20000);
                let con = WinHttpConnect(ses, w(&host).as_ptr(), puerto, 0);
                if con.is_null() { WinHttpCloseHandle(ses); return Err(format!("No se pudo conectar con {host}.")); }
                let req = WinHttpOpenRequest(con, w(verbo).as_ptr(), w(&ruta).as_ptr(), null(), null(), null(), if https { 0x0080_0000 } else { 0 });
                if req.is_null() { WinHttpCloseHandle(con); WinHttpCloseHandle(ses); return Err("No se pudo preparar la petición.".into()); }
                let cab = tipo.map(|t| w(&format!("Content-Type: {t}")));
                let (pc, lc) = match &cab { Some(c) => (c.as_ptr(), u32::MAX), None => (null(), 0) };
                let ok = WinHttpSendRequest(req, pc, lc, if cuerpo.is_empty() { null() } else { cuerpo.as_ptr() as *const c_void }, cuerpo.len() as u32, cuerpo.len() as u32, 0) != 0
                    && WinHttpReceiveResponse(req, null_mut()) != 0;
                let resultado = if !ok { Err(format!("Sin respuesta de {host} (¿sin conexión, proxy o servidor bloqueado?).")) } else {
                    let mut estado = 0u32; let mut n = 4u32;
                    WinHttpQueryHeaders(req, 19 | 0x2000_0000, null(), &mut estado as *mut u32 as *mut c_void, &mut n, null_mut());
                    let mut datos = vec![];
                    let mut buf = vec![0u8; 16384];
                    loop {
                        let mut leidos = 0u32;
                        if WinHttpReadData(req, buf.as_mut_ptr() as *mut c_void, buf.len() as u32, &mut leidos) == 0 || leidos == 0 { break; }
                        datos.extend(&buf[..leidos as usize]);
                        if datos.len() > 20_000_000 { break; }
                    }
                    if estado == 200 { Ok(datos) } else if estado == 407 { Err(format!("El proxy de red exige autenticación (HTTP 407) para llegar a {host}.")) } else { Err(format!("{host} respondió HTTP {estado}.")) }
                };
                WinHttpCloseHandle(req); WinHttpCloseHandle(con); WinHttpCloseHandle(ses);
                resultado
            }
        }
    }
    impl Http for WinHttp {
        fn get(&self, url: &str) -> Result<Vec<u8>, String> { self.peticion("GET", url, None, &[]) }
        fn post(&self, url: &str, tipo: &str, cuerpo: &[u8]) -> Result<Vec<u8>, String> { self.peticion("POST", url, Some(tipo), cuerpo) }
    }
}

// ───────────────────────────── DER ─────────────────────────────

fn der(tag: u8, c: &[u8]) -> Vec<u8> {
    let mut v = vec![tag];
    if c.len() < 128 { v.push(c.len() as u8); } else {
        let b = (c.len() as u64).to_be_bytes();
        let b: Vec<u8> = b.iter().copied().skip_while(|x| *x == 0).collect();
        v.push(0x80 | b.len() as u8); v.extend(b);
    }
    v.extend(c);
    v
}
fn cat(partes: &[&[u8]]) -> Vec<u8> { partes.concat() }

fn elementos(mut b: &[u8]) -> Vec<(u8, &[u8], &[u8])> {
    let mut v = vec![];
    while let Some((t, c, r)) = crate::firma::tlv(b) { let full = &b[..b.len() - r.len()]; v.push((t, c, full)); b = r; }
    v
}

const OID_SHA256: &[u8] = &[0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const OID_SELLO_ATTR: [u8; 11] = [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x10, 0x02, 0x0E];

// ───────────────────────────── Sello de tiempo ─────────────────────────────

pub fn peticion_sello(hash: &[u8], nonce: u64) -> Vec<u8> {
    let imprint = der(0x30, &cat(&[&der(0x30, &cat(&[OID_SHA256, &der(0x05, &[])])), &der(0x04, hash)]));
    let n = (nonce & 0x7FFF_FFFF_FFFF_FFFF).to_be_bytes();
    let mut nb: Vec<u8> = n.iter().copied().skip_while(|x| *x == 0).collect();
    if nb.is_empty() { nb.push(1); }
    if nb[0] & 0x80 != 0 { nb.insert(0, 0); }
    der(0x30, &cat(&[&der(0x02, &[1]), &imprint, &der(0x02, &nb), &der(0x01, &[0xFF])]))
}

/// Devuelve el token (ContentInfo DER) de una respuesta TimeStampResp.
pub fn token_de_respuesta(resp: &[u8]) -> Result<Vec<u8>, String> {
    let (_, c, _) = crate::firma::tlv(resp).ok_or("Respuesta de la TSA ilegible")?;
    let el = elementos(c);
    let estado = el.first().ok_or("Respuesta de la TSA vacía")?;
    let st = elementos(estado.1).first().map(|x| x.1.to_vec()).unwrap_or_default();
    let codigo = st.last().copied().unwrap_or(255);
    if codigo > 1 { return Err(format!("La TSA rechazó la petición (estado {codigo}).")); }
    Ok(el.get(1).ok_or("La TSA no devolvió sello")?.2.to_vec())
}

/// (hora Unix, hash sellado) de un token de sello de tiempo.
pub fn info_sello(token: &[u8]) -> Option<(i64, Vec<u8>)> {
    let (_, ci, _) = crate::firma::tlv(token)?;
    let h = elementos(ci);
    let (_, sd, _) = crate::firma::tlv(h.get(1)?.1)?;
    let sh = elementos(sd);
    let encap = elementos(sh.get(2)?.1);
    let (_, oct, _) = crate::firma::tlv(encap.get(1)?.1)?;
    let (_, tst, _) = crate::firma::tlv(oct)?;
    let t = elementos(tst);
    // version, policy, messageImprint, serial, genTime
    let imprint = elementos(t.get(2)?.1);
    let hash = imprint.get(1)?.1.to_vec();
    let gen = t.get(4)?;
    Some((unix_de_asn1(gen.0, gen.1)?, hash))
}

/// Añade un atributo no firmado (unsignedAttrs) al primer SignerInfo.
pub fn anadir_atributo_no_firmado(cms: &[u8], atributo: &[u8]) -> Option<Vec<u8>> {
    let (t0, ci, _) = crate::firma::tlv(cms)?;
    let el = elementos(ci);
    if el.len() < 2 { return None; }
    let (ta, a0c, _) = crate::firma::tlv(el[1].2)?;
    let (ts, sd, _) = crate::firma::tlv(a0c)?;
    let sel = elementos(sd);
    let ult = sel.last().filter(|x| x.0 == 0x31)?;
    let prefijo_sd = &sd[..sd.len() - ult.2.len()];
    let (_, signers, _) = crate::firma::tlv(ult.2)?;
    let (tsi, si, resto) = crate::firma::tlv(signers)?;
    let ies = elementos(si);
    let nuevo_si = match ies.last() {
        Some((0xA1, c, full)) => {
            let prefijo = &si[..si.len() - full.len()];
            cat(&[prefijo, &der(0xA1, &cat(&[c, atributo]))])
        }
        _ => cat(&[si, &der(0xA1, atributo)]),
    };
    let nuevo_signers = cat(&[&der(tsi, &nuevo_si), resto]);
    let nuevo_sd = cat(&[prefijo_sd, &der(0x31, &nuevo_signers)]);
    let nuevo_a0 = der(ta, &der(ts, &nuevo_sd));
    Some(der(t0, &cat(&[el[0].2, &nuevo_a0])))
}

pub fn pedir_sello(http: &dyn Http, tsa: &str, valor_firma: &[u8]) -> Result<Vec<u8>, String> {
    let hash = Sha256::digest(valor_firma).to_vec();
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
    let resp = http.post(tsa, "application/timestamp-query", &peticion_sello(&hash, nonce))?;
    let token = token_de_respuesta(&resp)?;
    match info_sello(&token) {
        Some((_, h)) if h == hash => Ok(token),
        Some(_) => Err("La TSA devolvió un sello que no corresponde a esta firma.".into()),
        None => Err("El sello recibido no se puede leer.".into()),
    }
}

// ───────────────────────────── Certificados y revocación ─────────────────────────────

pub struct CertX {
    pub der: Vec<u8>,
    pub issuer: Vec<u8>,
    pub subject: Vec<u8>,
    pub clave: Vec<u8>,       // contenido del BIT STRING de la clave pública (sin el byte de bits sobrantes)
    pub serial: Vec<u8>,      // INTEGER tal cual (contenido)
    pub ocsp: Vec<String>,
    pub ca_issuers: Vec<String>,
    pub crl: Vec<String>,
}

fn uris(b: &[u8], out: &mut Vec<String>) {
    for (t, c, _) in elementos(b) {
        if t == 0x86 { out.push(String::from_utf8_lossy(c).into_owned()); }
        else if t & 0x20 != 0 { uris(c, out); }
    }
}

pub fn leer_cert(der_cert: &[u8]) -> Option<CertX> {
    let (_, cert, _) = crate::firma::tlv(der_cert)?;
    let (_, tbs, _) = crate::firma::tlv(cert)?;
    let mut e = elementos(tbs);
    if e.first().map(|x| x.0) == Some(0xA0) { e.remove(0); }
    if e.len() < 6 { return None; }
    let serial = e[0].1.to_vec();
    let issuer = e[2].2.to_vec();
    let subject = e[4].2.to_vec();
    let spki = elementos(e[5].1);
    let bits = spki.get(1)?.1;
    let clave = bits.get(1..)?.to_vec();
    let (mut ocsp, mut ca, mut crl) = (vec![], vec![], vec![]);
    if let Some(ext) = e.iter().skip(6).find(|x| x.0 == 0xA3) {
        let (_, lista, _) = crate::firma::tlv(ext.1)?;
        for (_, x, _) in elementos(lista) {
            let ie = elementos(x);
            let Some(oid) = ie.first() else { continue };
            let valor = match ie.last() { Some((0x04, v, _)) => *v, _ => continue };
            if oid.1 == [0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x01] {
                if let Some((_, aia, _)) = crate::firma::tlv(valor) {
                    for (_, ad, _) in elementos(aia) {
                        let p = elementos(ad);
                        if p.len() == 2 && p[1].0 == 0x86 {
                            let u = String::from_utf8_lossy(p[1].1).into_owned();
                            if p[0].1 == [0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01] { ocsp.push(u); }
                            else if p[0].1 == [0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x02] { ca.push(u); }
                        }
                    }
                }
            } else if oid.1 == [0x55, 0x1D, 0x1F] { uris(valor, &mut crl); }
        }
    }
    Some(CertX { der: der_cert.to_vec(), issuer, subject, clave, serial, ocsp, ca_issuers: ca, crl })
}

pub fn peticion_ocsp(c: &CertX, emisor: &CertX) -> Vec<u8> {
    let sha1_oid = [0x06, 0x05, 0x2B, 0x0E, 0x03, 0x02, 0x1A];
    let cert_id = der(0x30, &cat(&[
        &der(0x30, &cat(&[&sha1_oid, &der(0x05, &[])])),
        &der(0x04, &sha1_pub(&emisor.subject)),
        &der(0x04, &sha1_pub(&emisor.clave)),
        &der(0x02, &c.serial),
    ]));
    der(0x30, &der(0x30, &der(0x30, &der(0x30, &cert_id))))
}

/// ¿Es una respuesta OCSP correcta (status 0 con responseBytes)?
fn ocsp_valida(r: &[u8]) -> bool {
    let Some((_, c, _)) = crate::firma::tlv(r) else { return false };
    let e = elementos(c);
    e.len() >= 2 && e[0].0 == 0x0A && e[0].1 == [0] && e[1].0 == 0xA0
}

pub struct DatosValidacion { pub certs: Vec<Vec<u8>>, pub ocsps: Vec<Vec<u8>>, pub crls: Vec<Vec<u8>>, pub avisos: Vec<String> }

fn certs_de_cms(cms: &[u8]) -> Vec<Vec<u8>> { analizar_cms(cms).map(|c: Cms| c.certs).unwrap_or_default() }

fn certs_de_descarga(d: &[u8]) -> Vec<Vec<u8>> {
    if leer_cert(d).is_some() { return vec![d.to_vec()]; }
    certs_de_cms(d) // .p7c / PKCS#7 con certificados
}

/// Reúne la cadena completa de `inicio` y su revocación (OCSP, o CRL si no hay OCSP).
pub fn recopilar(http: &dyn Http, inicio: &[Vec<u8>], conocidos: &[Vec<u8>], datos: &mut DatosValidacion) {
    let mut pool: Vec<CertX> = inicio.iter().chain(conocidos.iter()).filter_map(|d| leer_cert(d)).collect();
    let Some(hoja) = inicio.first().and_then(|d| leer_cert(d)) else { datos.avisos.push("No se encontró el certificado del firmante.".into()); return };
    let mut cadena: Vec<usize> = vec![];
    let mut actual = pool.iter().position(|c| c.der == hoja.der).unwrap_or(0);
    cadena.push(actual);
    for _ in 0..8 {
        let (issuer, subject, urls) = { let c = &pool[actual]; (c.issuer.clone(), c.subject.clone(), c.ca_issuers.clone()) };
        if issuer == subject { break; }
        let mut pos = pool.iter().position(|c| c.subject == issuer);
        if pos.is_none() {
            for u in urls {
                match http.get(&u) {
                    Ok(d) => for nd in certs_de_descarga(&d) { if let Some(x) = leer_cert(&nd) { pool.push(x); } },
                    Err(e) => datos.avisos.push(format!("No se pudo descargar el certificado del emisor: {e}")),
                }
                pos = pool.iter().position(|c| c.subject == issuer);
                if pos.is_some() { break; }
            }
        }
        match pos { Some(p) => { cadena.push(p); actual = p; } None => { datos.avisos.push("No se encontró el certificado del emisor; la cadena queda incompleta.".into()); break; } }
    }
    for (n, &i) in cadena.iter().enumerate() {
        if !datos.certs.contains(&pool[i].der) { datos.certs.push(pool[i].der.clone()); }
        let Some(&e) = cadena.get(n + 1) else { continue }; // la raíz no se revoca
        let (c, emisor) = (&pool[i], &pool[e]);
        let mut hecho = false;
        for u in &c.ocsp {
            match http.post(u, "application/ocsp-request", &peticion_ocsp(c, emisor)) {
                Ok(r) if ocsp_valida(&r) => { if !datos.ocsps.contains(&r) { datos.ocsps.push(r); } hecho = true; break; }
                Ok(_) => datos.avisos.push(format!("Respuesta OCSP no válida de {u}")),
                Err(er) => datos.avisos.push(format!("OCSP: {er}")),
            }
        }
        if !hecho {
            for u in &c.crl {
                if !u.starts_with("http") { continue; }
                match http.get(u) {
                    Ok(r) if r.len() < 8_000_000 => { if !datos.crls.contains(&r) { datos.crls.push(r); } hecho = true; break; }
                    Ok(_) => datos.avisos.push("CRL demasiado grande; omitida.".into()),
                    Err(er) => datos.avisos.push(format!("CRL: {er}")),
                }
            }
        }
        if !hecho { datos.avisos.push(format!("Sin datos de revocación para un certificado de la cadena (OCSP/CRL no disponibles).")); }
    }
}

// ───────────────────────────── DSS en el PDF ─────────────────────────────

fn stream_obj(d: &[u8]) -> Vec<u8> {
    let mut v = format!("<</Length {}>>\nstream\n", d.len()).into_bytes();
    v.extend(d); v.extend(b"\nendstream"); v
}

pub fn escribir_dss(bytes: &[u8], v: &DatosValidacion) -> Result<Vec<u8>, String> {
    let doc = Document::load_mem(bytes).map_err(|e| format!("PDF no válido: {e}"))?;
    let prev = ultimo_startxref(bytes).ok_or("No se encontró startxref")?;
    let prev_flujo = bytes.get(prev..prev + 4).map(|s| s != b"xref").unwrap_or(true);
    let raiz: ObjectId = doc.trailer.get(b"Root").and_then(|o| o.as_reference()).map_err(|_| "PDF sin catálogo")?;
    let size = match doc.trailer.get(b"Size") { Ok(Object::Integer(i)) => *i as u32, _ => 0 };
    let mut nuevos = Nuevos::new(size.max(doc.max_id + 1));
    let cat = doc.get_object(raiz).and_then(|o| o.as_dict().cloned()).map_err(|_| "Catálogo ilegible")?;

    // DSS existente: se conservan sus entradas
    let (mut dss, dss_id) = match cat.get(b"DSS").ok() {
        Some(Object::Reference(r)) => (doc.get_object(*r).and_then(|o| o.as_dict().cloned()).unwrap_or_default(), Some(*r)),
        Some(Object::Dictionary(d)) => (d.clone(), None),
        _ => (Dictionary::new(), None),
    };
    let mut anadir = |clave: &str, lista: &[Vec<u8>], nuevos: &mut Nuevos| {
        let mut arr: Vec<Object> = match dss.get(clave.as_bytes()).ok() {
            Some(Object::Array(a)) => a.clone(),
            Some(Object::Reference(r)) => doc.get_object(*r).and_then(|o| o.as_array().cloned()).unwrap_or_default(),
            _ => vec![],
        };
        for d in lista { let id = nuevos.id(); nuevos.poner(id, 0, stream_obj(d)); arr.push(Object::Reference((id, 0))); }
        if !arr.is_empty() { dss.set(clave, Object::Array(arr)); }
    };
    anadir("Certs", &v.certs, &mut nuevos);
    anadir("OCSPs", &v.ocsps, &mut nuevos);
    anadir("CRLs", &v.crls, &mut nuevos);
    dss.set("Type", Object::Name(b"DSS".to_vec()));
    let did = match dss_id { Some(r) => r, None => (nuevos.id(), 0) };
    let mut cuerpo = vec![]; ser_dic(&dss, &mut cuerpo);
    nuevos.poner(did.0, did.1, cuerpo);
    let mut c2 = cat.clone();
    c2.set("DSS", Object::Reference(did));
    let mut cb = vec![]; ser_dic(&c2, &mut cb);
    nuevos.poner(raiz.0, raiz.1, cb);

    let mut out = bytes.to_vec();
    if out.last() != Some(&b'\n') { out.push(b'\n'); }
    ensamblar(&mut out, &doc, &nuevos, raiz, prev, prev_flujo);
    Ok(out)
}

// ───────────────────────────── Orquestación ─────────────────────────────

#[derive(Serialize, Default, Debug)]
pub struct Informe { pub sello: bool, pub dss: bool, pub avisos: Vec<String> }

/// nivel: "tiempo" (solo sello de tiempo), "ltv" (solo datos de validación, sin sello) o "ltv_sello" (ambos).
pub fn completar_bytes(mut bytes: Vec<u8>, nivel: &str, tsa: &str, http: &dyn Http) -> Result<(Vec<u8>, Informe), String> {
    let mut inf = Informe::default();
    let firmas = extraer_firmas(&bytes);
    let Some(ultima) = firmas.last() else { return Err("Este PDF no tiene firmas digitales.".into()) };

    // 1) Sello de tiempo (solo si se pide) sobre la ÚLTIMA firma (las anteriores quedan cubiertas por las posteriores)
    let quiere_sello = nivel == "tiempo" || nivel == "ltv_sello";
    let mut cms_final = ultima.cms.clone();
    if tiene_sello(&ultima.cms) { inf.sello = true; }
    else if quiere_sello {
        let valor = valor_firma(&ultima.cms).ok_or("No se pudo leer el valor de la firma")?;
        let token = pedir_sello(http, tsa, &valor)?;
        let attr = der(0x30, &cat(&[&der(0x06, &OID_SELLO_ATTR), &der(0x31, &token)]));
        let nuevo = anadir_atributo_no_firmado(&ultima.cms, &attr).ok_or("No se pudo incorporar el sello a la firma (formato no admitido).")?;
        let cap = (ultima.rango[2] - ultima.rango[1]) as usize - 2; // caracteres hexadecimales disponibles
        if nuevo.len() * 2 > cap { return Err("No hay espacio en la firma para incorporar el sello de tiempo.".into()); }
        let hex: String = nuevo.iter().map(|b| format!("{:02X}", b)).collect();
        let ini = ultima.rango[1] as usize + 1;
        bytes[ini..ini + hex.len()].copy_from_slice(hex.as_bytes());
        cms_final = nuevo; inf.sello = true;
    }

    // 2) Datos de validación (DSS)
    if nivel == "ltv" || nivel == "ltv_sello" {
        let mut datos = DatosValidacion { certs: vec![], ocsps: vec![], crls: vec![], avisos: vec![] };
        for f in &firmas {
            let cms = if std::ptr::eq(f, ultima) { &cms_final } else { &f.cms };
            let cc = analizar_cms(cms).ok_or("Firma ilegible")?;
            let inicio: Vec<Vec<u8>> = cc.firmante.clone().into_iter().collect();
            recopilar(http, &inicio, &cc.certs, &mut datos);
            // Cadena y revocación de la TSA que selló la firma
            if let Some(tok) = token_sello(cms) {
                let tc = certs_de_cms(&tok);
                if let Some(primero) = tc.first() { recopilar(http, &[firmante_de_token(&tok, &tc).unwrap_or_else(|| primero.clone())], &tc, &mut datos); }
            }
        }
        let n_antes = datos.certs.len() + datos.ocsps.len() + datos.crls.len();
        if n_antes == 0 { return Err(format!("No se pudo reunir ningún dato de validación. {}", datos.avisos.join(" "))); }
        bytes = escribir_dss(&bytes, &datos)?;
        inf.dss = true;
        inf.avisos = datos.avisos;
        if datos.ocsps.is_empty() && datos.crls.is_empty() { inf.avisos.push("El PDF no contiene ninguna respuesta de revocación: no será verificable a largo plazo.".into()); }
    }
    Ok((bytes, inf))
}

fn firmante_de_token(token: &[u8], certs: &[Vec<u8>]) -> Option<Vec<u8>> {
    analizar_cms(token).and_then(|c| c.firmante).or_else(|| certs.first().cloned())
}

pub fn completar_pdf(entrada: &str, salida: &str, nivel: &str, tsa: &str, http: &dyn Http) -> Result<Informe, String> {
    let b = std::fs::read(entrada).map_err(|e| format!("No se pudo leer el PDF: {e}"))?;
    let (nuevo, inf) = completar_bytes(b, nivel, tsa, http)?;
    std::fs::write(salida, nuevo).map_err(|e| format!("No se pudo guardar: {e}"))?;
    Ok(inf)
}

// Utilidades sobre el CMS (valor de la firma y sello existente)
pub fn valor_firma(cms: &[u8]) -> Option<Vec<u8>> { campos_firmante(cms).map(|(v, _)| v) }
pub fn token_sello(cms: &[u8]) -> Option<Vec<u8>> { campos_firmante(cms).and_then(|(_, t)| t) }
pub fn tiene_sello(cms: &[u8]) -> bool { token_sello(cms).is_some() }

fn campos_firmante(cms: &[u8]) -> Option<(Vec<u8>, Option<Vec<u8>>)> {
    let (_, ci, _) = crate::firma::tlv(cms)?;
    let h = elementos(ci);
    let (_, sd, _) = crate::firma::tlv(h.get(1)?.1)?;
    let sel = elementos(sd);
    let signers = sel.last().filter(|x| x.0 == 0x31)?.1;
    let (_, si, _) = crate::firma::tlv(signers)?;
    let s = elementos(si);
    let mut k = 3;
    if s.get(k)?.0 == 0xA0 { k += 1; }
    let firma = s.get(k + 1).filter(|x| x.0 == 0x04)?.1.to_vec();
    let mut token = None;
    if let Some((0xA1, attrs, _)) = s.get(k + 2) {
        for (_, a, _) in elementos(attrs) {
            let p = elementos(a);
            if p.len() == 2 && p[0].1 == OID_SELLO_ATTR { token = elementos(p[1].1).first().map(|x| x.2.to_vec()); }
        }
    }
    Some((firma, token))
}

#[cfg(test)]
mod pruebas {
    use super::*;
    use crate::firma::{firmar_pdf, info_de_der, Firmante, Opciones};
    use std::process::Command;

    struct OpenSsl { cert: String, clave: String }
    impl Firmante for OpenSsl {
        fn firmar(&self, datos: &[u8]) -> Result<Vec<u8>, String> {
            let d = std::env::temp_dir().join(format!("ltv_{}", std::process::id()));
            std::fs::write(&d, datos).unwrap();
            let o = Command::new("openssl").args(["cms", "-sign", "-binary", "-in", d.to_str().unwrap(), "-signer", &self.cert, "-inkey", &self.clave, "-outform", "DER", "-md", "sha256"]).output().unwrap();
            if !o.status.success() { return Err(String::from_utf8_lossy(&o.stderr).into()); }
            Ok(o.stdout)
        }
    }

    #[test]
    fn der_longitudes() {
        assert_eq!(der(0x04, &[1, 2]), vec![4, 2, 1, 2]);
        assert_eq!(der(0x04, &vec![0; 200])[..3], [4, 0x81, 200]);
        assert_eq!(der(0x04, &vec![0; 300])[..4], [4, 0x82, 1, 44]);
    }

    #[test]
    fn ltv_local() {
        let dir = std::env::var("LTV_DIR").unwrap_or("/tmp/ltv_test".into());
        let cert = format!("{dir}/cert.pem");
        if !std::path::Path::new(&format!("{dir}/a.pdf")).exists() || std::process::Command::new("curl").args(["-s", "-o", "/dev/null", "http://127.0.0.1:8883"]).status().map(|s| !s.success()).unwrap_or(true) { eprintln!("sin entorno local de pruebas"); return; }
        let der_c = Command::new("openssl").args(["x509", "-in", &cert, "-outform", "DER"]).output().unwrap().stdout;
        let id = info_de_der(&der_c).unwrap();
        let op = Opciones { cert_origen: "pfx".into(), cert_id: "".into(), pfx_ruta: None, pfx_clave: None, criptografica: true, visual: true,
            rect: [0.5, 0.8, 0.4, 0.1], paginas: "1".into(), fecha: true, razon: None, lugar: None, desfase_min: 60, nivel: None, tsa_url: None };
        let f = OpenSsl { cert, clave: format!("{dir}/key.pem") };
        firmar_pdf(&format!("{dir}/a.pdf"), &format!("{dir}/firmado.pdf"), &op, &id, Some(&f)).unwrap();
        let http = http_sistema();
        let inf = completar_pdf(&format!("{dir}/firmado.pdf"), &format!("{dir}/final.pdf"), "ltv_sello", "http://127.0.0.1:8883", http.as_ref()).unwrap();
        eprintln!("{:?}", inf);
        assert!(inf.sello && inf.dss);
        let b = std::fs::read(format!("{dir}/final.pdf")).unwrap();
        let r = crate::validar::validar_pdf(&b, false);
        eprintln!("{:?}", r.iter().map(|x| (&x.integridad, &x.sello_tiempo, x.sello_coincide, x.ltv, &x.detalles)).collect::<Vec<_>>());
        assert!(r[0].integridad == "ok" && r[0].sello_coincide && r[0].ltv);
    }
}

#[cfg(test)]
mod pruebas_extra {
    use super::*;
    #[test]
    fn ltv_repetido() {
        let dir = std::env::var("LTV_DIR").unwrap_or("/tmp/ltv_test".into());
        if !std::path::Path::new(&format!("{dir}/pasada1.pdf")).exists() || std::process::Command::new("curl").args(["-s", "-o", "/dev/null", "http://127.0.0.1:8883"]).status().map(|s| !s.success()).unwrap_or(true) { return; }
        let http = http_sistema();
        let inf = completar_pdf(&format!("{dir}/pasada1.pdf"), &format!("{dir}/pasada2.pdf"), "ltv_sello", "http://127.0.0.1:8883", http.as_ref()).unwrap();
        eprintln!("{:?}", inf);
        let b = std::fs::read(format!("{dir}/pasada2.pdf")).unwrap();
        let r = crate::validar::validar_pdf(&b, false);
        assert!(r[0].integridad == "ok" && r[0].ltv);
        // LTV sin sello de tiempo: no debe contactar con ninguna TSA
        let (b3, inf3) = completar_bytes(std::fs::read(format!("{dir}/firmado.pdf")).unwrap(), "ltv", "http://127.0.0.1:9", http.as_ref()).unwrap();
        assert!(inf3.dss && !inf3.sello);
        std::fs::write(format!("{dir}/solo_dss.pdf"), &b3).unwrap();
        let r3 = crate::validar::validar_pdf(&b3, false);
        assert!(r3[0].integridad == "ok" && r3[0].ltv && r3[0].sello_tiempo.is_empty());
        // sin firmas → error claro
        let e = completar_bytes(std::fs::read(format!("{dir}/a.pdf")).unwrap(), "ltv", "x", http.as_ref());
        assert!(e.is_err());
        // TSA inaccesible → error claro y sin tocar nada
        let e = completar_bytes(std::fs::read(format!("{dir}/firmado.pdf")).unwrap(), "tiempo", "http://127.0.0.1:9", http.as_ref());
        eprintln!("{:?}", e.as_ref().err());
        assert!(e.is_err());
    }
}
