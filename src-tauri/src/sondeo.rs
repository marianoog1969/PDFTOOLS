//! ¿Entiende PDF esta impresora? Se le pregunta por la red, sin pasar por el proxy del sistema:
//!  1. **IPP** (puerto 631): `Get-Printer-Attributes` → `document-format-supported` (lista de tipos MIME).
//!  2. **SNMP v1** (puerto 161, comunidad «public»): tabla `prtInterpreterTable` del Printer-MIB (RFC 3805),
//!     lenguajes de impresión que lleva instalados (PCL, PostScript, PDF…).
//! Solo usa la biblioteca estándar, con tiempos de espera cortos.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::time::Duration;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Sondeo {
    /// "si" | "no" | "desconocido"
    pub estado: String,
    /// Explicación para el usuario
    pub detalle: String,
    /// "IPP" | "SNMP" | ""
    pub via: String,
    /// Lenguajes o formatos que dice admitir (para mostrarlos)
    pub lenguajes: Vec<String>,
    /// Dirección consultada (si se conoce)
    pub direccion: String,
    /// No se pudo averiguar la dirección de la impresora: hay que pedírsela al usuario
    pub pide_direccion: bool,
}

impl Sondeo {
    pub fn desconocido(detalle: impl Into<String>, direccion: &str) -> Self {
        Sondeo { estado: "desconocido".into(), detalle: detalle.into(), via: String::new(), lenguajes: vec![], direccion: direccion.into(), pide_direccion: false }
    }
}

const ESPERA: Duration = Duration::from_millis(2500);

/// Rutas IPP habituales: IPP Everywhere / HP / Brother / Canon / Xerox («/ipp/print»), HP antiguas y Kyocera («/ipp»),
/// Ricoh («/printer») y genérica («/»).
pub const RUTAS_IPP: &[&str] = &["/ipp/print", "/ipp", "/printer", "/"];

fn resolver(host: &str, puerto: u16) -> Result<SocketAddr, String> {
    (host, puerto).to_socket_addrs().map_err(|e| format!("no se encuentra «{host}» en la red ({e})"))?
        .next().ok_or_else(|| format!("no se encuentra «{host}» en la red"))
}

// ═══════════════════════════════ IPP ═══════════════════════════════

/// Petición IPP 1.1 Get-Printer-Attributes pidiendo solo `document-format-supported`.
pub fn peticion_ipp(uri: &str) -> Vec<u8> {
    let mut v = vec![0x01, 0x01, 0x00, 0x0B, 0x00, 0x00, 0x00, 0x01, 0x01];
    let mut atributo = |etiqueta: u8, nombre: &str, valor: &str| {
        v.push(etiqueta);
        v.extend_from_slice(&(nombre.len() as u16).to_be_bytes()); v.extend_from_slice(nombre.as_bytes());
        v.extend_from_slice(&(valor.len() as u16).to_be_bytes()); v.extend_from_slice(valor.as_bytes());
    };
    atributo(0x47, "attributes-charset", "utf-8");
    atributo(0x48, "attributes-natural-language", "es");
    atributo(0x45, "printer-uri", uri);
    atributo(0x44, "requested-attributes", "document-format-supported");
    v.push(0x03);
    v
}

