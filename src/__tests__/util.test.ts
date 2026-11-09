import { describe, expect, it } from "vitest";
import {
  aRango, amigable, calcularRangosDividir, carpetaDe, esImagen, esOffice, esPdf, formatoTamano, moverEnLista,
  nombreArchivo, rangoAPaginas, rutaConSufijo, textoFechaImpresion, tipoOffice, unir, validarRangoPaginas,
} from "../util";

describe("rangos de páginas", () => {
  it("compacta páginas sueltas en tramos", () => {
    expect(aRango([5, 1, 2, 3, 7, 8, 3])).toBe("1-3, 5, 7-8");
    expect(aRango([])).toBe("");
    expect(aRango([4])).toBe("4");
  });
  it("ignora valores no válidos al compactar", () => {
    expect(aRango([0, -2, 1.5, 2])).toBe("2");
  });
  it("convierte un rango en el conjunto de páginas, recortando a 1..total", () => {
    expect([...rangoAPaginas("1-3, 5, 9-20", 10)].sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 9, 10]);
    expect(rangoAPaginas("abc, 0, 11", 10).size).toBe(0);
  });
  it("ida y vuelta: rango → páginas → rango", () => {
    expect(aRango([...rangoAPaginas("7, 1-2, 3", 10)])).toBe("1-3, 7");
  });
  it("valida rangos", () => {
    expect(validarRangoPaginas("1-3, 5", 10)).toEqual({ ok: true, n: 4 });
    expect(validarRangoPaginas("2-1", 10).ok).toBe(false);
    expect(validarRangoPaginas("5-20", 12)).toMatchObject({ ok: false, error: "«5-20» está fuera de 1-12" });
    expect(validarRangoPaginas("1;3", 10).ok).toBe(false);
    expect(validarRangoPaginas(" , ", 10)).toMatchObject({ ok: false, error: "Indica al menos una página" });
    // sin saber el total, solo se comprueba la forma
    expect(validarRangoPaginas("50-60", 0)).toEqual({ ok: true, n: 11 });
  });
});

describe("dividir", () => {
  it("cada N páginas", () => {
    expect(calcularRangosDividir("cada", "4", "", 10).rangos).toEqual([[1, 4], [5, 8], [9, 10]]);
  });
  it("N mayor o igual que el total es un error", () => {
    expect(calcularRangosDividir("cada", "10", "", 10).error).toMatch(/solo tiene 10/);
  });
  it("por puntos de corte (ordena y quita duplicados)", () => {
    expect(calcularRangosDividir("puntos", "", "8, 3, 3", 10).rangos).toEqual([[1, 2], [3, 7], [8, 10]]);
  });
  it("un punto de corte en la página 1 no tiene sentido", () => {
    expect(calcularRangosDividir("puntos", "", "1", 10).error).toMatch(/entre 2 y 10/);
  });
  it("sin datos no hay partes ni error visible", () => {
    expect(calcularRangosDividir("cada", "", "", 10)).toEqual({ rangos: [], error: "" });
    expect(calcularRangosDividir("puntos", "", "", 0)).toEqual({ rangos: [], error: "" });
  });
});

describe("rutas y nombres", () => {
  it("añade sufijos antes de la extensión", () => {
    expect(rutaConSufijo("C:\\Docs\\informe.pdf", "_OCR")).toBe("C:\\Docs\\informe_OCR.pdf");
    expect(rutaConSufijo("sin_extension", "_x")).toBe("sin_extension_x");
  });
  it("nombre y carpeta con barras de Windows o de Unix", () => {
    expect(nombreArchivo("C:\\a\\b\\c.pdf")).toBe("c.pdf");
    expect(nombreArchivo("/a/b/c.pdf")).toBe("c.pdf");
    expect(carpetaDe("C:\\a\\b\\c.pdf")).toBe("C:\\a\\b");
    expect(unir("C:\\a", "x.pdf")).toBe("C:\\a\\x.pdf");
    expect(unir("/a", "x.pdf")).toBe("/a/x.pdf");
  });
  it("reconoce PDF e imágenes sin importar mayúsculas", () => {
    expect(esPdf("A.PDF")).toBe(true);
    expect(esPdf("a.pdf.txt")).toBe(false);
    expect(esImagen("foto.HEIC")).toBe(true);
    expect(esImagen("scan.tif")).toBe(true);
    expect(esImagen("doc.pdf")).toBe(false);
  });
});

describe("varios", () => {
  it("formatea tamaños", () => {
    expect(formatoTamano(0)).toBe("");
    expect(formatoTamano(900)).toBe("900 B");
    expect(formatoTamano(2048)).toBe("2 KB");
    expect(formatoTamano(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });
  it("mueve elementos de una lista sin salirse", () => {
    expect(moverEnLista(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moverEnLista(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
  it("traduce errores técnicos a lenguaje claro", () => {
    expect(amigable("The process cannot access the file (os error 32)")).toMatch(/abierto en otro programa/);
    expect(amigable("Operación cancelada por el usuario")).toBe("Operación cancelada.");
    expect(amigable("algo raro")).toBe("algo raro");
  });
  it("texto de fecha de impresión", () => {
    expect(textoFechaImpresion(new Date(2026, 10, 8, 9, 5))).toBe("Impreso el 08/11/2026 a las 09:05");
  });
});

describe("tipoOffice", () => {
  it("reconoce Word, Excel y PowerPoint por extensión", () => {
    expect(tipoOffice("C:\\a\\Informe.DOCX")).toBe("word");
    expect(tipoOffice("acta.rtf")).toBe("word");
    expect(tipoOffice("datos.xlsm")).toBe("excel");
    expect(tipoOffice("lista.csv")).toBe("excel");
    expect(tipoOffice("charla.ppsx")).toBe("powerpoint");
  });
  it("descarta lo que no es de Office", () => {
    expect(tipoOffice("a.pdf")).toBeNull();
    expect(tipoOffice("foto.jpg")).toBeNull();
    expect(tipoOffice("carpeta.docx\\sin_ext")).toBeNull();
    expect(esOffice("x.docx")).toBe(true);
    expect(esOffice("x.pdfx")).toBe(false);
  });
});
