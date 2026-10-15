import { MapPin } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { loadGoogleMaps } from '../lib/googleMaps';
import type { Point } from './ZoneMap';

interface Suggestion { id: string; main: string; secondary: string; prediction: google.maps.places.PlacePrediction }

/**
 * Campo de direccion que sugiere direcciones de Google conforme se escribe
 * (Places API New). Al elegir una llama onPlace con la direccion completa y
 * el punto. Sin llave de Google (o si Places falla) es un campo normal.
 */
export default function AddressAutocomplete({
  value, onChange, onPlace, near, className = 'input', placeholder, required, maxLength, onEnter, light = false,
}: {
  value: string; onChange: (v: string) => void; onPlace: (p: { address: string; point: Point }) => void;
  near?: Point | null; className?: string; placeholder?: string; required?: boolean; maxLength?: number;
  /** Enter sin sugerencia seleccionada (p. ej. buscar con el geocodificador). */
  onEnter?: () => void;
  /** Lista en colores claros (sitio del restaurante). */
  light?: boolean;
}) {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const token = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const typed = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!typed.current || value.trim().length < 3) { setItems([]); return undefined; }
    let alive = true;
    const t = setTimeout(async () => {
      const g = await loadGoogleMaps();
      if (!g || !alive) return;
      try {
        const places = (await g.maps.importLibrary('places')) as google.maps.PlacesLibrary;
        token.current ??= new places.AutocompleteSessionToken();
        const req: google.maps.places.AutocompleteRequest = {
          input: value, sessionToken: token.current, includedRegionCodes: ['mx'], language: 'es', region: 'mx',
        };
        if (near) req.locationBias = { center: { lat: near.latitude, lng: near.longitude }, radius: 30000 };
        const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions(req);
        if (!alive) return;
        setItems(suggestions.flatMap((s) => (s.placePrediction ? [{
          id: s.placePrediction.placeId,
          main: s.placePrediction.mainText?.toString() ?? s.placePrediction.text.toString(),
          secondary: s.placePrediction.secondaryText?.toString() ?? '',
          prediction: s.placePrediction,
        }] : [])));
        setActive(-1);
        setOpen(true);
      } catch {
        if (alive) setItems([]);
      }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [value, near]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = async (s: Suggestion) => {
    setOpen(false);
    setItems([]);
    typed.current = false;
    try {
      const place = s.prediction.toPlace();
      await place.fetchFields({ fields: ['formattedAddress', 'location'] });
      token.current = null; // la sesion termina al pedir el detalle
      const address = place.formattedAddress || [s.main, s.secondary].filter(Boolean).join(', ');
      onChange(address);
      if (place.location) onPlace({ address, point: { latitude: place.location.lat(), longitude: place.location.lng() } });
    } catch {
      onChange([s.main, s.secondary].filter(Boolean).join(', '));
    }
  };

  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && items.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a <= 0 ? items.length - 1 : a - 1)); return; }
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key === 'Enter' && active >= 0) { e.preventDefault(); void choose(items[active]); return; }
    }
    if (e.key === 'Enter' && onEnter) { e.preventDefault(); setOpen(false); onEnter(); }
  };

  return (
    <div ref={box} className="relative w-full">
      <input className={`${className} w-full`} value={value} required={required} maxLength={maxLength} placeholder={placeholder}
        autoComplete="off" role="combobox" aria-expanded={open && items.length > 0} aria-autocomplete="list"
        onChange={(e) => { typed.current = true; onChange(e.target.value); }}
        onFocus={() => { if (items.length) setOpen(true); }} onKeyDown={keys} />
      {open && items.length > 0 && (
        <ul role="listbox" className={`absolute left-0 right-0 z-[1100] mt-1 overflow-hidden rounded-xl border py-1 shadow-2xl ${light ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900'}`}>
          {items.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void choose(s)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm ${light ? (i === active ? 'bg-gray-100' : 'hover:bg-gray-100') : (i === active ? 'bg-gray-800' : 'hover:bg-gray-800')}`}>
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                <span className="min-w-0">
                  <span className={`block truncate ${light ? 'text-gray-900' : 'text-gray-100'}`}>{s.main}</span>
                  {s.secondary && <span className="block truncate text-xs text-gray-500">{s.secondary}</span>}
                </span>
              </button>
            </li>
          ))}
          <li className="px-3 pb-1 pt-1.5 text-right text-[10px] text-gray-500">con Google</li>
        </ul>
      )}
    </div>
  );
}