/// Extrae los valores de `document-format-supported` de una respuesta IPP.
pub fn formatos_de_respuesta_ipp(r: &[u8]) -> Result<Vec<String>, String> {
    if r.len() < 9 { return Err("respuesta IPP demasiado corta".into()); }
    let estado = u16::from_be_bytes([r[2], r[3]]);
    if estado >= 0x0100 { return Err(format!("la impresora respondió con el error IPP 0x{estado:04X}")); }
    let mut i = 8; let mut nombre_actual = String::new(); let mut formatos = vec![];
    while i < r.len() {
        let etiqueta = r[i]; i += 1;
        if etiqueta == 0x03 { break; }
        if etiqueta < 0x10 { continue; } // inicio de un grupo de atributos
        if i + 2 > r.len() { break; }
        let ln = u16::from_be_bytes([r[i], r[i + 1]]) as usize; i += 2;
        if i + ln + 2 > r.len() { break; }
        if ln > 0 { nombre_actual = String::from_utf8_lossy(&r[i..i + ln]).into_owned(); }
        i += ln;
        let lv = u16::from_be_bytes([r[i], r[i + 1]]) as usize; i += 2;
        if i + lv > r.len() { break; }
        if nombre_actual == "document-format-supported" { formatos.push(String::from_utf8_lossy(&r[i..i + lv]).to_lowercase()); }
        i += lv;
    }
    Ok(formatos)
}

/// Quita la cabecera HTTP y deshace la codificación «chunked» si la hay.
pub fn cuerpo_http(resp: &[u8]) -> Result<Vec<u8>, String> {
    let fin = resp.windows(4).position(|w| w == b"\r\n\r\n").ok_or("respuesta HTTP incompleta")?;
    let cab = String::from_utf8_lossy(&resp[..fin]).to_lowercase();
    let linea = cab.lines().next().unwrap_or("");
    if !linea.contains(" 200") { return Err(format!("el servidor IPP respondió «{}»", linea.trim())); }
    let cuerpo = &resp[fin + 4..];
    if !cab.contains("transfer-encoding: chunked") { return Ok(cuerpo.to_vec()); }
    let (mut out, mut i) = (vec![], 0usize);
    loop {
        let fl = cuerpo[i..].windows(2).position(|w| w == b"\r\n").ok_or("bloque HTTP incompleto")?;
        let tam = usize::from_str_radix(String::from_utf8_lossy(&cuerpo[i..i + fl]).split(';').next().unwrap_or("").trim(), 16).map_err(|_| "bloque HTTP no válido")?;
        i += fl + 2;
        if tam == 0 { break; }
        if i + tam > cuerpo.len() { return Err("bloque HTTP incompleto".into()); }
        out.extend_from_slice(&cuerpo[i..i + tam]); i += tam + 2;
    }
    Ok(out)
}

/// Pregunta por IPP qué formatos admite la impresora. Prueba las rutas habituales.
pub fn ipp_formatos(host: &str, puerto: u16, rutas: &[&str]) -> Result<Vec<String>, String> {
    let dir = resolver(host, puerto)?;
    let mut ultimo = String::from("sin respuesta");
    for ruta in rutas {
        let uri = format!("ipp://{host}:{puerto}{ruta}");
        let cuerpo = peticion_ipp(&uri);
        let r = (|| -> Result<Vec<String>, String> {
            let mut s = TcpStream::connect_timeout(&dir, ESPERA).map_err(|e| format!("no responde en el puerto {puerto} ({e})"))?;
            s.set_read_timeout(Some(ESPERA)).ok(); s.set_write_timeout(Some(ESPERA)).ok();
            let cab = format!("POST {ruta} HTTP/1.1\r\nHost: {host}:{puerto}\r\nContent-Type: application/ipp\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", cuerpo.len());
            s.write_all(cab.as_bytes()).and_then(|_| s.write_all(&cuerpo)).map_err(|e| e.to_string())?;
            let mut resp = vec![];
            let _ = s.read_to_end(&mut resp); // un corte por tiempo con datos ya leídos no es un error
            formatos_de_respuesta_ipp(&cuerpo_http(&resp)?)
        })();
        match r {
            Ok(f) if !f.is_empty() => return Ok(f),
            Ok(_) => ultimo = "no indica sus formatos".into(),
            Err(e) => { let sin_conexion = e.starts_with("no responde"); ultimo = e; if sin_conexion { break; } }
        }
    }
    Err(ultimo)
}

// ═══════════════════════════════ SNMP ═══════════════════════════════

