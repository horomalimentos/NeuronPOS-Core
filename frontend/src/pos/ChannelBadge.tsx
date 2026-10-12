/** Plataforma de delivery de la orden (nombre, color y numero de pedido). */
export default function ChannelBadge({ name, color, number }: { name: string; color?: string | null; number?: string | null }) {
  return (
    <span className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-200">
      <span className="h-2 w-2 rounded-full" style={{ background: color || '#6b7280' }} />
      {name}{number && ` #${number}`}
    </span>
  );
}
