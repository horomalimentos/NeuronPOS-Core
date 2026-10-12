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

/** Logo completo: mandadero mostaza, "nayo" y "by NeuronPOS" debajo. */
export function NayoLogo({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const s = {
    sm: { mark: 'h-9', word: 'text-xl', by: 'text-[9px]' },
    md: { mark: 'h-12', word: 'text-3xl', by: 'text-[10px]' },
    lg: { mark: 'h-20 sm:h-24', word: 'text-5xl sm:text-6xl', by: 'text-xs' },
  }[size];
  return (
    <span className={`inline-flex items-end gap-2 ${className ?? ''}`} role="img" aria-label="Nayo by NeuronPOS">
      <NayoMark className={`${s.mark} w-auto text-[#FFC21A]`} />
      <span className="flex flex-col leading-none">
        <span className={`${s.word} font-black tracking-tight text-white`}>nayo</span>
        <span className={`${s.by} mt-1 font-semibold uppercase tracking-[0.14em] text-gray-500`}>by NeuronPOS</span>
      </span>
    </span>
  );
}
