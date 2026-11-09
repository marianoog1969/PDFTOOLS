//! Organizar páginas: reordenar, eliminar, rotar e insertar páginas en blanco con lopdf.

use crate::anotaciones::{caja, heredado, rotacion};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;

#[derive(Deserialize, Clone, Debug)]
pub struct PaginaOrg {
    #[serde(default)]
    pub fuente: Option<String>, // ruta de otro PDF del que se copia la página (None = el propio documento)
    pub origen: Option<u32>, // número de página original (1..n); None = página en blanco nueva
    pub rot: i64,            // grados a SUMAR a la rotación actual (múltiplo de 90)
}

pub fn aplicar(entrada: &str, salida: &str, paginas: &[PaginaOrg]) -> Result<(), String> {
    if paginas.is_empty() { return Err("No puede quedar un PDF sin páginas".into()); }
    let mut doc = Document::load(entrada).map_err(|e| format!("Error al abrir el PDF: {}", e))?;
    let mapa = doc.get_pages();

    // 0) Importar las páginas de otros PDF (fuentes externas): se renumeran sus objetos y se fusionan.
    let mut externas: std::collections::HashMap<String, std::collections::BTreeMap<u32, ObjectId>> = std::collections::HashMap::new();
    for p in paginas {
        if let Some(f) = &p.fuente {
            if externas.contains_key(f) { continue; }
            let mut otro = Document::load(f).map_err(|e| format!("Error al abrir {}: {}", f, e))?;
            otro.renumber_objects_with(doc.max_id + 1);
            doc.max_id = otro.max_id;
            let pags = otro.get_pages();
            // materializar atributos heredables antes de mover las páginas
            for (_, id) in pags.iter() {
                let mut nuevos: Vec<(&[u8], Object)> = Vec::new();
                for clave in [&b"MediaBox"[..], &b"CropBox"[..], &b"Resources"[..], &b"Rotate"[..]] {
                    let tiene = otro.get_object(*id).ok().and_then(|o| o.as_dict().ok()).map(|d| d.has(clave)).unwrap_or(false);
                    if !tiene { if let Some(v) = heredado(&otro, *id, clave) { nuevos.push((clave, v)); } }
                }
                if let Ok(Object::Dictionary(d)) = otro.get_object_mut(*id) { for (k, v) in nuevos { d.set(k.to_vec(), v); } }
            }
            for (id, obj) in otro.objects.into_iter() { doc.objects.insert(id, obj); }
            externas.insert(f.clone(), pags);
        }
    }

    let raiz_pages: ObjectId = doc.catalog().map_err(|e| e.to_string())?
        .get(b"Pages").map_err(|e| e.to_string())?
        .as_reference().map_err(|e| e.to_string())?;

    // 1) Materializar atributos heredables en cada página original (el árbol se va a aplanar)
    for (_, id) in mapa.iter() {
        let mut nuevos: Vec<(&[u8], Object)> = Vec::new();
        for clave in [&b"MediaBox"[..], &b"CropBox"[..], &b"Resources"[..], &b"Rotate"[..]] {
            let tiene = doc.get_object(*id).ok().and_then(|o| o.as_dict().ok()).map(|d| d.has(clave)).unwrap_or(false);
            if !tiene {
                if let Some(v) = heredado(&doc, *id, clave) { nuevos.push((clave, v)); }
            }
        }
        let d = doc.get_object_mut(*id).map_err(|e| e.to_string())?.as_dict_mut().map_err(|e| e.to_string())?;
        for (k, v) in nuevos { d.set(k.to_vec(), v); }
    }

    // 2) Construir la lista final de páginas
    let mut kids: Vec<Object> = Vec::with_capacity(paginas.len());
    let mut usadas: std::collections::HashMap<(Option<String>, u32), i64> = std::collections::HashMap::new();
    let mut ultimo_tam: (f64, f64) = (595.0, 842.0);
    for p in paginas {
        match p.origen {
            Some(n) => {
                let mut id = match &p.fuente {
                    Some(f) => *externas.get(f).and_then(|m| m.get(&n)).ok_or_else(|| format!("La página {} de {} no existe", n, f))?,
                    None => *mapa.get(&n).ok_or_else(|| format!("La página {} no existe", n))?,
                };
                let clave_pag = (p.fuente.clone(), n);
                let r = if let Some(r0) = usadas.get(&clave_pag).copied() {
                    // página repetida: se clona el diccionario (comparte contenido)
                    let copia = doc.get_object(id).map_err(|e| e.to_string())?.clone();
                    id = doc.add_object(copia);
                    r0
                } else {
                    let r0 = rotacion(&doc, id);
                    usadas.insert(clave_pag, r0);
                    r0
                };
                let [x0, y0, x1, y1] = caja(&doc, id);
                ultimo_tam = if r == 90 || r == 270 { (y1 - y0, x1 - x0) } else { (x1 - x0, y1 - y0) };
                let extra = ((p.rot % 360) + 360) % 360;
                let d = doc.get_object_mut(id).map_err(|e| e.to_string())?.as_dict_mut().map_err(|e| e.to_string())?;
                d.set("Parent", Object::Reference(raiz_pages));
                d.set("Rotate", Object::Integer(r % 360));
                if extra != 0 { d.set("Rotate", Object::Integer((r + extra) % 360)); }
                kids.push(Object::Reference(id));
            }
            None => {
                let mut d = Dictionary::new();
                d.set("Type", Object::Name(b"Page".to_vec()));
                d.set("Parent", Object::Reference(raiz_pages));
                d.set("MediaBox", Object::Array(vec![
                    Object::Integer(0), Object::Integer(0),
                    Object::Real(ultimo_tam.0 as f32), Object::Real(ultimo_tam.1 as f32),
                ]));
                d.set("Resources", Object::Dictionary(Dictionary::new()));
                let cont = doc.add_object(Stream::new(Dictionary::new(), Vec::new()));
                d.set("Contents", Object::Reference(cont));
                let id = doc.add_object(Object::Dictionary(d));
                kids.push(Object::Reference(id));
            }
        }
    }

    // 3) Aplanar el árbol: la raíz apunta directamente a las páginas
    let total = kids.len() as i64;
    let raiz = doc.get_object_mut(raiz_pages).map_err(|e| e.to_string())?.as_dict_mut().map_err(|e| e.to_string())?;
    raiz.set("Kids", Object::Array(kids));
    raiz.set("Count", Object::Integer(total));

    doc.prune_objects();
    doc.save(salida).map_err(|e| format!("Error al guardar el PDF: {}", e))?;
    Ok(())
}


#[cfg(test)]
mod pruebas {
    use super::*;
    #[test]
    fn copia_entre_documentos() {
        let base = "/tmp/claude-0/-home-claude/6d908815-9202-54c4-87a5-73b5dc677d28/scratchpad/work/";
        let a = format!("{}muestra.pdf", base);
        let b = format!("{}heic.pdf", base);
        let salida = "/tmp/mixto_test.pdf";
        let n = Document::load(&a).unwrap().get_pages().len() as u32;
        let mut pags: Vec<PaginaOrg> = (1..=n).map(|i| PaginaOrg { fuente: None, origen: Some(i), rot: 0 }).collect();
        pags.push(PaginaOrg { fuente: Some(b.clone()), origen: Some(1), rot: 90 });
        pags.push(PaginaOrg { fuente: Some(b.clone()), origen: Some(1), rot: 0 }); // repetida
        aplicar(&a, salida, &pags).unwrap();
        assert_eq!(Document::load(salida).unwrap().get_pages().len() as u32, n + 2);
    }
}
