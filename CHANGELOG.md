# Changelog — PDF Tool

## 3.5.0
- Marca de agua (texto, tamaño, opacidad, color, ángulo) y numeración de páginas (formato, posición, rango) con vista previa. Respeta páginas giradas y recortadas.
- Tachar de verdad (herramienta «Tachar» en Anotar): las páginas afectadas se convierten en imagen con el recuadro negro, por lo que el texto tapado desaparece del archivo. También se eliminan anotaciones y metadatos de esas páginas.
- Metadatos y limpieza: ver y editar título/autor/asunto/claves; quitar datos del documento, XMP, marcadores, adjuntos, JavaScript y comentarios.
- Rellenar formularios (AcroForm): texto, casillas, opciones, listas; vista previa y opción de aplanar.
- Lotes y perfiles: cadena de pasos (comprimir, OCR, marca/numeración, limpiar metadatos, aplanar, firmar) guardable como perfil, aplicable a una carpeta completa (con subcarpetas opcionales). Los originales no se tocan. La firma siempre va la última.

## 3.4.0
- Menú superior (Archivo, Edición, Ver, Herramientas, Ayuda) con atajos; Ctrl+O abre PDF y Ctrl+W cierra el documento.
- Barra de estado inferior: estado (Listo/Procesando), herramienta, documento, páginas y cambios sin guardar.
- Avisos tipo notificación: «Archivo guardado» con Abrir / Abrir carpeta, y errores en pantalla.
- Diálogos de confirmación propios (cerrar con cambios, descartar anotaciones, borrar copia, eliminar 3 o más páginas) en lugar de los del navegador.
- Portada de inicio renovada: saludo, recientes en tarjetas y herramientas.

## 3.3.1
- Botón «Donar» con colores adaptados al tema oscuro.

## 3.3.0
Rediseño de la interfaz (sin cambios de funcionalidad):
- Nuevo sistema de diseño: variables de color, tipografía, radios y sombras unificados; acento único, sin degradados.
- Iconos SVG de línea (incluidos en el código, sin conexión) en lugar de emojis y símbolos de texto.
- Pestañas de modo con subrayado, grupos segmentados y barras de herramientas más ordenadas.
- Panel Firmar en secciones plegables, con resumen de validación (correctas / avisos / problemas).
- Tema claro/oscuro: sigue el del sistema la primera vez; después recuerda la elección.
- Ayuda de atajos de teclado (tecla ? o botón de la cabecera).
- Foco visible con teclado, respeto a «reducir movimiento», diálogos y barras de desplazamiento unificados.

## 3.2.1
- La validación a largo plazo (LTV) ya NO usa sello de tiempo: solo guarda en el PDF la cadena de certificados y las pruebas de revocación (OCSP/CRL), gratis y sin cuenta.
- Eliminado el campo de TSA y la opción «sello de tiempo» de la interfaz.

## 3.2.0
- NUEVO: **firma de larga duración (LTV)**. Nivel de firma a elegir al firmar: Básica (sin conexión) / Con sello de tiempo / Larga duración (LTV).
  - Sello de tiempo RFC 3161: se pide a una TSA (editable; por defecto DigiCert) y se incorpora a la firma sin invalidarla.
  - Datos de validación (DSS): se guardan en el PDF la cadena de certificados y las respuestas OCSP/CRL, como actualización posterior; las firmas anteriores siguen siendo válidas.
  - Conexión por WinHTTP: usa el proxy configurado en Windows. Si falla la red, el PDF queda firmado igualmente y se muestra un aviso.
- Botón «＋ Sello de tiempo y validación (LTV)» para completar PDF ya firmados (crea «_ltv»). El sello se añade a la última firma.
- El validador muestra el sello de tiempo y si el PDF lleva LTV; usa la fecha del sello para comprobar la vigencia del certificado. Los datos añadidos después (DSS) ya no se tratan como «cambios posteriores».

