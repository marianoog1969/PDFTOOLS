//! Anotaciones (texto y resaltado) "aplanadas" sobre el contenido de la página con lopdf.
//! Las coordenadas llegan normalizadas (0..1) respecto a la página TAL COMO SE VE
//! (ya con /Rotate y /CropBox aplicados, igual que la dibuja Ghostscript en el visor).

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;

#[derive(Deserialize, Clone, Debug)]
pub struct Anotacion {
    pub pagina: u32,
    pub tipo: String,          // "texto" | "resaltado"
    pub x: f64, pub y: f64,    // esquina superior izquierda (fracción de ancho / alto visibles)
    pub w: f64, pub h: f64,    // solo resaltado
    pub texto: Option<String>,
    pub tam: Option<f64>,      // texto: alto de fuente como fracción del ANCHO visible
    pub color: [f64; 3],
}

fn num(o: &Object) -> Option<f64> {
    match o { Object::Integer(i) => Some(*i as f64), Object::Real(r) => Some(*r as f64), _ => None }
}

fn resolver<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    if let Object::Reference(id) = o { doc.get_object(*id).unwrap_or(o) } else { o }
}

/// Busca una clave en la página o en sus ancestros (atributos heredables).
pub(crate) fn heredado(doc: &Document, page: ObjectId, clave: &[u8]) -> Option<Object> {
    let mut id = page;
    for _ in 0..32 {
        let d = doc.get_object(id).ok()?.as_dict().ok()?;
        if let Ok(v) = d.get(clave) { return Some(resolver(doc, v).clone()); }
        id = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

pub(crate) fn caja(doc: &Document, page: ObjectId) -> [f64; 4] {
    for clave in [&b"CropBox"[..], &b"MediaBox"[..]] {
        if let Some(Object::Array(a)) = heredado(doc, page, clave) {
            let v: Vec<f64> = a.iter().filter_map(|o| num(resolver(doc, o))).collect();
            if v.len() == 4 {
                return [v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])];
            }
        }
    }
    [0.0, 0.0, 595.0, 842.0]
}

pub(crate) fn rotacion(doc: &Document, page: ObjectId) -> i64 {
    match heredado(doc, page, b"Rotate") {
        Some(Object::Integer(r)) => ((r % 360) + 360) % 360,
        _ => 0,
    }
}

/// Codifica a WinAnsi (Windows-1252) como cadena hexadecimal PDF.
pub(crate) fn winansi_hex(t: &str) -> String {
    let mut s = String::from("<");
    for c in t.chars() {
        let b: u8 = match c {
            '€' => 0x80, '‚' => 0x82, '„' => 0x84, '…' => 0x85, '‘' => 0x91, '’' => 0x92,
            '“' => 0x93, '”' => 0x94, '•' => 0x95, '–' => 0x96, '—' => 0x97,
            c if (c as u32) < 256 => c as u32 as u8,
            _ => b'?',
        };
        s.push_str(&format!("{:02X}", b));
    }
    s.push('>');
    s
}

fn f(n: f64) -> String { format!("{:.3}", n) }

