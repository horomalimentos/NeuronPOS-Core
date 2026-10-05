import { Clock, MapPin, Navigation, Phone } from 'lucide-react';
import type { PublicBranch } from '../lib/types';
import { openLabel, weekSchedule } from './hours';

/** Sucursales con direccion, telefono, enlace a Google Maps y horario semanal. */
export default function BranchCards({ branches }: { branches: PublicBranch[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {branches.map((b) => (
        <article key={b.id} className="card-light flex flex-col p-5">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-lg font-bold text-gray-900">{b.name}</h3>
            <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold
              ${b.open_now ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}>
              {openLabel(b)}
            </span>
          </div>
          <div className="mt-3 space-y-1.5 text-sm text-gray-600">
            {b.address && <p className="flex gap-2"><MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" />{b.address}</p>}
            {b.phone && (
              <p className="flex gap-2"><Phone className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" />
                <a href={`tel:${b.phone.replace(/[^+\d]/g, '')}`} className="hover:text-brand">{b.phone}</a>
              </p>
            )}
          </div>
          {b.hours.length > 0 && (
            <details className="mt-3 text-sm text-gray-600">
              <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-gray-800">
                <Clock className="h-4 w-4 text-brand" /> Horario
              </summary>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 pl-6">
                {weekSchedule(b.hours).map((d) => (
                  <div key={d.day} className="contents"><dt>{d.day}</dt><dd className="text-right">{d.text}</dd></div>
                ))}
              </dl>
              {b.closures.length > 0 && (
                <p className="mt-2 pl-6 text-xs text-amber-700">
                  Cerrado: {b.closures.map((c) => `${new Date(`${c.closed_on}T12:00:00`).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}${c.reason ? ` (${c.reason})` : ''}`).join(', ')}
                </p>
              )}
            </details>
          )}
          {b.maps_url && (
            <a href={b.maps_url} target="_blank" rel="noopener noreferrer" className="btn-outline mt-4 self-start py-2">
              <Navigation className="h-4 w-4" /> Cómo llegar
            </a>
          )}
        </article>
      ))}
    </div>
  );
}