## 3.1.0
- El menú lateral izquierdo se puede encoger a una barra de iconos (botón «« Ocultar menú» o Ctrl+B); la elección se recuerda.
- El panel de miniaturas del visor (Leer, Organizar, Anotar, Firmar) se puede ocultar con el botón ▤ de la barra; también se recuerda.

## 3.0.0
- NUEVO: **validación de firmas** en la pestaña Firmar. Al abrir un PDF firmado se comprueban sus firmas (también las de Adobe, sedes electrónicas, etc.): integridad (si el documento cambió después de firmar), firmante (nombre, NIF, emisor, fechas), firma matemática y cadena de confianza con las raíces de Windows, y cambios posteriores a la última firma.
- Botón «Comprobar revocación» (necesita conexión): informa si el certificado está revocado o no se pudo comprobar.
- Resultado en lenguaje claro por firma: Válida / Con avisos / No válida, con detalles.
- En sistemas que no son Windows solo se comprueba la integridad.

## 2.9.0
- Resultado de cada operación en una tarjeta clara: nombre, carpeta y botones «Ver en el visor», «Abrir carpeta», «Abrir con otro programa», «Copiar ruta» y «Borrar copia» (en las herramientas; en Firmar los resultados llevan sus propios botones Ver y Carpeta).
- Pie de página renovado (Ver log · Manual · Acerca de · versión · Donar).
- Al arrastrar archivos sobre la ventana aparece un aviso con la zona de destino, los formatos que admite y cuántos se ignorarán.
- Firma: la pestaña indica si el PDF ya está firmado (nº de firmas y si hay cambios posteriores). Los resultados tienen botones «Ver» y «Carpeta». Barra de progreso al firmar varios.
- Organizar páginas: selección con rectángulo (arrastrando sobre el fondo), Impares / Pares / Invertir, Al inicio / Al final, Duplicar.
- Mensajes de error más claros (PIN cancelado, tarjeta no detectada, certificado caducado o .pfx incorrecto, PDF dañado, falta Ghostscript/Tesseract, carpeta de red no disponible, tiempo agotado) y aplicados en todas las operaciones.
- Barra de progreso global fija arriba con porcentaje, tiempo restante estimado y botón Cancelar siempre visible.
- Arreglo: el botón «Aplicar cambios de páginas» de la pestaña Firmar ya no sale gigante.

## 2.8.0
- Firma por lotes ampliada: «Elegir varios PDF para firmar…» permite seleccionar cualquier número de PDF (sin abrirlos), quitarlos de la lista y firmarlos todos de una vez con el mismo certificado, recuadro y páginas. Los que fallen quedan en la lista para reintentar.

## 2.7.0
- NUEVO: pestaña **Firmar** en el visor. Firma digital con certificado (almacén de Windows/DNIe/FNMT o archivo .pfx/.p12) y sello visible con nombre y NIF del certificado, fecha y hora opcionales.
- Recuadro de firma: se dibuja arrastrando sobre la página, se mueve y se redimensiona con las esquinas. Funciona con páginas rotadas.
- Sello en una página, todas, la última o un rango (1,3-5).
- Firma por lotes: «Firmar los N PDF abiertos» con el mismo certificado y posición.
- Firma incremental (adbe.pkcs7.detached, SHA-256): el contenido original no se toca y las firmas previas siguen siendo válidas; se admiten varias firmas seguidas. Se guarda como «_firmado».
- Los PDF con contraseña, o con anotaciones/cambios de páginas sin guardar, piden resolverlo antes de firmar.

## 2.6.0 — 2026-11-06
- Interfaz: el aviso de UTILS es ahora una franja fina ámbar y contextual (solo aparece en las herramientas que necesitan el componente que falta; «Ver cómo» despliega las instrucciones).
- Interfaz: el registro de actividad está plegado por defecto (muestra la última línea) y se despliega solo si hay un error.
- Interfaz: cabecera más limpia; la versión es una pastilla discreta que abre «Acerca de».
- Interfaz: zonas de arrastre más visuales (icono grande, formatos aceptados, botón destacado y resalte al pasar el cursor o arrastrar).
- Interfaz: acabado — transiciones, foco visible con teclado, aparición suave de tarjetas, sombras coherentes, contraste en tema oscuro y respeto de «reducir movimiento».

