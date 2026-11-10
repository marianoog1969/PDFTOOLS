# Changelog — PDF Tool

## 3.12.0
- **Se elimina toda la firma digital** (firmar con certificado/DNIe, validar firmas, sello de tiempo y LTV): la validación cerraba la aplicación por un fallo dentro de CRYPT32.dll de Windows.
  - Fuera la pestaña «Firmar» del visor y su acceso en la portada, el menú Herramientas y Ctrl+K.
  - Lotes: ya no existe el paso «Firmar»; los perfiles guardados lo pierden solos y los de ejemplo pasan a «Comprimir» y «Word/Excel/PowerPoint a PDF».
  - Rust: eliminados `firma.rs`, `validar.rs` y `ltv.rs` y sus comandos.
  - Manual y documentación actualizados (el manual pasa a tener una sección menos).
- Se mantiene el registro de errores (`logs\errores.log`, Ayuda → «Ver log de errores»).

## 3.11.3
- Diagnóstico del cierre al validar firmas (fallo dentro de CRYPT32.dll, 0xc0000005): `errores.log` anota ahora cada llamada a Windows de la validación (verificar firma, almacén temporal, cadena de certificados, liberación) para localizar cuál lo provoca. Sin cambios de funcionamiento.

## 3.11.2
- **Registro de errores** (`logs\errores.log`, junto al programa; menú Ayuda → «Ver log de errores»): anota los fallos internos, incluidos los que cierran la aplicación sin aviso (pánicos de Rust con ubicación y pila de llamadas), los errores de la interfaz y las trazas de la validación de firmas (inicio, cada firma, fin). Si la app se cierra al abrir la pestaña Firmar, la última línea indica en qué paso ocurrió.
- Validación de firmas: comprobación de rangos más estricta al leer la firma del PDF (un PDF con rangos incoherentes podía provocar un cierre).

## 3.11.1
Repaso visual (sin cambios de funcionamiento):
- Etiquetas de los formularios alineadas a la izquierda («Texto» en Marca de agua; «Nombre del perfil» y «Añadir al nombre» en Lotes); salían centradas.
- Marca de agua: el botón para quitar cada archivo ya no sale con el aspecto gris por defecto de Windows.
- Marca de agua y Rellenar formulario: el texto de la vista previa va debajo de la imagen (antes quedaba estrujado a la derecha).
- Firmar: «Buscar de nuevo» con el estilo de botón secundario.
- Atajos de teclado: la descripción a la izquierda y las teclas a la derecha.
- Acerca de: título normal y botones de tamaño estándar.
- El botón de la zona de soltar se ve desactivado cuando no se puede usar (p. ej. Office a PDF sin Office).

## 3.11.0
- **Lotes: nuevo paso «Convertir Word/Excel/PowerPoint a PDF»** (siempre el primero), con las mismas opciones de Excel, PowerPoint y PDF/A. Permite, por ejemplo, convertir una carpeta de informes de Word, firmarlos e imprimirlos de una vez.
  - La carpeta de origen lista también los documentos de Office (sin los archivos temporales «~$» que crea Office) y avisa si el perfil no los convierte, con un botón para añadir el paso.
  - Opción «Procesar solo los documentos de Office» para no reprocesar los PDF que ya hubiera en la carpeta.
  - Nuevo perfil de ejemplo «Word/Excel/PowerPoint a PDF y firmar» (también se añade a quien ya tenía perfiles guardados).
  - Los documentos de Office soltados sobre Lotes se quedan en Lotes.

## 3.10.0
- **Nueva herramienta «Office a PDF»** (Optimizar y convertir): convierte documentos de Word, Excel y PowerPoint con el Microsoft Office instalado en el equipo, con el mismo resultado que «Guardar como PDF».
  - Detecta la versión de Office y la muestra (2010, 2013, 2016, 2019, 2021, 2024 o Microsoft 365); desactiva las opciones que esa versión no admite.
  - Word: marcadores desde los títulos. Excel: todo el libro u hoja activa y «ajustar a una página de ancho». PowerPoint: diapositivas, páginas de notas o documento con 2, 3 o 6 por hoja.
  - PDF/A (Word y PowerPoint), guardar junto al documento o en otra carpeta, y unir todo en un solo PDF.
  - Seguro: trabaja sobre una copia en solo lectura, con Office invisible y las macros desactivadas; salta los documentos con contraseña; si Office no responde en 2 minutos cierra solo el proceso de esa conversión.
  - Los documentos de Office soltados en cualquier parte de la ventana van directamente a esta herramienta.
