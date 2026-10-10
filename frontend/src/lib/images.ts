// Fotos que se suben desde el navegador.

const MAX_SIDE = 1600;
export const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Achica fotos grandes (las del celular pesan varios MB) antes de subirlas.
 * WebP conserva la transparencia de los logos; si el navegador no lo
 * genera, se queda con lo que regrese el canvas.
 */
export async function shrink(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.85));
  return blob && blob.size < file.size ? blob : file;
}