## 2.5.0 — 2026-11-06
- Comprimir: nuevo modo «Por tamaño máximo» (convive con el deslizador «Por calidad»). Se indica el límite en MB (o con atajos 1/2/5/10/20) y la app busca el nivel de mayor calidad que lo cumple (comando `comprimir_a_tamano`, máx. 4 pruebas, empezando por la estimación). Si no se alcanza, guarda el resultado más pequeño posible y lo avisa; si el PDF ya cumple, no lo toca.
- Comprimir: previsión por archivo antes de empezar («se conseguiría con «Equilibrada»» / «puede que no se alcance»).
- Nuevo nivel interno «Compresión extrema» (50 ppp) solo para el modo por tamaño.

## 2.4.0 — 2026-11-06
- Comprimir: niveles reajustados al estilo de iLovePDF (extrema / recomendada / poca compresión) con calidad JPEG propia por nivel: Mínimo 72 ppp (~10-30 % del original), Equilibrada 150 ppp (~30-50 %), Buena calidad 200 ppp (~60-80 %), Mejor calidad sin tocar imágenes. Antes «Buena calidad» podía dar un archivo mayor que el original.
- Comprimir: nunca devuelve un archivo más grande; si no se reduce, conserva el original y lo indica.
- Comprimir: PDF 1.5 (flujos de objetos comprimidos) y estimación recalibrada.

## 2.3.0 — 2026-11-06
- Comprimir: el nivel se elige con un deslizador «Archivo más pequeño ↔ Mejor calidad» de cuatro posiciones, con el tamaño estimado bajo cada parada.

## 2.2.0 — 2026-11-06
- Comprimir: estimación previa del tamaño final de cada nivel, sin comprimir (comando `analizar_compresion`: lee las imágenes del PDF, su resolución y tipo de compresión). Se muestra en cada botón de nivel y en un resumen con el ahorro previsto. Es aproximada; calibrada contra Ghostscript con un escaneo de prueba (error ~15 %).
- Comprimir: descripciones más detalladas de cada nivel (qué resolución usa y para qué sirve).

## 2.1.3 — 2026-11-06
- Comprimir: los niveles ya no se llaman screen/ebook/printer/prepress, sino «Máxima compresión», «Equilibrada (recomendada)», «Buena calidad» y «Mejor calidad», con una descripción de cada uno.

## 2.1.2 — 2026-11-06
- El log se renueva cada día: `logs\pdftool_AAAA-MM-DD.log` junto al programa. «Ver log» muestra el de hoy y se borran automáticamente los de más de 30 días. El antiguo `pdftool.log` ya no se usa.

## 2.1.1 — 2026-11-06
- Corregido: en Organizar las miniaturas no podían agrandarse más de un tamaño (ahora hasta 4×). Por encima de cierto tamaño se regeneran con más resolución para que no se vean borrosas.

## 2.1.0 — 2026-11-06
- Nuevo: arrastrar páginas entre pestañas en Organizar. Se copian (el PDF de origen no se modifica); soltando sobre una pestaña se añaden al final, y manteniendo el cursor sobre ella se abre para elegir la posición exacta. Las páginas copiadas muestran su procedencia.
- Nuevo: visor con «Ajustar al ancho», «Página completa» y «Dos páginas» enfrentadas.
- Mejora: el aviso de UTILS indica qué falta, la ruta exacta donde copiarlo y un botón para abrir esa carpeta.
- Interno: `aplicar_organizacion` admite páginas de otros PDF (`fuente`) y páginas repetidas.

## 2.0.28 — 2026-11-06
- Corregido: en Organizar no se podían mover las páginas arrastrando (el arrastre nativo de Windows lo bloqueaba). Ahora usa arrastre propio, con autodesplazamiento en los bordes.

## 2.0.27 — 2026-11-06
- Botón ♥ Donar (PayPal) en la cabecera y en el pie.
- Diálogo «Acerca de / Créditos» (clic en la versión, pie o Ctrl+K): autor, tecnologías, Manual / Donar / Cerrar.
- Nuevo comando `open_url` con lista blanca de URLs.