/// prtInterpreterLangFamily y prtInterpreterDescription (Printer-MIB, RFC 3805)
pub const OID_FAMILIA: &[u32] = &[1, 3, 6, 1, 2, 1, 43, 15, 1, 1, 2];
pub const OID_DESCRIPCION: &[u32] = &[1, 3, 6, 1, 2, 1, 43, 15, 1, 1, 5];
/// langPDF en IANA-PRINTER-MIB (PrtInterpreterLangFamilyTC)
pub const LANG_PDF: i64 = 54;

pub fn nombre_lenguaje(f: i64) -> String {
    match f {
        3 => "PCL".into(), 5 => "PJL".into(), 6 => "PostScript".into(), 37 => "Automático".into(), 39 => "LIPS".into(),
        40 => "TIFF".into(), 46 => "XES".into(), 47 => "PCL XL".into(), 50 => "Prescribe".into(), 54 => "PDF".into(),
        55 => "RPDL".into(), 61 => "JPEG".into(), otro => format!("lenguaje {otro}"),
    }
}

fn ber_long(n: usize, v: &mut Vec<u8>) {
    if n < 0x80 { v.push(n as u8); } else if n < 0x100 { v.extend_from_slice(&[0x81, n as u8]); } else { v.extend_from_slice(&[0x82, (n >> 8) as u8, n as u8]); }
}
fn ber(etiqueta: u8, contenido: &[u8]) -> Vec<u8> { let mut v = vec![etiqueta]; ber_long(contenido.len(), &mut v); v.extend_from_slice(contenido); v }
fn ber_entero(n: i64) -> Vec<u8> {
    let mut b = n.to_be_bytes().to_vec();
    while b.len() > 1 && ((b[0] == 0 && b[1] & 0x80 == 0) || (b[0] == 0xFF && b[1] & 0x80 != 0)) { b.remove(0); }
    ber(0x02, &b)
}
fn ber_oid(oid: &[u32]) -> Vec<u8> {
    let mut c = vec![(oid[0] * 40 + oid[1]) as u8];
    for &x in &oid[2..] {
        let mut t = vec![(x & 0x7F) as u8]; let mut y = x >> 7;
        while y > 0 { t.insert(0, (y & 0x7F) as u8 | 0x80); y >>= 7; }
        c.extend(t);
    }
    ber(0x06, &c)
}

/// SNMPv1 GetNextRequest para un OID.
pub fn peticion_snmp(oid: &[u32], id: i64, comunidad: &str) -> Vec<u8> {
    let varbind = ber(0x30, &[ber_oid(oid), vec![0x05, 0x00]].concat());
    let pdu = ber(0xA1, &[ber_entero(id), ber_entero(0), ber_entero(0), ber(0x30, &varbind)].concat());
    ber(0x30, &[ber_entero(0), ber(0x04, comunidad.as_bytes()), pdu].concat())
}

/// Lee un elemento BER: (etiqueta, contenido, resto).
fn leer_ber(d: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    if d.len() < 2 { return None; }
    let (et, l0) = (d[0], d[1] as usize);
    let (lon, ini) = if l0 < 0x80 { (l0, 2) } else {
        let n = l0 & 0x7F; if n == 0 || n > 3 || d.len() < 2 + n { return None; }
        (d[2..2 + n].iter().fold(0usize, |a, &b| (a << 8) | b as usize), 2 + n)
    };
    if d.len() < ini + lon { return None; }
    Some((et, &d[ini..ini + lon], &d[ini + lon..]))
}
fn decodificar_oid(c: &[u8]) -> Vec<u32> {
    if c.is_empty() { return vec![]; }
    let mut o = vec![(c[0] / 40) as u32, (c[0] % 40) as u32]; let mut x = 0u32;
    for &b in &c[1..] { x = (x << 7) | (b & 0x7F) as u32; if b & 0x80 == 0 { o.push(x); x = 0; } }
    o
}

