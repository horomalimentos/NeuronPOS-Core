import { Megaphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatDateTime } from '../pos/lib';

interface FeedItem { id: string; title: string; body: string; priority: 'normal' | 'importante'; starts_at: string; created_by_name: string | null; read: boolean }

/** Comunicados vigentes en el Inicio; "Enterado" los marca como leidos. */
export default function AnnouncementsFeed() {
  const [items, setItems] = useState<FeedItem[]>([]);
  useEffect(() => { api<{ announcements: FeedItem[] }>('/rh/announcements/feed').then((r) => setItems(r.announcements)).catch(() => {}); }, []);
  if (items.length === 0) return null;
  async function read(id: string) {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, read: true } : x)));
    await api(`/rh/announcements/${id}/read`, { method: 'POST', body: {} }).catch(() => {});
  }
  return (
    <section className="mb-8 space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">Comunicados</h2>
      {items.map((a) => (
        <article key={a.id} className={`card p-4 ${a.read ? 'opacity-60' : a.priority === 'importante' ? 'border-amber-500/40' : 'border-brand/30'}`}>
          <h3 className="flex items-center gap-2 font-semibold text-white">
            <Megaphone className={`h-4 w-4 ${a.priority === 'importante' ? 'text-amber-300' : 'text-brand'}`} /> {a.title}
          </h3>
          <p className="mt-1 whitespace-pre-line text-sm text-gray-300">{a.body}</p>
          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-gray-500">
            <span>{a.created_by_name} · {formatDateTime(a.starts_at)}</span>
            {!a.read && <button className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-white hover:bg-gray-700" onClick={() => read(a.id)}>Enterado</button>}
          </div>
        </article>
      ))}
    </section>
  );
}