## [2.0.26] - 2026-11-06

### Añadido
- **Cola de archivos**: al soltar varios archivos (o una imagen) en el visor se abre un diálogo que clasifica PDF / imágenes / no admitidos y ofrece solo las acciones válidas: abrir en visor, Combinar, Comprimir, OCR, Imágenes a PDF, o **Combinar todo en un PDF** si hay mezcla (las imágenes, incluido HEIC, se convierten antes y se unen respetando el orden). Se puede reordenar y quitar.
- **Buscador de texto** en el visor (sin distinguir mayúsculas ni tildes): lista de páginas con fragmento y marca amarilla en las miniaturas. Avisa si el PDF no tiene texto (escaneo) y sugiere OCR.
- **Menú contextual** (clic derecho) en Organizar páginas y botón **Extraer a PDF nuevo** con las páginas seleccionadas (respeta rotación y orden).
- **Archivos recientes** en la pantalla de inicio (últimos 8, con «Borrar lista»).
- **Barra de resultado** tras cada operación: Ver en el visor · Abrir · Abrir carpeta · **Borrar copia** (deshacer). Ya no se abre el programa externo ni la carpeta automáticamente.
- La app recuerda el tamaño de la ventana y el tamaño de miniaturas del organizador.
- Atajos visibles en los botones (Ctrl+Z, Ctrl+Y, Supr, Ctrl+A).
- Mensajes de error en lenguaje claro (archivo en uso, sin permiso, no encontrado, disco lleno, PDF protegido).
- Nuevos comandos Rust: `preparar_mixto`, `limpiar_carpeta_cola`, `eliminar_archivo`, `buscar_texto`.

### Cambiado
- Botones de guardar del visor más compactos.

## [2.0.25] - 2026-11-06

### Añadido
- **Imágenes a PDF** admite HEIC/HEIF (fotos de iPhone), tanto en el selector como arrastrando. Decodificador Rust puro (`zune-heic`, sin DLL ni programas externos): respeta la rotación y el recorte del archivo, compone la transparencia sobre blanco y las incrusta como JPEG de calidad 92.

### Nota
- La nueva dependencia requiere Rust 1.89 o superior (`rustup update`).

## [2.0.24] - 2026-11-05

### Añadido
- **Visor y organizar** (nueva pantalla de inicio): documentos abiertos en pestañas (arrastrar varios PDF o «Abrir PDF…»), con modos Leer, Organizar páginas y Anotar sobre el mismo documento y miniaturas compartidas.
- **Organizar páginas** dentro del visor: seleccionar (clic, Ctrl, Mayús, Ctrl+A), arrastrar para mover, rotar izquierda/derecha, eliminar (Supr), insertar página en blanco, deshacer/rehacer (Ctrl+Z / Ctrl+Y), restablecer y tamaño de miniaturas 50–150 %. Se guarda como copia `_editado.pdf`; la pestaña pasa a mostrar el resultado.
- Pantalla de inicio con rejilla de herramientas.
- **Paleta de comandos** Ctrl+K (herramientas y acciones, ignora acentos).
- **Tema oscuro** (botón ☾/☀ en la barra superior; se recuerda).
- Franja de estado inferior en el visor con el último mensaje (clic = log completo).
- Nuevo comando Rust `aplicar_organizacion` (módulo `organizar.rs`): reordena, elimina, rota e inserta páginas con lopdf, conserva atributos heredados y elimina objetos huérfanos (el PDF resultante pesa menos).

### Cambiado
- «Reordenar» y «Anotar y resaltar» pasan a ser modos del visor; se retiran del lateral.
- Arrastrar PDF a la ventana en el visor los abre en pestañas.

## [2.0.23] - 2026-11-05