#[derive(Debug, PartialEq)]
pub enum ValorSnmp { Entero(i64), Texto(String), Otro }

/// Respuesta SNMP → (OID devuelto, valor). `None` si no se entiende o trae error.
pub fn leer_respuesta_snmp(d: &[u8]) -> Option<(Vec<u32>, ValorSnmp)> {
    let (_, msg, _) = leer_ber(d)?;
    let (_, _, r) = leer_ber(msg)?;           // versión
    let (_, _, r) = leer_ber(r)?;             // comunidad
    let (et, pdu, _) = leer_ber(r)?;
    if et != 0xA2 { return None; }
    let (_, _, r) = leer_ber(pdu)?;           // request-id
    let (_, err, r) = leer_ber(r)?;           // error-status
    if err.iter().any(|&b| b != 0) { return None; }
    let (_, _, r) = leer_ber(r)?;             // error-index
    let (_, lista, _) = leer_ber(r)?;
    let (_, vb, _) = leer_ber(lista)?;
    let (_, oid, r) = leer_ber(vb)?;
    let (tv, val, _) = leer_ber(r)?;
    let v = match tv {
        0x02 => ValorSnmp::Entero(val.iter().fold(if val.first().is_some_and(|b| b & 0x80 != 0) { -1i64 } else { 0 }, |a, &b| (a << 8) | b as i64)),
        0x04 => ValorSnmp::Texto(String::from_utf8_lossy(val).trim_matches(char::from(0)).trim().to_string()),
        _ => ValorSnmp::Otro,
    };
    Some((decodificar_oid(oid), v))
}

/// Recorre una columna SNMP (como `snmpwalk`), con un máximo de filas.
pub fn snmp_columna(dir: SocketAddr, raiz: &[u32], comunidad: &str) -> Result<Vec<ValorSnmp>, String> {
    let s = UdpSocket::bind(if dir.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(ESPERA)).ok();
    let (mut oid, mut out) = (raiz.to_vec(), vec![]);
    for id in 1..=24 {
        s.send_to(&peticion_snmp(&oid, id, comunidad), dir).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 1500];
        let n = s.recv(&mut buf).map_err(|_| "no responde por SNMP".to_string())?;
        let Some((o, v)) = leer_respuesta_snmp(&buf[..n]) else { break };
        if !o.starts_with(raiz) || o <= oid { break; }
        out.push(v); oid = o;
    }
    Ok(out)
}

pub fn snmp_lenguajes(host: &str, puerto: u16) -> Result<(Vec<i64>, Vec<String>), String> {
    let dir = resolver(host, puerto)?;
    let familias: Vec<i64> = snmp_columna(dir, OID_FAMILIA, "public")?.into_iter().filter_map(|v| if let ValorSnmp::Entero(n) = v { Some(n) } else { None }).collect();
    let desc: Vec<String> = snmp_columna(dir, OID_DESCRIPCION, "public").unwrap_or_default().into_iter().filter_map(|v| if let ValorSnmp::Texto(t) = v { Some(t) } else { None }).filter(|t| !t.is_empty()).collect();
    Ok((familias, desc))
}

// ═══════════════════════════════ CONCLUSIÓN ═══════════════════════════════

