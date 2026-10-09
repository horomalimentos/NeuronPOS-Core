// Convierte una imagen (BGRA o RGBA) a comandos ESC/POS de impresora termica:
// imagen en mapa de bits (GS v 0), avance de papel y corte. Sirve para
// cualquier impresora compatible con Epson (la mayoria de las de 58/80 mm).

const ESC = 0x1b;
const GS = 0x1d;

/** Ancho en puntos del cabezal por ancho de papel (203 dpi). */
export const PAPER_DOTS = { 80: 576, 58: 384 };

/**
 * Pasa una imagen a 1 bit (negro = 1) con umbral sobre la luminancia.
 * `pixels` es BGRA (lo que da NativeImage.toBitmap en Windows/Linux) o RGBA.
 */
export function toMonochrome(pixels, width, height, { order = 'bgra', threshold = 160 } = {}) {
  const bytesPerRow = Math.ceil(width / 8);
  const out = Buffer.alloc(bytesPerRow * height);
  const [ri, bi] = order === 'bgra' ? [2, 0] : [0, 2];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const a = pixels[i + 3] / 255;
      // Transparente cuenta como blanco.
      const lum = (0.299 * pixels[i + ri] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + bi]) * a + 255 * (1 - a);
      if (lum < threshold) out[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { data: out, bytesPerRow };
}

/** Recorta las filas blancas del final para no desperdiciar papel. */
export function trimBottom({ data, bytesPerRow }, height) {
  let last = height - 1;
  while (last > 0) {
    const row = data.subarray(last * bytesPerRow, (last + 1) * bytesPerRow);
    if (row.some((b) => b !== 0)) break;
    last -= 1;
  }
  return last + 1;
}

/**
 * Comandos completos para imprimir la imagen. Se manda en franjas de 256
 * filas porque algunas impresoras no aceptan imagenes muy altas de una vez.
 */
export function rasterJob(mono, height, { cut = true, openDrawer = false, feedLines = 4 } = {}) {
  const parts = [Buffer.from([ESC, 0x40])]; // inicializar
  if (openDrawer) parts.push(Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]));
  const { data, bytesPerRow } = mono;
  for (let y = 0; y < height; y += 256) {
    const rows = Math.min(256, height - y);
    parts.push(Buffer.from([GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8]));
    parts.push(data.subarray(y * bytesPerRow, (y + rows) * bytesPerRow));
  }
  parts.push(Buffer.from([ESC, 0x64, feedLines]));
  if (cut) parts.push(Buffer.from([GS, 0x56, 0x42, 0x00])); // corte parcial con avance
  return Buffer.concat(parts);
}

/** Solo abre el cajon de dinero (pulso al pin 2). */
export const drawerPulse = () => Buffer.from([ESC, 0x40, ESC, 0x70, 0x00, 0x19, 0xfa]);
