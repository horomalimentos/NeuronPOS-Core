import { MANDADERO, MANDADERO_VIEWBOX } from './nayoPaths';

// Marca Nayo: el mandadero (hombre encorvado con gabardina que mira la bolsa
// con la N). Mostaza sobre carbon, como la marca Comanda de NeuronPOS.

/** Silueta sola en currentColor; el cuello y la N dejan ver el fondo. */
export function NayoMark({ className }: { className?: string }) {
  return (
    <svg viewBox={MANDADERO_VIEWBOX} className={className} aria-hidden="true">
      <path d={MANDADERO} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/**
 * Logo completo. Todo se mide en em del tamano de "nayo": el mandadero se
 * para sobre la linea base de la palabra (los pies no bajan al descendente
 * de la y) y "by NeuronPOS" va debajo, alineado con la palabra.
 */
export function NayoLogo({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const fontSize = { sm: 'text-xl', md: 'text-3xl', lg: 'text-6xl sm:text-7xl' }[size];
  return (
    <span className={`inline-grid grid-cols-[auto_auto] items-end gap-x-[0.22em] leading-none ${fontSize} ${className ?? ''}`} role="img" aria-label="Nayo by NeuronPOS">
      <NayoMark className="mb-[0.2em] h-[1.3em] w-auto text-[#FFC21A]" />
      <span className="font-black tracking-tight text-white">nayo</span>
      <span />
      <span className="mt-[0.05em] pl-[0.06em] text-[max(0.17em,9px)] font-semibold uppercase tracking-[0.2em] text-gray-500">by NeuronPOS</span>
    </span>
  );
}
