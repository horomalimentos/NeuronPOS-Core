import { useState } from 'react';
import { CUISINES } from './lib';


const OTHER = '__otra__';

/**
 * Lista de tipos de comida con la opcion "Otra" para escribirlo. Un valor que
 * no esta en la lista (fichas viejas) se muestra como "Otra" con su texto.
 */
export default function CuisineSelect({ value, onChange, className = 'input' }: {
  value: string; onChange: (v: string) => void; className?: string;
}) {
  const [other, setOther] = useState(value !== '' && !CUISINES.includes(value));
  return (
    <div className="space-y-2">
      <select className={className} value={other ? OTHER : value}
        onChange={(e) => {
          const v = e.target.value;
          setOther(v === OTHER);
          onChange(v === OTHER ? '' : v);
        }}>
        <option value="">Elige el tipo de comida</option>
        {CUISINES.map((c) => <option key={c} value={c}>{c}</option>)}
        <option value={OTHER}>Otra…</option>
      </select>
      {other && (
        <input className={className} maxLength={60} value={value} onChange={(e) => onChange(e.target.value)}
          placeholder="Escribe el tipo de comida" autoFocus />
      )}
    </div>
  );
}