### Añadido
- Nueva herramienta **Anotar y resaltar** (grupo «Editar»): resaltador en 5 colores, texto en 4 colores y 3 tamaños (varias líneas con Mayús+Intro), seleccionar/editar (doble clic)/borrar (Supr) y deshacer última.
- Las anotaciones se aplican sobre el contenido de la página (resaltado con mezcla «multiplicar», el texto de debajo sigue legible) y se guardan en una copia `_anotado.pdf`; el original no se toca.
- Soporta páginas rotadas, CropBox y acentos/ñ/€ (WinAnsi).
- Nuevo comando Rust `guardar_anotaciones` y módulo `anotaciones.rs`.

## [2.0.22] - 2026-11-05

### Añadido
- Visor de PDF integrado en Extraer y Dividir: columna de miniaturas, página grande con zoom y navegación (◀ ▶, teclado).
- Extraer: doble clic en una miniatura (o el botón / barra espaciadora) selecciona la página y rellena el rango automáticamente.
- Dividir: marca con ✂ dónde cortar; rellena los puntos de corte automáticamente.
- Nuevos comandos Rust `renderizar_pagina` y `miniaturas_visor` (asíncronos, no bloquean la interfaz).

## [2.0.21] - 2026-11-05

### Cambiado
- Nueva interfaz estilo Acrobat: barra superior oscura, lateral izquierdo con las 7 herramientas agrupadas y panel de trabajo que muestra solo la herramienta activa. Paleta azul Acrobat.
- Arrastrar archivos sobre cualquier parte de la ventana los envía a la herramienta activa.

## [2.0.20] - 2026-10-08
### Corregido
- **Comprimir apenas reducía el tamaño de PDFs escaneados** (p. ej. un
  escaneo con OCR de 26 MB bajaba solo 3-4 MB). Causa: con los presets
  estándar de Ghostscript (/ebook, /printer) las imágenes JPEG se dejan pasar
  sin recomprimir (`PassThroughJPEGImages`), y la resolución solo se reduce si
  la imagen supera 1,5 veces la del preset (más de 225 ppp en /ebook), de modo
  que un escaneo a 150-200 ppp quedaba intacto.
  Ahora, en los niveles `screen`, `ebook` y `printer` se fuerza la
  recompresión y la reducción de resolución. El nivel `ebook` además fija
  150 ppp y calidad JPEG media (texto igual de nítido). `prepress` mantiene su
  comportamiento original (máxima calidad).
  Prueba con un escaneo JPEG de 200 ppp (10 páginas): `ebook` 9,9 MB → 2,7 MB
  (antes 9,9 MB → 9,9 MB); `screen` 1,2 MB → 1,0 MB.

## [2.0.19] - 2026-10-05
### Corregido
- **Imágenes a PDF fallaba siempre con "Ghostscript falló al convertir".**
  Causa: Ghostscript no puede abrir imágenes sueltas (JPG, PNG, BMP, TIFF):
  las interpreta como PostScript y da error (`/undefined`, `/syntaxerror`).
  Ahora la conversión se hace sin Ghostscript, decodificando la imagen con
  la crate `image` y construyendo el PDF A4 con `lopdf` (módulo
  `imagen_pdf.rs`). Detalles:
  - Formatos: JPG, PNG, BMP, TIFF, GIF y WEBP.
  - Una imagen por página A4, escalada para caber y centrada.
  - Los JPG se incrustan tal cual (sin recomprimir ni perder calidad); los
    JPG con rotación EXIF (fotos de móvil) se giran correctamente.
  - PNG/GIF con transparencia se componen sobre fondo blanco.
  - La conversión se ejecuta en segundo plano (no congela la ventana) y se
    puede cancelar.
  - Primera compilación: Cargo descargará unas crates nuevas (`image` y
    sus dependencias), así que necesita acceso a crates.io esa vez.
- `Cargo.lock` desactualizado (el paquete figuraba como 2.0.12).

## [2.0.18] - 2026-10-01
### Añadido
- **Eliminar página** desde "Reordenar páginas": cada miniatura tiene ahora
  un botón de papelera junto a la lupa. Se puede deshacer con el botón
  Deshacer igual que un cambio de orden, y no se aplica al PDF hasta pulsar
  Guardar. No permite dejar el documento sin ninguna página. "Restablecer
  orden" recupera también las páginas eliminadas, ya que ahora conserva la
  lista completa original por separado.
