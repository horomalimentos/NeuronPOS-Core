import { Circle, Minus, Plus, Save, Square, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Alert, Button, Field } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { ORDER_STATUS_LABEL, formatTime } from './lib';
import type { DiningTable, MapObjectKind, Zone, ZoneMapObject } from './types';

const OBJECT_KINDS: { kind: MapObjectKind; label: string; w: number; h: number; style: string }[] = [
  { kind: 'barra', label: 'Barra', w: 6, h: 1, style: 'bg-amber-700/60 text-amber-100' },
  { kind: 'pared', label: 'Pared', w: 6, h: 1, style: 'bg-gray-600 text-gray-100' },
  { kind: 'puerta', label: 'Puerta', w: 2, h: 1, style: 'bg-orange-900/60 text-orange-100 border border-dashed border-orange-300/60' },
  { kind: 'bano', label: 'Baños', w: 2, h: 2, style: 'bg-sky-800/60 text-sky-100' },
  { kind: 'caja', label: 'Caja', w: 2, h: 1, style: 'bg-emerald-800/60 text-emerald-100' },
  { kind: 'cocina', label: 'Cocina', w: 4, h: 3, style: 'bg-red-900/50 text-red-100' },
  { kind: 'planta', label: 'Planta', w: 1, h: 1, style: 'bg-green-800/60 text-green-100' },
  { kind: 'texto', label: 'Texto', w: 3, h: 1, style: 'text-gray-300' },
];
const kindOf = (k: MapObjectKind) => OBJECT_KINDS.find((o) => o.kind === k)!;

/** Ancho de celda segun el ancho del contenedor. */
function useCell(cols: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState(32);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setCell(Math.max(16, Math.floor(el.clientWidth / cols)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cols]);
  return { ref, cell };
}

