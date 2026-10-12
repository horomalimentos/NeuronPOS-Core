import { api } from './api';
import { shrink } from './images';

/**
 * Sube una foto del personal (evidencia de checklist, incidencia...). La
 * reduce antes de mandarla, para que suba rapido desde el celular.
 */
export async function uploadPhoto(file: File): Promise<string> {
  const blob = await shrink(file);
  return (await api<{ url: string }>('/uploads/photo', { method: 'POST', file: blob })).url;
}