### Corregido
- **Carpetas temporales huérfanas** (`pdftool_tmp_ocr_*`, `pdftool_tmp_ext_*`,
  `pdftool_tmp_mini_*`, `pdftool_tmp_orden_*`) que se quedaban sueltas junto al
  ejecutable. Causa: al cancelar una operación se mataba el proceso externo
  (Ghostscript/Tesseract) y se borraba la carpeta temporal justo después, sin
  esperar a que Windows liberase los ficheros que ese proceso tenía abiertos;
  el borrado fallaba en silencio y la carpeta quedaba huérfana para siempre.
  Ahora se espera a que el proceso externo termine de verdad antes de borrar,
  y el borrado reintenta varias veces por si el sistema tarda en soltar los
  ficheros.
- Al arrancar, la app limpia automáticamente cualquier carpeta temporal suelta
  de antes (de esta corrección o de un cierre inesperado previo).
### Cambiado
- Las flechas ↑↓ para reordenar (Combinar, Comprimir, OCR, Imágenes a PDF)
  apenas se veían (gris muy claro, sin borde, 10px). Ahora tienen borde,
  fondo blanco, texto más oscuro y en negrita.
- Miniaturas de "Reordenar páginas" más grandes (mínimo 96px → 140px de
  ancho), con más espacio entre ellas.

## [2.0.16] - 2026-09-30
### Corregido
- **Reordenar listas por arrastre no funcionaba** en Combinar, Comprimir,
  OCR e Imágenes a PDF. Causa: Tauri intercepta el arrastre a nivel de
  sistema operativo (necesario para poder soltar archivos desde el
  Explorador de Windows), y eso impide que el arrastre interno HTML
  (`draggable`/`dragstart`/`drop`) llegue a dispararse dentro de la
  ventana — es un conflicto conocido de Tauri v2, no un bug del código.
  La lógica de reordenar en sí era correcta; simplemente nunca se
  activaba el evento.
- Añadidos botones ↑/↓ en cada elemento de esas 4 listas como alternativa
  fiable, independiente del arrastre. El texto "reordena arrastrando" de
  Combinar se actualizó a "reordena con ↑↓".
- El asa de arrastre (⠿) y el arrastre HTML se dejan tal cual por si
  llegase a funcionar en algún entorno, pero los botones son ahora la vía
  garantizada.

## [2.0.15] - 2026-08-21
### Cambiado
- Interfaz reorganizada en dos secciones para bajar el ruido visual con ya
  7 herramientas: **"Organizar páginas"** (Combinar, Extraer, Dividir,
  Reordenar) y **"Optimizar y convertir"** (Comprimir, OCR, Imágenes a PDF).
  Sigue siendo todo visible de un vistazo y arrastrable directamente a su
  tarjeta — no son pestañas, solo agrupación con un separador de título.
- Grid de tarjetas simplificado a una única regla de 3 columnas (antes había
  variantes `tarjetas-5/6/7` según cuántas tarjetas hubiera en total).

## [2.0.14] - 2026-08-21
### Añadido
- Nueva operación **Dividir PDF** (al estilo PDFsam): dos modos, "cada N
  páginas" (trocea el documento en partes iguales) o "en páginas concretas"
  (indicas los puntos de corte, p. ej. "5, 12" genera 3 archivos: 1-4, 5-11,
  12-fin). Cada parte se genera junto al archivo original; si el nombre ya
  existe se le añade un sufijo numérico automático, sin sobrescribir nada.
  Cancelable y con progreso real ("Generando parte X/N").
- Nuevo comando de backend `dividir_pdf`.

## [2.0.13] - 2026-08-20
### Corregido
- **Cancelación**: se pudo quedar "atascada" cualquier operación de un solo
  disparo (Combinar, Extraer, Imágenes a PDF combinado, y ahora Miniaturas y
  Reordenar) tras cancelar una vez: el backend nunca reseteaba el flag de
  cancelación por su cuenta, así que la siguiente operación fallaba de
  inmediato con "Operación cancelada" sin llegar a ejecutarse. Ahora cada una
  de esas operaciones resetea el flag al arrancar.