function Board({ zone, cell, boardRef, children }: { zone: Zone; cell: number; boardRef: React.RefObject<HTMLDivElement>; children: ReactNode }) {
  const w = zone.map_width || 24;
  const h = zone.map_height || 16;
  return (
    <div ref={boardRef} className="w-full overflow-x-auto">
      <div className="relative rounded-xl border border-gray-800 bg-gray-900"
        style={{ width: cell * w, height: cell * h, backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px)', backgroundSize: `${cell}px ${cell}px` }}>
        {children}
      </div>
    </div>
  );
}

/** Plano de solo lectura para la caja: cada mesa con su estado; tocarla abre la orden. */
export function FloorPlanView({ zone, tables, objects, onPick }: { zone: Zone; tables: DiningTable[]; objects: ZoneMapObject[]; onPick: (t: DiningTable) => void }) {
  const { ref, cell } = useCell(zone.map_width || 24);
  return (
    <Board zone={zone} cell={cell} boardRef={ref}>
      {objects.map((o, i) => (
        <div key={o.id || i} className={`absolute flex items-center justify-center overflow-hidden rounded-md text-[11px] font-semibold ${kindOf(o.kind).style}`}
          style={{ left: o.x * cell, top: o.y * cell, width: o.w * cell, height: o.h * cell }}>{o.label || (o.kind === 'texto' ? '' : kindOf(o.kind).label)}</div>
      ))}
      {tables.filter((t) => t.map_x != null).map((t) => {
        const busy = t.status === 'ocupada';
        return (
          <button key={t.id} onClick={() => onPick(t)}
            className={`absolute flex flex-col items-center justify-center border-2 p-0.5 text-center leading-tight transition
              ${t.map_shape === 'redonda' ? 'rounded-full' : 'rounded-xl'} ${busy ? 'border-brand bg-brand/25 text-white' : 'border-gray-600 bg-gray-800 text-gray-200 hover:border-gray-400'}`}
            style={{ left: t.map_x! * cell + 2, top: t.map_y! * cell + 2, width: (t.map_w || 2) * cell - 4, height: (t.map_h || 2) * cell - 4 }}>
            <span className="text-sm font-bold">{t.name}</span>
            {cell * (t.map_h || 2) >= 56 && (
              <span className={`text-[10px] ${busy ? 'text-brand' : 'text-emerald-400'}`}>
                {busy ? `${formatMXN(t.order_total)}${t.order_status ? ` · ${ORDER_STATUS_LABEL[t.order_status]}` : ''}` : 'Libre'}
              </span>
            )}
            {busy && cell * (t.map_h || 2) >= 72 && <span className="text-[10px] text-gray-400">{formatTime(t.order_created_at)}</span>}
          </button>
        );
      })}
    </Board>
  );
}

type Sel = { type: 'table'; id: string } | { type: 'object'; index: number } | null;

/** Editor del plano de una zona: arrastrar mesas y elementos sobre la cuadricula. */
export function FloorPlanEditor({ zone, tables: initialTables, objects: initialObjects, onClose, onSaved }: {
  zone: Zone; tables: DiningTable[]; objects: ZoneMapObject[]; onClose: () => void; onSaved: () => void;
}) {
  const [size, setSize] = useState({ w: zone.map_width || 24, h: zone.map_height || 16 });
  const [tables, setTables] = useState(initialTables.filter((t) => t.zone_id === zone.id).map((t) => ({ ...t, map_w: t.map_w || 2, map_h: t.map_h || 2, map_shape: t.map_shape || 'cuadrada' })));
  const [objects, setObjects] = useState<ZoneMapObject[]>(initialObjects.filter((o) => o.zone_id === zone.id));
  const [sel, setSel] = useState<Sel>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { ref, cell } = useCell(size.w);
  const drag = useRef<{ sel: Sel; startX: number; startY: number; x: number; y: number } | null>(null);
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));

  function startDrag(e: ReactPointerEvent, s: NonNullable<Sel>, x: number, y: number) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setSel(s);
    drag.current = { sel: s, startX: e.clientX, startY: e.clientY, x, y };
  }
  function onMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d || !d.sel) return;
    const nx = d.x + Math.round((e.clientX - d.startX) / cell);
    const ny = d.y + Math.round((e.clientY - d.startY) / cell);
    if (d.sel.type === 'table') {
      const id = d.sel.id;
      setTables((ts) => ts.map((t) => (t.id === id ? { ...t, map_x: clamp(nx, size.w - t.map_w), map_y: clamp(ny, size.h - t.map_h) } : t)));
    } else {
      const idx = d.sel.index;
      setObjects((os) => os.map((o, i) => (i === idx ? { ...o, x: clamp(nx, size.w - o.w), y: clamp(ny, size.h - o.h) } : o)));
    }
  }
  const endDrag = () => { drag.current = null; };

  // Primer hueco libre para una mesa nueva en el plano.
  function freeSpot(w: number, h: number) {
    const busy = (x: number, y: number) => tables.some((t) => t.map_x != null && x < t.map_x + t.map_w && t.map_x < x + w && y < t.map_y! + t.map_h && t.map_y! < y + h)
      || objects.some((o) => x < o.x + o.w && o.x < x + w && y < o.y + o.h && o.y < y + h);
    for (let y = 0; y + h <= size.h; y += 1) for (let x = 0; x + w <= size.w; x += 1) if (!busy(x, y)) return { x, y };
    return { x: 0, y: 0 };
  }
  const place = (id: string) => setTables((ts) => {
    const t = ts.find((x) => x.id === id)!;
    const spot = freeSpot(t.map_w, t.map_h);
    setSel({ type: 'table', id });
    return ts.map((x) => (x.id === id ? { ...x, map_x: spot.x, map_y: spot.y } : x));
  });
  function addObject(kind: MapObjectKind) {
    const k = kindOf(kind);
    const spot = freeSpot(k.w, k.h);
    setObjects((os) => { setSel({ type: 'object', index: os.length }); return [...os, { kind, label: kind === 'texto' ? 'Texto' : null, x: spot.x, y: spot.y, w: k.w, h: k.h }]; });
  }

  const selTable = sel?.type === 'table' ? tables.find((t) => t.id === sel.id) : null;
  const selObject = sel?.type === 'object' ? objects[sel.index] : null;
  const resize = (dw: number, dh: number) => {
    if (selTable) {
      setTables((ts) => ts.map((t) => {
        if (t.id !== selTable.id) return t;
        const w = Math.max(1, Math.min(12, t.map_w + dw, size.w - (t.map_x || 0)));
        const h = Math.max(1, Math.min(12, t.map_h + dh, size.h - (t.map_y || 0)));
        return { ...t, map_w: w, map_h: h };
      }));
    } else if (selObject && sel?.type === 'object') {
      setObjects((os) => os.map((o, i) => (i === sel.index ? { ...o, w: Math.max(1, Math.min(size.w - o.x, o.w + dw)), h: Math.max(1, Math.min(size.h - o.y, o.h + dh)) } : o)));
    }
  };

  async function save() {
    setSaving(true);
    setError('');
    try {
      await api(`/pos/zones/${zone.id}/map`, { method: 'PUT', body: {
        map_enabled: true, map_width: size.w, map_height: size.h,
        tables: tables.map((t) => ({ id: t.id, map_x: t.map_x ?? null, map_y: t.map_y ?? null, map_w: t.map_w, map_h: t.map_h, map_shape: t.map_shape })),
        objects: objects.map(({ kind, label, x, y, w, h }) => ({ kind, label, x, y, w, h })),
      } });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const unplaced = tables.filter((t) => t.map_x == null);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-950">
      <header className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-4 py-3">
        <h2 className="font-semibold text-white">Plano · {zone.name}</h2>
        <span className="text-xs text-gray-500">Arrastra mesas y elementos. Tamaño del plano:</span>
        <input className="input w-20 py-1" type="number" min={8} max={60} value={size.w} onChange={(e) => setSize({ ...size, w: Math.max(8, Math.min(60, Number(e.target.value) || 8)) })} aria-label="Ancho" />
        <span className="text-gray-500">×</span>
        <input className="input w-20 py-1" type="number" min={6} max={60} value={size.h} onChange={(e) => setSize({ ...size, h: Math.max(6, Math.min(60, Number(e.target.value) || 6)) })} aria-label="Alto" />
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={onClose}><X className="h-4 w-4" /> Cerrar</Button>
          <Button onClick={save} loading={saving}><Save className="h-4 w-4" /> Guardar plano</Button>
        </div>
      </header>
      {error && <div className="px-4 pt-3"><Alert>{error}</Alert></div>}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 lg:flex-row">
        <div className="min-w-0 flex-1" onPointerMove={onMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <Board zone={{ ...zone, map_width: size.w, map_height: size.h }} cell={cell} boardRef={ref}>
            {objects.map((o, i) => (
              <div key={i} onPointerDown={(e) => startDrag(e, { type: 'object', index: i }, o.x, o.y)}
                className={`absolute flex cursor-move touch-none select-none items-center justify-center overflow-hidden rounded-md text-[11px] font-semibold ${kindOf(o.kind).style} ${sel?.type === 'object' && sel.index === i ? 'ring-2 ring-brand' : ''}`}
                style={{ left: o.x * cell, top: o.y * cell, width: o.w * cell, height: o.h * cell }}>{o.label || (o.kind === 'texto' ? '' : kindOf(o.kind).label)}</div>
            ))}
            {tables.filter((t) => t.map_x != null).map((t) => (
              <div key={t.id} onPointerDown={(e) => startDrag(e, { type: 'table', id: t.id }, t.map_x!, t.map_y!)}
                className={`absolute flex cursor-move touch-none select-none flex-col items-center justify-center border-2 bg-gray-800 text-gray-100
                  ${t.map_shape === 'redonda' ? 'rounded-full' : 'rounded-xl'} ${sel?.type === 'table' && sel.id === t.id ? 'border-brand' : 'border-gray-500'}`}
                style={{ left: t.map_x! * cell + 2, top: t.map_y! * cell + 2, width: t.map_w * cell - 4, height: t.map_h * cell - 4 }}>
                <span className="text-sm font-bold">{t.name}</span>
                <span className="text-[10px] text-gray-400">{t.capacity} p.</span>
              </div>
            ))}
          </Board>
        </div>
        <aside className="w-full space-y-4 lg:w-72">
          <section className="card p-3">
            <h3 className="mb-2 text-sm font-semibold text-white">Mesas sin acomodar</h3>
            {unplaced.length === 0 ? <p className="text-xs text-gray-500">Todas están en el plano.</p> : (
              <div className="flex flex-wrap gap-2">
                {unplaced.map((t) => <button key={t.id} className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-white hover:bg-gray-700" onClick={() => place(t.id)}>+ {t.name}</button>)}
              </div>
            )}
          </section>
          <section className="card p-3">
            <h3 className="mb-2 text-sm font-semibold text-white">Agregar elemento</h3>
            <div className="flex flex-wrap gap-2">
              {OBJECT_KINDS.map((k) => <button key={k.kind} className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700" onClick={() => addObject(k.kind)}>{k.label}</button>)}
            </div>
          </section>
          {(selTable || selObject) && (
            <section className="card space-y-3 p-3">
              <h3 className="text-sm font-semibold text-white">{selTable ? `Mesa ${selTable.name}` : kindOf(selObject!.kind).label}</h3>
              <div className="flex items-center gap-2 text-sm text-gray-300">
                <span className="w-14">Ancho</span>
                <button className="rounded bg-gray-800 p-1" onClick={() => resize(-1, 0)} aria-label="Menos ancho"><Minus className="h-4 w-4" /></button>
                <span className="w-6 text-center">{selTable ? selTable.map_w : selObject!.w}</span>
                <button className="rounded bg-gray-800 p-1" onClick={() => resize(1, 0)} aria-label="Más ancho"><Plus className="h-4 w-4" /></button>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-300">
                <span className="w-14">Alto</span>
                <button className="rounded bg-gray-800 p-1" onClick={() => resize(0, -1)} aria-label="Menos alto"><Minus className="h-4 w-4" /></button>
                <span className="w-6 text-center">{selTable ? selTable.map_h : selObject!.h}</span>
                <button className="rounded bg-gray-800 p-1" onClick={() => resize(0, 1)} aria-label="Más alto"><Plus className="h-4 w-4" /></button>
              </div>
              {selTable && (
                <div className="flex gap-2">
                  {(['cuadrada', 'redonda'] as const).map((sh) => (
                    <button key={sh} onClick={() => setTables((ts) => ts.map((t) => (t.id === selTable.id ? { ...t, map_shape: sh } : t)))}
                      className={`flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs ${selTable.map_shape === sh ? 'border-brand text-white' : 'border-gray-700 text-gray-400'}`}>
                      {sh === 'cuadrada' ? <Square className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />} {sh === 'cuadrada' ? 'Cuadrada' : 'Redonda'}
                    </button>
                  ))}
                </div>
              )}
              {selObject && sel?.type === 'object' && (
                <Field label="Texto (opcional)">
                  <input className="input" maxLength={40} value={selObject.label || ''} onChange={(e) => setObjects((os) => os.map((o, i) => (i === sel.index ? { ...o, label: e.target.value || null } : o)))} />
                </Field>
              )}
              <Button variant="ghost" onClick={() => {
                if (selTable) setTables((ts) => ts.map((t) => (t.id === selTable.id ? { ...t, map_x: null, map_y: null } : t)));
                else if (sel?.type === 'object') setObjects((os) => os.filter((_, i) => i !== sel.index));
                setSel(null);
              }}><Trash2 className="h-4 w-4" /> {selTable ? 'Quitar del plano' : 'Borrar elemento'}</Button>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
