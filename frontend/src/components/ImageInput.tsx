import { ImageIcon, Loader2, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';

const MAX_SIDE = 1600;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Achica fotos grandes (las del celular pesan varios MB) antes de subirlas.
 * WebP conserva la transparencia de los logos; si el navegador no lo
 * genera, se queda con lo que regrese el canvas.
 */
async function shrink(file: File): Promise<Blob> {
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

/** Subir una foto (o pegar su URL). Guarda la URL resultante con onChange. */
export default function ImageInput({ value, onChange, label = 'Foto' }: {
  value: string; onChange: (url: string) => void; label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showUrl, setShowUrl] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (!file.type.startsWith('image/')) { setError('Elige una imagen (JPG, PNG o WebP)'); return; }
    setBusy(true);
    try {
      const blob = await shrink(file);
      if (blob.size > MAX_BYTES) throw new Error('La imagen pesa más de 5 MB');
      const res = await api<{ url: string }>('/uploads/image', { method: 'POST', file: blob });
      onChange(res.url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex items-center gap-3">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-gray-700 bg-gray-900">
          {value ? <img src={value} alt="" className="h-full w-full object-cover" /> : <ImageIcon className="h-6 w-6 text-gray-600" />}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => input.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-700 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {value ? 'Cambiar foto' : 'Subir foto'}
          </button>
          {value && (
            <button type="button" onClick={() => onChange('')} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-gray-400 hover:text-white">
              <X className="h-4 w-4" /> Quitar
            </button>
          )}
          <button type="button" onClick={() => setShowUrl(!showUrl)} className="px-1 text-xs text-gray-500 hover:text-gray-300">
            {showUrl ? 'Ocultar URL' : 'Usar una URL'}
          </button>
        </div>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden"
          onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {showUrl && (
        <input className="input mt-2" type="text" placeholder="https://…" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
    </div>
  );
}
