import { useId } from 'react';
import { CARBON, MOSTAZA, TICKET, TICKET_N, WORD_NEURON, WORD_POS, WORD_WIDTH } from './neuronLogoPaths';

// Marca NeuronPOS: una comanda (ticket con borde cortado) con la N.

/**
 * Simbolo solo. "color": comanda mostaza con N carbon. "mono": comanda en
 * currentColor con la N calada (se ve el fondo), para pies de pagina.
 */
export function NeuronMark({ className, tone = 'color' }: { className?: string; tone?: 'color' | 'mono' }) {
  const mask = useId();
  return (
    <svg viewBox="0 0 68 76" className={className} aria-hidden="true">
      {tone === 'color' ? (
        <>
          <path d={TICKET} fill={MOSTAZA} />
          <path d={TICKET_N} fill={CARBON} />
        </>
      ) : (
        <>
          <mask id={mask}>
            <path d={TICKET} fill="#fff" />
            <path d={TICKET_N} fill="#000" />
          </mask>
          <rect width="68" height="76" fill="currentColor" mask={`url(#${mask})`} />
        </>
      )}
    </svg>
  );
}

/** Logo completo para fondos oscuros: NEURON en blanco y POS en mostaza. */
export function NeuronLogo({ className, label = 'NeuronPOS' }: { className?: string; label?: string }) {
  return (
    <svg viewBox={`0 0 ${WORD_WIDTH} 80`} className={className} role="img" aria-label={label}>
      <g transform="translate(0 2)">
        <path d={TICKET} fill={MOSTAZA} />
        <path d={TICKET_N} fill={CARBON} />
      </g>
      <path d={WORD_NEURON} fill="#fff" />
      <path d={WORD_POS} fill={MOSTAZA} />
    </svg>
  );
}
