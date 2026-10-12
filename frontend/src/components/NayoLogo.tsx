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
 * Logo completo: mandadero mostaza, "nayo" y "by NeuronPOS" debajo.
 * El mandadero mide lo mismo que el bloque de texto (nayo + by, con
 * leading-none) para que ambos queden alineados arriba y abajo.
 */
export function NayoLogo({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const s = {
    // alto del mandadero = tamaño de "nayo" + margen + tamaño de "by"
    sm: { gap: 'gap-1.5', mark: 'h-[33px]', word: 'text-xl', by: 'mt-1 text-[9px]' },
    md: { gap: 'gap-2', mark: 'h-[44px]', word: 'text-3xl', by: 'mt-1 text-[10px]' },
    lg: { gap: 'gap-2.5 sm:gap-3', mark: 'h-[66px] sm:h-[78px]', word: 'text-5xl sm:text-6xl', by: 'mt-1.5 text-xs' },
  }[size];
  return (
    <span className={`inline-flex items-center ${s.gap} ${className ?? ''}`} role="img" aria-label="Nayo by NeuronPOS">
      <NayoMark className={`${s.mark} w-auto shrink-0 text-[#FFC21A]`} />
      <span className="flex flex-col leading-none">
        <span className={`${s.word} font-black leading-none tracking-tight text-white`}>nayo</span>
        <span className={`${s.by} pl-[0.1em] font-semibold uppercase leading-none tracking-[0.14em] text-gray-500`}>by NeuronPOS</span>
      </span>
    </span>
  );
}