/// Pregunta a la impresora (primero IPP, después SNMP) y saca una conclusión.
pub fn sondear(host: &str, ipp_puerto: u16, ipp_rutas: &[&str], snmp_puerto: u16) -> Sondeo {
    let ipp = ipp_formatos(host, ipp_puerto, ipp_rutas);
    if let Ok(f) = &ipp {
        let pdf = f.iter().any(|x| x == "application/pdf");
        let mostrar: Vec<String> = f.iter().filter(|x| *x != "application/octet-stream").cloned().collect();
        return Sondeo {
            estado: if pdf { "si" } else { "no" }.into(),
            detalle: if pdf { "La impresora indica que acepta PDF directamente.".into() }
                     else { format!("La impresora indica que no acepta PDF. Formatos que admite: {}.", if mostrar.is_empty() { "ninguno conocido".into() } else { mostrar.join(", ") }) },
            via: "IPP".into(), lenguajes: mostrar, direccion: host.into(), pide_direccion: false,
        };
    }
    match snmp_lenguajes(host, snmp_puerto) {
        Ok((fam, desc)) if !fam.is_empty() || !desc.is_empty() => {
            let pdf = fam.contains(&LANG_PDF) || desc.iter().any(|d| d.to_lowercase().contains("pdf"));
            let mut nombres: Vec<String> = fam.iter().map(|&f| nombre_lenguaje(f)).collect();
            nombres.dedup();
            Sondeo {
                estado: if pdf { "si" } else { "no" }.into(),
                detalle: if pdf { "La impresora indica que lleva intérprete de PDF.".into() }
                         else { format!("La impresora indica que no lleva intérprete de PDF. Lenguajes instalados: {}.", nombres.join(", ")) },
                via: "SNMP".into(), lenguajes: nombres, direccion: host.into(), pide_direccion: false,
            }
        }
        Ok(_) => Sondeo::desconocido("La impresora responde por SNMP pero no informa de sus lenguajes.", host),
        Err(e2) => Sondeo::desconocido(format!("La impresora no ha respondido a la consulta (IPP: {}; SNMP: {e2}). Puede estar apagada, en otra red o con estos servicios desactivados.", ipp.err().unwrap_or_default()), host),
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    /// Respuesta IPP con los formatos indicados (un valor por atributo «adicional»).
    fn respuesta_ipp(formatos: &[&str]) -> Vec<u8> {
        let mut v = vec![0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01];
        let mut at = |n: &str, val: &str| { v.push(0x49); v.extend((n.len() as u16).to_be_bytes()); v.extend(n.as_bytes()); v.extend((val.len() as u16).to_be_bytes()); v.extend(val.as_bytes()); };
        at("attributes-charset", "utf-8");
        v.push(0x04);
        for (k, f) in formatos.iter().enumerate() {
            let mut v2 = vec![0x49u8];
            let n = if k == 0 { "document-format-supported" } else { "" };
            v2.extend((n.len() as u16).to_be_bytes()); v2.extend(n.as_bytes()); v2.extend((f.len() as u16).to_be_bytes()); v2.extend(f.as_bytes());
            v.extend(v2);
        }
        v.push(0x03);
        v
    }

    fn servidor_ipp(cuerpo: Vec<u8>, chunked: bool) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap(); let p = l.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 4096]; let _ = s.read(&mut buf);
                let r = if chunked {
                    let (a, b) = cuerpo.split_at(cuerpo.len() / 2);
                    [format!("HTTP/1.1 200 OK\r\nContent-Type: application/ipp\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n", a.len()).into_bytes(), a.to_vec(), format!("\r\n{:x}\r\n", b.len()).into_bytes(), b.to_vec(), b"\r\n0\r\n\r\n".to_vec()].concat()
                } else { [format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", cuerpo.len()).into_bytes(), cuerpo].concat() };
                let _ = s.write_all(&r);
            }
        });
        p
    }

    /// Agente SNMP falso que responde la columna de lenguajes con las familias dadas.
    fn agente_snmp(familias: Vec<i64>) -> u16 {
        let s = UdpSocket::bind("127.0.0.1:0").unwrap(); let p = s.local_addr().unwrap().port();
        thread::spawn(move || {
            let mut buf = [0u8; 1500];
            for _ in 0..60 {
                let Ok((n, de)) = s.recv_from(&mut buf) else { return };
                // OID pedido = el de la petición; se responde con la fila siguiente
                let (_, msg, _) = leer_ber(&buf[..n]).unwrap(); let (_, _, r) = leer_ber(msg).unwrap(); let (_, _, r) = leer_ber(r).unwrap();
                let (_, pdu, _) = leer_ber(r).unwrap(); let (_, idb, r) = leer_ber(pdu).unwrap(); let (_, _, r) = leer_ber(r).unwrap(); let (_, _, r) = leer_ber(r).unwrap();
                let (_, lista, _) = leer_ber(r).unwrap(); let (_, vb, _) = leer_ber(lista).unwrap(); let (_, oidb, _) = leer_ber(vb).unwrap();
                let pedido = decodificar_oid(oidb);
                let (col, valor): (Vec<u32>, Vec<u8>) = if pedido.starts_with(OID_FAMILIA) || pedido == OID_FAMILIA {
                    let fila = if pedido.len() > OID_FAMILIA.len() { pedido[OID_FAMILIA.len() + 1] + 1 } else { 1 };
                    if (fila as usize) <= familias.len() { ([OID_FAMILIA, &[1, fila]].concat(), ber_entero(familias[fila as usize - 1])) }
                    else { ([1, 3, 6, 1, 2, 1, 43, 15, 1, 1, 3, 1, 1].to_vec(), ber_entero(0)) }
                } else { ([1, 3, 6, 1, 2, 1, 43, 15, 1, 1, 6, 1, 1].to_vec(), ber(0x04, b"x")) };
                let vb = ber(0x30, &[ber_oid(&col), valor].concat());
                let id = idb.iter().fold(0i64, |a, &b| (a << 8) | b as i64);
                let pdu = ber(0xA2, &[ber_entero(id), ber_entero(0), ber_entero(0), ber(0x30, &vb)].concat());
                let resp = ber(0x30, &[ber_entero(0), ber(0x04, b"public"), pdu].concat());
                let _ = s.send_to(&resp, de);
            }
        });
        p
    }

    fn puerto_cerrado() -> u16 { let l = TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() }

    #[test]
    fn peticion_ipp_bien_formada() {
        let p = peticion_ipp("ipp://10.0.0.5:631/ipp/print");
        assert_eq!(&p[..9], &[1, 1, 0, 0x0B, 0, 0, 0, 1, 1]);
        assert_eq!(*p.last().unwrap(), 0x03);
        assert!(p.windows(25).any(|w| w == b"document-format-supported"));
    }

    #[test]
    fn ipp_con_pdf() {
        let p = servidor_ipp(respuesta_ipp(&["application/octet-stream", "application/PDF", "image/jpeg"]), false);
        let s = sondear("127.0.0.1", p, &["/ipp/print"], puerto_cerrado());
        assert_eq!((s.estado.as_str(), s.via.as_str()), ("si", "IPP"));
        assert_eq!(s.lenguajes, vec!["application/pdf", "image/jpeg"]);
    }

    #[test]
    fn ipp_sin_pdf_y_chunked() {
        let p = servidor_ipp(respuesta_ipp(&["application/octet-stream", "application/vnd.hp-pcl", "application/postscript"]), true);
        let s = sondear("127.0.0.1", p, &["/ipp/print"], puerto_cerrado());
        assert_eq!(s.estado, "no");
        assert!(s.detalle.contains("application/postscript"));
    }

    #[test]
    fn snmp_cuando_no_hay_ipp() {
        let snmp = agente_snmp(vec![5, 47, 6, LANG_PDF]);
        let s = sondear("127.0.0.1", puerto_cerrado(), &["/ipp/print"], snmp);
        assert_eq!((s.estado.as_str(), s.via.as_str()), ("si", "SNMP"));
        assert_eq!(s.lenguajes, vec!["PJL", "PCL XL", "PostScript", "PDF"]);
    }

    #[test]
    fn snmp_sin_pdf() {
        let snmp = agente_snmp(vec![5, 3, 47]);
        let s = sondear("127.0.0.1", puerto_cerrado(), &["/ipp/print"], snmp);
        assert_eq!(s.estado, "no");
        assert!(s.detalle.contains("PCL, PCL XL"), "{}", s.detalle);
    }

    #[test]
    fn nadie_responde() {
        let mudo = UdpSocket::bind("127.0.0.1:0").unwrap();
        let s = sondear("127.0.0.1", puerto_cerrado(), &["/ipp/print"], mudo.local_addr().unwrap().port());
        assert_eq!(s.estado, "desconocido");
        assert!(s.detalle.contains("no ha respondido"));
    }

    #[test]
    fn direcciones() {
        assert_eq!(interpretar_direccion("10.0.0.5"), Some(("10.0.0.5".into(), 631, None)));
        assert_eq!(interpretar_direccion(" impresora.cis.local:8631 "), Some(("impresora.cis.local".into(), 8631, None)));
        assert_eq!(interpretar_direccion("http://10.0.0.5:631/ipp/print"), Some(("10.0.0.5".into(), 631, Some("/ipp/print".into()))));
        assert_eq!(interpretar_direccion("http://10.0.0.5/"), Some(("10.0.0.5".into(), 631, None)));
        assert_eq!(interpretar_direccion("https://10.0.0.5:443/ipp"), Some(("10.0.0.5".into(), 631, Some("/ipp".into()))));
        assert_eq!(interpretar_direccion(""), None);
        assert_eq!(interpretar_direccion("no vale"), None);
    }

    #[test]
    fn enteros_y_oid_ber() {
        assert_eq!(ber_entero(0), vec![2, 1, 0]);
        assert_eq!(ber_entero(128), vec![2, 2, 0, 128]);
        assert_eq!(ber_entero(-1), vec![2, 1, 0xFF]);
        assert_eq!(decodificar_oid(&ber_oid(OID_FAMILIA)[2..]), OID_FAMILIA);
        assert_eq!(decodificar_oid(&ber_oid(&[1, 3, 6, 1, 4, 1, 300000])[2..]), vec![1, 3, 6, 1, 4, 1, 300000]);
    }
}

