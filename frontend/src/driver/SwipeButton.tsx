import { ChevronsRight, Loader2 } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * Boton de "desliza para confirmar", como en Uber o DiDi: evita marcar un
 * paso por un toque sin querer. Con teclado, Enter o espacio confirman.
 */
export default function SwipeButton({ label, onConfirm, loading, tone = 'brand', disabled }: {
  label: string; onConfirm: () => void; loading?: boolean; tone?: 'brand' | 'green'; disabled?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const KNOB = 56;
  const max = () => Math.max(1, (track.current?.clientWidth ?? 300) - KNOB - 8);
  const idle = !loading && !disabled;

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!idle) return;
    start.current = e.clientX - dx;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    setDx(Math.min(max(), Math.max(0, e.clientX - start.current)));
  };
  const up = () => {
    if (start.current === null) return;
    start.current = null;
    setDragging(false);
    if (dx >= max() * 0.85) {
      setDx(max());
      onConfirm();
      setTimeout(() => setDx(0), 600);
    } else setDx(0);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (idle && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onConfirm(); }
  };

  const bg = tone === 'green' ? 'bg-emerald-500' : 'bg-brand';
  const fg = tone === 'green' ? 'text-white' : 'text-brand-contrast';
  return (
    <div ref={track} role="button" tabIndex={0} aria-label={label} aria-disabled={!idle} onKeyDown={key}
      className={`relative h-16 select-none overflow-hidden rounded-2xl ${bg} ${disabled ? 'opacity-50' : ''}`}>
      <div className={`absolute inset-y-0 left-0 ${tone === 'green' ? 'bg-emerald-600' : 'bg-black/15'}`} style={{ width: dx + KNOB }} />
      <span className={`pointer-events-none absolute inset-0 flex items-center justify-center pl-12 text-base font-bold ${fg}`}
        style={{ opacity: 1 - dx / max() }}>
        {loading ? 'Un momento…' : label}
      </span>
      <div onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        className={`absolute left-1 top-1 flex h-14 w-14 touch-none items-center justify-center rounded-xl bg-white text-gray-900 shadow-lg ${dragging ? '' : 'transition-transform'}`}
        style={{ transform: `translateX(${dx}px)` }}>
        {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <ChevronsRight className="h-7 w-7" />}
      </div>
    </div>
  );
}
