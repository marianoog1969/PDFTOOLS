# PDF Tool

Tauri 2 + Rust + React/TS. Combinar, comprimir y aplicar OCR a PDFs.
OCR implementado con Ghostscript (rasteriza) + Tesseract (reconoce texto)
+ lopdf (combina las páginas), sin Python ni ocrmypdf de por medio.

## Requisitos previos (en la máquina Windows donde compiles)
1. Node.js LTS
2. Rust (rustup), target MSVC
3. Tauri CLI: `cargo install tauri-cli --version "^2"`
4. WebView2 Runtime (ya viene instalado en Windows 10/11 normalmente)

## Pasos

```
npm install
```

### Iconos (obligatorio para el bundle)
Ya incluyo un `icono.png` provisional en la raíz del proyecto. Genera los
tamaños/formatos que pide Tauri con:
```
cargo tauri icon icono.png
```
Si más adelante quieres un icono distinto, repite el comando con tu propio PNG.

### Desarrollo
```
npm run tauri dev
```

### Compilar el .exe
```
npm run tauri build
```
Resultado:
- `src-tauri/target/release/pdftool.exe`
- `src-tauri/target/release/bundle/nsis/...` (instalador)

## Carpeta UTILS (obligatoria para Comprimir y OCR)

La app busca los binarios en `UTILS`, **en la misma carpeta donde está el
.exe**. "Combinar" no depende de esto (usa lopdf, una librería Rust interna).

Estructura final esperada:

```
PDFTool\
├── pdftool.exe
└── UTILS\
    ├── gs\                  <- carpeta de instalación de Ghostscript COMPLETA
    │   ├── bin\gswin64c.exe
    │   ├── bin\gsdll64.dll
    │   ├── lib\...
    │   └── Resource\...
    └── tesseract\           <- carpeta de instalación de Tesseract COMPLETA
        ├── tesseract.exe
        ├── *.dll
        └── tessdata\spa.traineddata (y los demás idiomas que instales)
```

Importante: copia la carpeta de instalación **entera**, no solo el .exe.
Ghostscript necesita su carpeta `Resource` (fuentes, perfiles de color) y
Tesseract necesita sus DLLs y la carpeta `tessdata` junto al ejecutable.

### 1. Ghostscript
Descarga: https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10070/gs10070w64.exe
Es un instalador. Ejecútalo en tu PC (no en el de destino), y luego copia
toda la carpeta resultante (algo como `C:\Program Files\gs\gs10.07.0\`) a
`UTILS\gs\`.

### 2. Tesseract
Página oficial de instaladores Windows (UB Mannheim, el estándar de facto):
https://github.com/UB-Mannheim/tesseract/wiki

Durante la instalación, en "Additional language data" marca **Spanish**
(además del inglés que viene por defecto) para que el reconocimiento en
castellano funcione. Luego copia toda la carpeta de instalación (algo como
`C:\Program Files\Tesseract-OCR\`) a `UTILS\tesseract\`.

Si más adelante necesitas más idiomas, basta con añadir el `.traineddata`
correspondiente dentro de `UTILS\tesseract\tessdata\` y cambiar el código
(`-l spa` en `src-tauri/src/lib.rs`, función `ejecutar_ocr`) por el idioma
que toque, o por varios combinados con `+` (p. ej. `spa+eng`).

## Calidad del OCR

Este enfoque (Ghostscript + Tesseract puro) reconoce texto correctamente en
escaneos normales de oficina, pero no hace algunas cosas que sí hace
`ocrmypdf`: enderezar páginas torcidas (deskew), optimizar/recomprimir las
imágenes, ni generar PDF/A. Si en el futuro alguno de los documentos sale
mal reconocido por estar torcido o con mucho ruido, dímelo y valoramos
añadir un paso de preprocesado de imagen antes del OCR.