pub fn aplicar(entrada: &str, salida: &str, anotaciones: &[Anotacion]) -> Result<(), String> {
    let mut doc = Document::load(entrada).map_err(|e| format!("Error al abrir el PDF: {}", e))?;
    let paginas = doc.get_pages();

    let mut por_pagina: std::collections::BTreeMap<u32, Vec<&Anotacion>> = Default::default();
    for a in anotaciones { por_pagina.entry(a.pagina).or_default().push(a); }

    for (num_pag, lista) in por_pagina {
        let page_id = *paginas.get(&num_pag).ok_or_else(|| format!("La página {} no existe", num_pag))?;
        let [x0, y0, x1, y1] = caja(&doc, page_id);
        let (w, h) = (x1 - x0, y1 - y0);
        let rot = rotacion(&doc, page_id);
        let (dw, dh) = if rot == 90 || rot == 270 { (h, w) } else { (w, h) };

        // (u, v) fracción visible desde arriba-izquierda → coordenadas del espacio de usuario
        let mapa = |u: f64, v: f64| -> (f64, f64) {
            let (a, b) = match rot {
                90 => (v, u),
                180 => (1.0 - u, v),
                270 => (1.0 - v, 1.0 - u),
                _ => (u, 1.0 - v),
            };
            (x0 + a * w, y0 + b * h)
        };

        let mut c = String::from("q\n");
        for an in lista {
            let [r, g, b] = an.color;
            if an.tipo == "resaltado" {
                let (pa, pb) = (mapa(an.x, an.y), mapa(an.x + an.w, an.y + an.h));
                let (rx, ry) = (pa.0.min(pb.0), pa.1.min(pb.1));
                let (rw, rh) = ((pa.0 - pb.0).abs(), (pa.1 - pb.1).abs());
                c.push_str(&format!("q /GSHL gs {} {} {} rg {} {} {} {} re f Q\n", f(r), f(g), f(b), f(rx), f(ry), f(rw), f(rh)));
            } else if an.tipo == "texto" {
                let texto = an.texto.clone().unwrap_or_default();
                let tam = (an.tam.unwrap_or(0.02) * dw).max(4.0);
                let ang = (rot as f64).to_radians();
                let (cs, sn) = (ang.cos(), ang.sin());
                for (i, linea) in texto.split('\n').enumerate() {
                    if linea.is_empty() { continue; }
                    // línea base a 0.85·tam bajo el borde superior; interlineado 1.2
                    let dv = (an.y * dh + tam * (0.85 + 1.2 * i as f64)) / dh;
                    let (px, py) = mapa(an.x, dv);
                    c.push_str(&format!(
                        "BT /FAnot {} Tf {} {} {} rg {} {} {} {} {} {} Tm {} Tj ET\n",
                        f(tam), f(r), f(g), f(b), f(cs), f(sn), f(-sn), f(cs), f(px), f(py), winansi_hex(linea)
                    ));
                }
            }
        }
        c.push_str("Q\n");

        // ── Recursos efectivos de la página (propios o heredados) + los nuestros ──
        let mut recursos = match heredado(&doc, page_id, b"Resources") {
            Some(Object::Dictionary(d)) => d,
            _ => Dictionary::new(),
        };
        let sub = |clave: &[u8], nombre: &[u8], valor: Object, recursos: &mut Dictionary, doc: &Document| {
            let mut d = match recursos.get(clave).ok().map(|o| resolver(doc, o).clone()) {
                Some(Object::Dictionary(d)) => d,
                _ => Dictionary::new(),
            };
            d.set(nombre.to_vec(), valor);
            recursos.set(clave.to_vec(), Object::Dictionary(d));
        };
        let mut fuente = Dictionary::new();
        fuente.set("Type", Object::Name(b"Font".to_vec()));
        fuente.set("Subtype", Object::Name(b"Type1".to_vec()));
        fuente.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
        fuente.set("Encoding", Object::Name(b"WinAnsiEncoding".to_vec()));
        let fuente_id = doc.add_object(Object::Dictionary(fuente));
        let mut gs = Dictionary::new();
        gs.set("Type", Object::Name(b"ExtGState".to_vec()));
        gs.set("BM", Object::Name(b"Multiply".to_vec()));
        gs.set("ca", Object::Real(1.0));
        gs.set("CA", Object::Real(1.0));
        sub(b"Font", b"FAnot", Object::Reference(fuente_id), &mut recursos, &doc);
        sub(b"ExtGState", b"GSHL", Object::Dictionary(gs), &mut recursos, &doc);

        // ── Contenido: q · original · Q · anotaciones ──
        let originales: Vec<Object> = {
            let p = doc.get_object(page_id).map_err(|e| e.to_string())?.as_dict().map_err(|e| e.to_string())?;
            match p.get(b"Contents") {
                Ok(Object::Array(a)) => a.clone(),
                Ok(Object::Reference(id)) => match doc.get_object(*id) {
                    Ok(Object::Array(a)) => a.clone(),
                    _ => vec![Object::Reference(*id)],
                },
                _ => vec![],
            }
        };
        let q_ini = doc.add_object(Stream::new(Dictionary::new(), b"q\n".to_vec()));
        let q_fin = doc.add_object(Stream::new(Dictionary::new(), b"\nQ\n".to_vec()));
        let nuestro = doc.add_object(Stream::new(Dictionary::new(), c.into_bytes()));
        let mut nuevo = vec![Object::Reference(q_ini)];
        nuevo.extend(originales);
        nuevo.push(Object::Reference(q_fin));
        nuevo.push(Object::Reference(nuestro));

        let p = doc.get_object_mut(page_id).map_err(|e| e.to_string())?.as_dict_mut().map_err(|e| e.to_string())?;
        p.set("Contents", Object::Array(nuevo));
        p.set("Resources", Object::Dictionary(recursos));
    }

    doc.save(salida).map_err(|e| format!("Error al guardar el PDF: {}", e))?;
    Ok(())
}

