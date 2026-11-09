//! Conversión de imágenes a PDF A4 sin depender de Ghostscript.
//!
//! Ghostscript NO puede abrir imágenes sueltas (JPG/PNG/BMP/TIFF): las interpreta
//! como PostScript y falla con "/undefined" o "/syntaxerror". Aquí se decodifican
//! con la crate `image` y se incrustan en un PDF construido con `lopdf`.

use image::metadata::Orientation;
use image::{ColorType, DynamicImage, ExtendedColorType, ImageDecoder, ImageFormat, ImageReader};
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};
use std::io::Cursor;

const A4_ANCHO: f32 = 595.276;
const A4_ALTO: f32 = 841.890;

struct ImagenPreparada {
    ancho: u32,
    alto: u32,
    espacio_color: &'static str, // DeviceRGB | DeviceGray
    jpeg: bool,                  // true: datos JPEG (DCTDecode); false: píxeles crudos (Flate)
    datos: Vec<u8>,
}

fn nombre_corto(ruta: &str) -> String {
    std::path::Path::new(ruta)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(ruta)
        .to_string()
}

/// HEIC/HEIF: por extensión o por la marca `ftyp` del contenedor (heic, heix, mif1, msf1…).
fn es_heic(ruta: &str, bytes: &[u8]) -> bool {
    let ext = ruta.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if ext == "heic" || ext == "heif" { return true; }
    bytes.len() > 12 && &bytes[4..8] == b"ftyp" && matches!(&bytes[8..12], b"heic" | b"heix" | b"mif1" | b"msf1" | b"hevc" | b"heim" | b"heis")
}

/// Decodifica HEIC/HEIF (fotos de iPhone) con un decodificador Rust puro y lo incrusta como JPEG de alta calidad.
/// La rotación y el recorte del archivo ya vienen aplicados por el decodificador.
fn preparar_heic(nombre: &str, bytes: &[u8]) -> Result<ImagenPreparada, String> {
    use zune_heic::zune_core::bytestream::ZCursor;
    use zune_heic::zune_core::colorspace::ColorSpace;

    let mut dec = zune_heic::HeifDecoder::new(ZCursor::new(bytes));
    let px = dec.decode().map_err(|e| format!("{}: no se pudo decodificar el HEIC ({:?})", nombre, e))?;
    let ancho = dec.width().ok_or_else(|| format!("{}: HEIC sin dimensiones", nombre))? as u32;
    let alto = dec.height().ok_or_else(|| format!("{}: HEIC sin dimensiones", nombre))? as u32;
    let cs = dec.colorspace().ok_or_else(|| format!("{}: HEIC sin espacio de color", nombre))?;
    let n = (ancho as usize) * (alto as usize);

    // A RGB de 8 bits; la transparencia se compone sobre blanco.
    let rgb: Vec<u8> = match cs {
        ColorSpace::RGB if px.len() == n * 3 => px,
        ColorSpace::RGBA if px.len() == n * 4 => {
            let mut o = Vec::with_capacity(n * 3);
            for p in px.chunks_exact(4) {
                let a = p[3] as u32;
                for c in 0..3 { o.push(((p[c] as u32 * a + 255 * (255 - a)) / 255) as u8); }
            }
            o
        }
        ColorSpace::Luma if px.len() == n => px.iter().flat_map(|&g| [g, g, g]).collect(),
        ColorSpace::LumaA if px.len() == n * 2 => {
            let mut o = Vec::with_capacity(n * 3);
            for p in px.chunks_exact(2) {
                let a = p[1] as u32;
                let g = ((p[0] as u32 * a + 255 * (255 - a)) / 255) as u8;
                o.extend_from_slice(&[g, g, g]);
            }
            o
        }
        otro => return Err(format!("{}: formato de color HEIC no admitido ({:?})", nombre, otro)),
    };

    let mut salida = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut salida, 92)
        .encode(&rgb, ancho, alto, ExtendedColorType::Rgb8)
        .map_err(|e| format!("{}: error al codificar ({})", nombre, e))?;
    Ok(ImagenPreparada { ancho, alto, espacio_color: "DeviceRGB", jpeg: true, datos: salida })
}