- Generar miniaturas para "Reordenar páginas" ahora es cancelable de verdad
  (se mata Ghostscript en el acto) y muestra progreso real en la barra
  superior ("Generando miniaturas… X/N") en vez de un texto fijo.
- Reordenar páginas también muestra progreso mientras reconstruye el PDF.

### Añadido (mejoras de "Reordenar páginas")
- Deshacer (hasta 20 pasos) para los movimientos de páginas.
- Control "Mover a posición" con un número, además de arrastrar — mucho más
  rápido en PDFs largos.
- Selección de miniatura + navegación por teclado (flechas, Home, End, Escape).
- Línea de inserción (antes/después) al arrastrar, en vez de solo resaltar
  la miniatura de destino.
- Aviso de confirmación antes de perder un orden sin guardar: al cambiar de
  archivo, al soltar uno nuevo encima, o al cerrar la ventana.
- Vista ampliada (zoom) de cada miniatura con un clic.

## [2.0.12] - 2026-08-19
### Añadido
- Nueva operación **Reordenar páginas**: genera una miniatura por página (vía
  Ghostscript a baja resolución) y permite arrastrarlas para cambiar el orden
  antes de guardar un PDF nuevo con las páginas reorganizadas.
- Nuevos comandos de backend: `generar_miniaturas_paginas` y `reordenar_paginas`.

## [2.0.11] - 2026-08-11
### Corregido
- Extraer páginas: al extraer un único rango de páginas, el guardado fallaba
  con "Error al guardar: El sistema no puede mover el archivo a otra unidad
  de disco. (os error 17)" cuando el archivo de destino estaba en una unidad
  distinta a la del ejecutable (p. ej. exe en P:\ y guardado en C:\ o en un
  pendrive). Ahora, si el movimiento rápido entre unidades no es posible, se
  recurre automáticamente a copiar + borrar el temporal.

## [2.0.10] - 2026-08-10
### Corregido
- Los enlaces internos del manual de usuario ya no lanzan/recargan la ventana
  principal de la app: ahora se interceptan y el scroll se hace manualmente
  dentro del propio iframe.
- Reordenado el apartado "Imágenes a PDF" del manual: pasa del grupo
  "Referencia" al grupo "Operaciones" (justo después de "Extraer páginas"),
  igual que aparece en la pantalla principal de la app. Renumerados el resto
  de apartados en cascada.

## [1.5.0] - 2026-06-22
### Añadido
- Cola de varios archivos en Comprimir y OCR (antes era uno a uno)
- Arrastrar archivos desde el Explorador en las 3 tarjetas
- Detección de archivo en uso con opción de cerrar el programa bloqueante
- Opción de borrar archivos originales tras combinar (diálogo de confirmación)
- Protección ante sobrescritura: avisa si el archivo de destino ya existe
  (opciones: sobrescribir, renombrar automáticamente _2/_3..., cancelar)
- Comprobación de UTILS al arrancar (aviso si falta Ghostscript o Tesseract)
- Progreso de OCR por página y por archivo en la cola
- Comparación de tamaño antes/después al comprimir
- Apertura automática de carpeta y PDF al terminar cada operación
- Recuerda la última carpeta usada en los diálogos
- Sin ventana de consola (Ghostscript y Tesseract ya no parpadean)
- Sistema de versiones con script `bump-version.ps1`

## [1.0.0] - 2026-06-22 (versión inicial)
### Añadido
- Combinar PDF con reordenación por arrastre
- Comprimir PDF con Ghostscript (niveles: screen, ebook, printer, prepress)
- OCR con Ghostscript + Tesseract (idiomas: spa, eng, spa+eng)
- Búsqueda de UTILS en P:\APPS\PDFTOOLS\UTILS (ruta de red) como prioritaria
- Registro de actividad en pantalla