- Listas de archivos (Comprimir, OCR, Office…): las flechas ↑↓ van en horizontal; cada fila es más baja y se ven 4 archivos en vez de 2.
- Automatización COM directa desde Rust (sin PowerShell ni VBScript, que suelen estar bloqueados por directiva).

## 3.9.1
- **Nuevo icono de la aplicación** («Etiqueta PDF»: hoja blanca con banda roja PDF sobre fondo azul marino). Se ve en el .exe, la barra de tareas, la cabecera de la app y «Acerca de». En tamaños muy pequeños (16–24 px) se usa una versión simplificada sin texto para que siga siendo reconocible.

## 3.9.0
**¿Acepta PDF esta impresora?** Al elegir «Envío directo» en el panel Imprimir, la app pregunta a la impresora por la red:
- Primero por **IPP** (el protocolo de impresión estándar, puerto 631: formatos que admite) y, si no responde, por **SNMP** (lenguajes instalados según el Printer-MIB). Conexiones directas y breves, sin pasar por el proxy.
- La dirección se averigua sola a partir del puerto de Windows (puerto TCP/IP estándar o URL IPP). Si la impresora está compartida por un servidor, conectada por WSD o por USB, se explica el motivo y se puede **escribir su IP** para comprobarla.
- El resultado se muestra en el panel (Acepta PDF / No acepta PDF / No se ha podido comprobar, con los formatos o lenguajes que indica) y se recuerda para cada impresora. Se puede volver a comprobar.
- Si la impresora dice que **no** acepta PDF, se pide confirmación antes de enviarlo de forma directa y se ofrece volver a «Automático».
- Pruebas automáticas contra impresoras simuladas y comprobado con un servidor CUPS y un agente net-snmp reales.

Otros:
- Los diálogos de confirmación que no borran nada ya no muestran el icono de papelera.

## 3.8.1
- Corregido: en el menú contextual de Organizar (clic derecho), la opción «Eliminar» no se veía (texto rojo sobre fondo rojo).

## 3.8.0
Impresión:
- Paso **«Imprimir» en Lotes**: impresora, copias, doble cara, color y marca solo en la copia impresa. Puede ir después de la firma (imprime el PDF ya firmado). Si falla, el archivo se guarda igualmente y el resultado lo indica.
- **Imprimir selección**: en Organizar, con páginas seleccionadas, el botón Imprimir (y el menú contextual) propone imprimir solo esas páginas.
- **Solo en la copia impresa**: marca de agua (p. ej. «COPIA») y/o «Impreso el … a las …» al pie, sin modificar el archivo.

Código y mantenimiento:
- `App.tsx` pasa de ~2.500 a ~950 líneas: Combinar, Extraer, Dividir, Comprimir, OCR e Imágenes están en `src/herramientas/`, cada una con su estado. Eliminadas las tarjetas antiguas «Reordenar» y «Anotar», que ya no eran accesibles (sustituidas por el visor).
- Una sola hoja de estilos (`estilos.css`) en lugar de cuatro, con el mismo aspecto, sin las reglas de elementos que ya no existen.
- Política de seguridad del contenido (CSP) activada: la interfaz solo puede cargar sus propios archivos y comunicarse con la app.
- Pruebas automáticas: 17 de utilidades (Vitest, `npm test`) y 5 de impresión en Rust.
- `bump-version.ps1` actualiza también `package-lock.json` y no compila si fallan tipos, ESLint o pruebas.
- Sin avisos de compilación en Rust.
- Al cerrar, la app avisa también si hay cambios sin guardar en el visor (antes solo lo hacía para la tarjeta antigua de Reordenar).

Documentación:
- Manual integrado reescrito para la 3.8.0 (antes era de la 2.0.10): visor, firma y validación, todas las herramientas, Lotes, impresión, atajos y preguntas frecuentes.
- `LEEME.txt` y `UTILS\LEEME.txt` actualizados; eliminados los manuales antiguos de la raíz.

