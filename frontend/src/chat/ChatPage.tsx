import { MessageSquare, Pencil, Pin, PinOff, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Button, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { ROLE_LABEL } from '../lib/format';
import type { Role } from '../lib/types';
import { formatDateTime } from '../pos/lib';
import { canManage, useAdmin } from '../restaurant/context';

export interface ChatPost {
  id: string; branch_id: string | null; branch_name: string | null; author_id: string; author_name: string; author_role: string;
  body: string; pinned: boolean; edited_at: string | null; created_at: string; last_activity_at: string; reply_count: number;
}
interface ChatReply { id: string; author_id: string; author_name: string; author_role: string; body: string; created_at: string }

/** Chat del equipo (como el chat del tablero de Horom): mensajes por sucursal, respuestas y fijados. */
export default function ChatPage() {
  const { me } = useAdmin();
  const manager = canManage(me.user.role);
  const branches = manager ? me.branches : me.branches.filter((b) => me.user.branch_ids?.includes(b.id));
  const [posts, setPosts] = useState<ChatPost[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [body, setBody] = useState('');
  const [branchId, setBranchId] = useState(manager ? '' : branches[0]?.id || '');
  const [sending, setSending] = useState(false);

  // Paginas viejas cargadas con "Ver anteriores": al refrescar se conservan.
  const extraPages = useRef(false);

  const load = useCallback(() => {
    api<{ posts: ChatPost[]; has_more: boolean; seen_at: string | null }>('/chat/posts')
      .then((r) => {
        const oldest = r.posts.filter((p) => !p.pinned).at(-1)?.last_activity_at;
        setPosts((prev) => {
          if (!extraPages.current || !oldest) return r.posts;
          const older = (prev || []).filter((p) => !p.pinned && !r.posts.some((n) => n.id === p.id) && p.last_activity_at < oldest);
          return [...r.posts, ...older];
        });
        if (!extraPages.current) setHasMore(r.has_more);
        // La primera vez se guarda hasta donde habia leido, para resaltar lo nuevo.
        setSeenAt((s) => s ?? r.seen_at ?? '');
        void api('/chat/seen', { method: 'POST' }).catch(() => {});
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function loadMore() {
    const last = posts?.filter((p) => !p.pinned).at(-1);
    if (!last) return;
    try {
      const r = await api<{ posts: ChatPost[]; has_more: boolean }>(`/chat/posts?before=${encodeURIComponent(last.last_activity_at)}`);
      extraPages.current = true;
      setPosts((prev) => [...(prev || []), ...r.posts.filter((p) => !prev?.some((x) => x.id === p.id))]);
      setHasMore(r.has_more);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function publish(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    setError('');
    try {
      const r = await api<{ post: ChatPost }>('/chat/posts', { method: 'POST', body: { body, branch_id: branchId || null } });
      setPosts((prev) => {
        const list = [...(prev || [])];
        const pinnedCount = list.filter((p) => p.pinned).length;
        list.splice(pinnedCount, 0, r.post);
        return list;
      });
      setBody('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  const replace = (post: ChatPost) => setPosts((prev) => {
    const list = (prev || []).map((p) => (p.id === post.id ? post : p));
    return [...list.filter((p) => p.pinned), ...list.filter((p) => !p.pinned)];
  });
  const removePost = (id: string) => setPosts((prev) => (prev || []).filter((p) => p.id !== id));

  return (
    <>
      <PageHeader title="Chat del equipo" subtitle="Mensajes para el personal. Los de una sucursal solo los ve quien trabaja ahí." />
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      <form onSubmit={publish} className="card mb-6 space-y-3 p-4">
        <textarea className="input min-h-20" maxLength={2000} placeholder="Escribe un mensaje para el equipo" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {(manager || branches.length > 1) && (
            <select className="input w-auto" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label="Sucursal">
              {manager && <option value="">Todas las sucursales</option>}
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          <Button type="submit" loading={sending} disabled={!body.trim() || (!manager && !branchId)}><Send className="h-4 w-4" /> Publicar</Button>
        </div>
      </form>
      {!posts ? <Spinner /> : (
        <div className="space-y-3">
          {posts.length === 0 && <p className="card p-6 text-center text-sm text-gray-500">Todavía no hay mensajes. Escribe el primero.</p>}
          {posts.map((p) => (
            <PostCard key={p.id} post={p} meId={me.user.id} manager={manager} isNew={Boolean(seenAt !== null && seenAt !== '' && p.author_id !== me.user.id && p.last_activity_at > seenAt)}
              onChange={replace} onDelete={removePost} onError={setError} />
          ))}
          {hasMore && <div className="text-center"><Button variant="secondary" onClick={() => void loadMore()}>Ver anteriores</Button></div>}
        </div>
      )}
    </>
  );
}

function PostCard({ post, meId, manager, isNew, onChange, onDelete, onError }: {
  post: ChatPost; meId: string; manager: boolean; isNew: boolean;
  onChange: (p: ChatPost) => void; onDelete: (id: string) => void; onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [replies, setReplies] = useState<ChatReply[] | null>(null);
  const [reply, setReply] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = post.author_id === meId;

  const loadReplies = useCallback(() => {
    api<{ replies: ChatReply[] }>(`/chat/posts/${post.id}/replies`).then((r) => setReplies(r.replies)).catch((e) => onError(errorMessage(e)));
  }, [post.id, onError]);
  // Si llegan respuestas nuevas mientras esta abierto, se recargan.
  useEffect(() => { if (open) loadReplies(); }, [open, post.reply_count, loadReplies]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { onError(errorMessage(e)); } finally { setBusy(false); }
  }
  const sendReply = (e: FormEvent) => {
    e.preventDefault();
    if (!reply.trim()) return;
    void run(async () => {
      const r = await api<{ reply: ChatReply }>(`/chat/posts/${post.id}/replies`, { method: 'POST', body: { body: reply } });
      setReplies((prev) => [...(prev || []), r.reply]);
      setReply('');
      onChange({ ...post, reply_count: post.reply_count + 1, last_activity_at: r.reply.created_at });
    });
  };
  const togglePin = () => run(async () => {
    const r = await api<{ post: ChatPost }>(`/chat/posts/${post.id}/pin`, { method: 'PATCH', body: { pinned: !post.pinned } });
    onChange(r.post);
  });
  const saveEdit = () => run(async () => {
    const r = await api<{ post: ChatPost }>(`/chat/posts/${post.id}`, { method: 'PUT', body: { body: editing } });
    onChange(r.post);
    setEditing(null);
  });
  const remove = () => {
    if (!confirm('¿Borrar este mensaje y sus respuestas?')) return;
    void run(async () => {
      await api(`/chat/posts/${post.id}`, { method: 'DELETE' });
      onDelete(post.id);
    });
  };
  const removeReply = (r: ChatReply) => {
    if (!confirm('¿Borrar esta respuesta?')) return;
    void run(async () => {
      await api(`/chat/replies/${r.id}`, { method: 'DELETE' });
      setReplies((prev) => (prev || []).filter((x) => x.id !== r.id));
      onChange({ ...post, reply_count: Math.max(0, post.reply_count - 1) });
    });
  };

  return (
    <article className={`card p-4 ${post.pinned ? 'border-amber-500/40' : ''} ${isNew ? 'ring-1 ring-brand/50' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm">
          <span className="font-semibold text-white">{post.author_name}</span>
          <span className="text-gray-500"> · {ROLE_LABEL[post.author_role as Role] || post.author_role} · {post.branch_name || 'Todas las sucursales'}</span>
          {post.pinned && <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300"><Pin className="h-3 w-3" /> Fijado</span>}
        </div>
        <div className="flex shrink-0 gap-1">
          {manager && (
            <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-amber-300" disabled={busy} onClick={() => void togglePin()} aria-label={post.pinned ? 'Desfijar' : 'Fijar'} title={post.pinned ? 'Desfijar' : 'Fijar arriba'}>
              {post.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            </button>
          )}
          {mine && editing === null && (
            <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditing(post.body)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
          )}
          {(mine || manager) && (
            <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" disabled={busy} onClick={remove} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>
          )}
        </div>
      </div>
      {editing !== null ? (
        <div className="mt-2 space-y-2">
          <textarea className="input min-h-20" maxLength={2000} value={editing} onChange={(e) => setEditing(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button loading={busy} disabled={!editing.trim()} onClick={() => void saveEdit()}>Guardar</Button>
          </div>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-line break-words text-sm text-gray-200">{post.body}</p>
      )}
      <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
        <span>{formatDateTime(post.created_at)}{post.edited_at && ' · editado'}</span>
        <button className="flex items-center gap-1 text-gray-400 hover:text-white" onClick={() => setOpen(!open)}>
          <MessageSquare className="h-3.5 w-3.5" /> {post.reply_count ? `${post.reply_count} ${post.reply_count === 1 ? 'respuesta' : 'respuestas'}` : 'Responder'}
        </button>
      </div>
      {open && (
        <div className="mt-3 space-y-2 border-l-2 border-gray-800 pl-3">
          {!replies ? <Spinner /> : replies.map((r) => (
            <div key={r.id} className="group text-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="break-words text-gray-200"><span className="font-semibold text-white">{r.author_name}</span> {r.body}</p>
                {(r.author_id === meId || manager) && (
                  <button className="rounded p-1 text-gray-500 hover:text-red-300" onClick={() => removeReply(r)} aria-label="Borrar respuesta"><Trash2 className="h-3.5 w-3.5" /></button>
                )}
              </div>
              <p className="text-xs text-gray-500">{formatDateTime(r.created_at)}</p>
            </div>
          ))}
          <form onSubmit={sendReply} className="flex gap-2">
            <input className="input" maxLength={1000} placeholder="Escribe una respuesta" value={reply} onChange={(e) => setReply(e.target.value)} />
            <Button type="submit" loading={busy} disabled={!reply.trim()} aria-label="Enviar"><Send className="h-4 w-4" /></Button>
          </form>
        </div>
      )}
    </article>
  );
}
