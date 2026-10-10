import ZoneMap, { MapTools, type Point } from '../components/ZoneMap';

/**
 * Epicentro y radio del repartidor: busca o toca el mapa para el centro y
 * elige los km a la redonda con la barra. El circulo muestra la zona.
 */
export default function ZoneFields({ base, radius, maxRadius, onBase, onRadius }: {
  base: Point | null; radius: number; maxRadius: number; onBase: (p: Point) => void; onRadius: (km: number) => void;
}) {
  return (
    <div className="space-y-2">
      <MapTools onPoint={onBase} near={base} />
      <ZoneMap className="h-64" center={base} tiers={base ? [{ radius_km: radius, fee: 0 }] : []} onPick={onBase} />
      <p className="text-xs text-gray-500">
        {base ? 'Toca el mapa para mover tu epicentro.' : 'Tu epicentro es desde donde sueles salir (tu casa o tu base). Búscalo o toca el mapa.'}
      </p>
      <label className="block pt-1">
        <span className="flex items-center justify-between text-sm font-medium text-gray-300">
          Kilómetros a la redonda <b className="text-white">{radius} km</b>
        </span>
        <input type="range" min={1} max={maxRadius} step={0.5} value={radius} onChange={(e) => onRadius(Number(e.target.value))}
          className="mt-2 w-full accent-[rgb(var(--brand-primary))]" aria-label="Kilómetros a la redonda" />
        <span className="text-xs text-gray-500">Solo te llegan pedidos de restaurantes dentro de este círculo.</span>
      </label>
    </div>
  );
}