fn preparar_imagen(ruta: &str) -> Result<ImagenPreparada, String> {
    let nombre = nombre_corto(ruta);
    let bytes = std::fs::read(ruta).map_err(|e| format!("No se pudo leer {}: {}", nombre, e))?;

    if es_heic(ruta, &bytes) {
        return preparar_heic(&nombre, &bytes);
    }

    let lector = ImageReader::new(Cursor::new(bytes.as_slice()))
        .with_guessed_format()
        .map_err(|e| format!("No se pudo leer {}: {}", nombre, e))?;
    let formato = lector.format();
    let mut decoder = lector
        .into_decoder()
        .map_err(|e| format!("{}: formato de imagen no compatible ({})", nombre, e))?;
    let orientacion = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let color_original = decoder.color_type();
    let (ancho, alto) = decoder.dimensions();

    // JPEG sin rotación EXIF y en gris/RGB: se incrusta tal cual (sin recomprimir ni perder calidad).
    if formato == Some(ImageFormat::Jpeg) && orientacion == Orientation::NoTransforms {
        let espacio = match color_original {
            ColorType::L8 => Some("DeviceGray"),
            ColorType::Rgb8 => Some("DeviceRGB"),
            _ => None,
        };
        if let Some(espacio_color) = espacio {
            drop(decoder);
            return Ok(ImagenPreparada { ancho, alto, espacio_color, jpeg: true, datos: bytes });
        }
    }

    let mut img = DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("{}: no se pudo decodificar ({})", nombre, e))?;
    img.apply_orientation(orientacion);
    let (ancho, alto) = (img.width(), img.height());

    // JPEG girado por EXIF: se vuelve a codificar como JPEG de alta calidad (evita PDFs enormes).
    if formato == Some(ImageFormat::Jpeg) {
        let rgb = img.to_rgb8();
        let mut salida = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut salida, 92)
            .encode(rgb.as_raw(), ancho, alto, ExtendedColorType::Rgb8)
            .map_err(|e| format!("{}: error al recodificar ({})", nombre, e))?;
        return Ok(ImagenPreparada { ancho, alto, espacio_color: "DeviceRGB", jpeg: true, datos: salida });
    }

    // Resto de formatos: píxeles crudos (se comprimen con Flate al construir el PDF).
    if matches!(img.color(), ColorType::L8 | ColorType::L16) {
        let gris = img.to_luma8();
        return Ok(ImagenPreparada { ancho, alto, espacio_color: "DeviceGray", jpeg: false, datos: gris.into_raw() });
    }
    let rgb = if img.color().has_alpha() {
        // Transparencia → se compone sobre fondo blanco.
        let rgba = img.to_rgba8();
        let mut out = Vec::with_capacity((ancho * alto * 3) as usize);
        for p in rgba.pixels() {
            let a = p[3] as u32;
            for c in 0..3 {
                out.push(((p[c] as u32 * a + 255 * (255 - a)) / 255) as u8);
            }
        }
        out
    } else {
        img.to_rgb8().into_raw()
    };
    Ok(ImagenPreparada { ancho, alto, espacio_color: "DeviceRGB", jpeg: false, datos: rgb })
}

/// Crea un PDF A4 (una imagen por página, escalada para caber y centrada).
/// `cancelado` se consulta entre imágenes.
pub fn imagenes_a_pdf_nativo(
    rutas: &[String],
    salida: &str,
    cancelado: &dyn Fn() -> bool,
) -> Result<(), String> {
    if rutas.is_empty() {
        return Err("No se han indicado imágenes".into());
    }

    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut hijos: Vec<Object> = Vec::new();

    for ruta in rutas {
        if cancelado() {
            return Err("Operación cancelada".into());
        }
        let img = preparar_imagen(ruta)?;

        let mut dic = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => img.ancho as i64,
            "Height" => img.alto as i64,
            "ColorSpace" => img.espacio_color,
            "BitsPerComponent" => 8,
        };
        let img_stream = if img.jpeg {
            dic.set("Filter", "DCTDecode");
            Stream::new(dic, img.datos)
        } else {
            let mut s = Stream::new(dic, img.datos);
            s.compress().map_err(|e| format!("Error al comprimir {}: {}", nombre_corto(ruta), e))?;
            s
        };
        let img_id = doc.add_object(img_stream);

        // Escala para caber en A4 y centrado.
        let escala = (A4_ANCHO / img.ancho as f32).min(A4_ALTO / img.alto as f32);
        let (w, h) = (img.ancho as f32 * escala, img.alto as f32 * escala);
        let (x, y) = ((A4_ANCHO - w) / 2.0, (A4_ALTO - h) / 2.0);

        let contenido = Content {
            operations: vec![
                Operation::new("q", vec![]),
                Operation::new("cm", vec![w.into(), 0.into(), 0.into(), h.into(), x.into(), y.into()]),
                Operation::new("Do", vec!["Im0".into()]),
                Operation::new("Q", vec![]),
            ],
        };
        let contenido_id = doc.add_object(Stream::new(
            dictionary! {},
            contenido.encode().map_err(|e| e.to_string())?,
        ));

        let pagina_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), A4_ANCHO.into(), A4_ALTO.into()],
            "Contents" => contenido_id,
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => img_id } },
        });
        hijos.push(pagina_id.into());
    }

    let total = hijos.len() as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => hijos,
            "Count" => total,
        }),
    );
    let catalogo_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalogo_id);

    doc.save(salida)
        .map_err(|e| format!("Error al guardar el PDF: {}", e))?;
    Ok(())
}