/// «10.0.0.5», «impresora.cis.local:8631», «http://10.0.0.5:631/ipp/print» → (host, puerto IPP, ruta IPP preferida)
pub fn interpretar_direccion(d: &str) -> Option<(String, u16, Option<String>)> {
    let d = d.trim();
    if d.is_empty() { return None; }
    let sin_esquema = d.split_once("://").map(|(_, r)| r).unwrap_or(d);
    let (hostport, ruta) = match sin_esquema.find('/') { Some(i) => (&sin_esquema[..i], Some(sin_esquema[i..].to_string()).filter(|r| r.len() > 1)), None => (sin_esquema, None) };
    let (host, puerto) = match hostport.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (h.to_string(), p.parse::<u16>().ok()?),
        _ => (hostport.trim_start_matches('[').trim_end_matches(']').to_string(), 631),
    };
    if host.is_empty() || host.contains(char::is_whitespace) { return None; }
    // un puerto 80/443 en una URL de Windows suele ser la web de la impresora; IPP va por el 631
    let puerto = if d.starts_with("http") && (puerto == 80 || puerto == 443) { 631 } else { puerto };
    Some((host, puerto, ruta))
}

/// Sondeo a partir de una dirección escrita o averiguada.
pub fn sondear_direccion(d: &str) -> Sondeo {
    match interpretar_direccion(d) {
        None => Sondeo { pide_direccion: true, ..Sondeo::desconocido(format!("«{d}» no parece una dirección válida. Escribe la IP de la impresora, por ejemplo 10.20.1.45."), d) },
        Some((host, puerto, ruta)) => {
            let mut rutas: Vec<&str> = vec![];
            if let Some(r) = ruta.as_deref() { rutas.push(r); }
            rutas.extend(RUTAS_IPP.iter().copied().filter(|x| Some(*x) != ruta.as_deref()));
            sondear(&host, puerto, &rutas, 161)
        }
    }
}