## 3.7.0
**Imprimir** (Ctrl+P, botón «Imprimir» del visor, tarjeta de resultado, menú Archivo y Ctrl+K):
- Panel propio: impresora (lista de Windows, con la predeterminada marcada), copias e intercalado, todas las páginas o un rango («1-3, 5»), doble cara (borde largo/corto), color o blanco y negro, páginas por hoja (1-16) y orientación. Recuerda los últimos ajustes.
- Motor por defecto: el de PDF de WebView2 (Edge), ya incluido en Windows. Imprime en vectorial, con texto nítido y trabajos ligeros, sin instalar nada.
- Respaldo automático si falla: SumatraPDF (si se copia en `UTILS\sumatra\SumatraPDF.exe`) y, por último, Ghostscript. Si la impresora no responde en 5 minutos no se reintenta, para no imprimir dos veces.
- «Envío directo» (opciones avanzadas, se recuerda por impresora): manda el PDF tal cual con cabecera PJL (copias, doble cara, color) a impresoras que interpretan PDF. Es instantáneo.
- «Diálogo de Windows…»: abre el documento con el diálogo de impresión del sistema (bandejas, grapado, preferencias del driver).
- Si el documento del visor tiene cambios sin aplicar, se avisa de que se imprime la versión guardada.

Correcciones:
- **La 3.5.0 no compilaba en Windows**: el paso «Firmar» de Lotes guardaba el certificado mientras esperaba a los demás pasos (error de préstamo y de envío entre hilos). Ahora la firma del lote se hace al final, en un hilo propio y abriendo el certificado una sola vez.
- Escape no cerraba «Acerca de» ni el Manual.
- Si no se podía abrir la carpeta de resultados tras un lote (Comprimir, OCR…), el error se perdía; ahora queda en el registro.
- La ventana principal cierra la aplicación aunque quede abierta una ventana de impresión.

Desarrollo:
- ESLint 9 configurado (`npm run lint`: TypeScript y reglas de hooks de React), sin avisos.

## 3.6.0
Mejoras de interfaz y usabilidad (sin cambios en el procesamiento de PDF):
- Más espacio para el documento: se quita el pie (Ver log · Manual · Acerca de · Donar), que ya estaba en el menú Ayuda; el visor gana todo el alto de la ventana.
- Cabecera más baja y limpia: fuera las versiones de Ghostscript/Tesseract y la versión duplicada; nuevo botón «Buscar… Ctrl K» visible.
- Barra de estado útil: último mensaje de actividad (clic → log completo), estado de los componentes (aviso «Falta Ghostscript» con clic para abrir UTILS) y versión (clic → Acerca de).
- Menú lateral: etiquetas en una línea, contador de archivos en espera (Combinar, Comprimir, OCR, Imágenes), punto animado en la herramienta que está trabajando y botón «Contraer menú» con icono. En ventanas estrechas se compacta solo.
- Firmar, Anotar y Organizar más fáciles de encontrar: accesos directos en la portada, en el menú Herramientas y en Ctrl+K (si no hay PDF abierto, lo pide y entra directamente en ese modo). Ctrl+K también busca en los recientes.
- Combinar: ya no aparece un diálogo para borrar los originales tras cada combinación; ahora es un botón opcional «Borrar originales» en la tarjeta de resultado, con confirmación.
- Resultado: un solo aviso por operación (tarjeta de resultado en las herramientas; aviso flotante solo en el visor). Las acciones de borrar quedan separadas a la derecha.
- Registro de actividad con el estilo del tema (antes, bloque negro) y oculto mientras no hay actividad.
- Botones de acción: secundarios a la izquierda y el principal a la derecha con su ancho natural.
- Extraer páginas: el campo de rango aparece al elegir el archivo, con etiqueta.
- OCR: selector de resolución con etiqueta y explicación (Rápido / Recomendado / Máxima calidad); «Corregir orientación» explicado.
- Imágenes a PDF: selector «Un único PDF / Un PDF por imagen» en lugar de dos casillas que actuaban como opción única; corregido el texto duplicado de formatos.
- La barra de pestañas del visor solo aparece cuando hay documentos abiertos; las barras del visor ya no parten los botones en dos líneas.
- Etiquetas más cortas: «Marca de agua», «Metadatos», «Lotes».

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
