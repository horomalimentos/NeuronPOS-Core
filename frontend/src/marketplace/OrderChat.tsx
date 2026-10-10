import { MessageCircle, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Modal } from '../components/ui';
import { errorMessage } from '../lib/api';
import { formatTime } from '../pos/lib';

export type ChatRole = 'cliente' | 'restaurante' | 'repartidor';
interface Message { id: string; sender: ChatRole; sender_name: string; body: string; created_at: string }
interface Chat { open: boolean; driver_assigned: boolean; messages: Message[] }

const POLL_MS = 8000;
const ROLE_LABEL: Record<ChatRole, string> = { cliente: 'Cliente', restaurante: 'Restaurante', repartidor: 'Repartidor' };
const ROLE_STYLE: Record<ChatRole, string> = {
  cliente: 'text-sky-300', restaurante: 'text-amber-300', repartidor: 'text-emerald-300',
};

// Mensajes ya vistos por pedido (solo en este navegador) para marcar los nuevos.
const SEEN_KEY = 'npd_chat_seen';
function readSeen(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch { return {}; }
}
function markSeen(key: string, n: number) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify({ ...readSeen(), [key]: n })); } catch { /* sin almacenamiento */ }
}

/** Boton "Chat" con los mensajes sin leer; abre el chat del pedido. */
export function ChatButton({ chatKey, count, title, me, path, call, className = '' }: {
  chatKey: string; count: number; title: string; me: ChatRole; path: string;
  call: <T>(path: string, opts?: { method?: string; body?: unknown; noRedirect?: boolean }) => Promise<T>; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => readSeen()[chatKey] ?? 0);
  const unread = Math.max(0, count - seen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={`relative inline-flex items-center gap-1.5 rounded-xl border border-gray-700 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800 ${className}`}>
        <MessageCircle className="h-4 w-4" /> Chat
        {unread > 0 && <span className="rounded-full bg-brand px-1.5 text-[10px] font-semibold text-brand-contrast">{unread}</span>}
      </button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          <OrderChat me={me} path={path} call={call} onSeen={(n) => { markSeen(chatKey, n); setSeen(n); }} />
        </Modal>
      )}
    </>
  );
}

/**
 * Chat de tres partes de un pedido de NeuronPOS Delivery. path es la ruta de
 * mensajes de quien lo usa (cliente por token, restaurante o repartidor).
 */
export default function OrderChat({ me, path, call, onSeen }: {
  me: ChatRole; path: string;
  call: <T>(path: string, opts?: { method?: string; body?: unknown; noRedirect?: boolean }) => Promise<T>;
  onSeen?: (n: number) => void;
}) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // onSeen puede cambiar en cada render: se guarda aparte para no reiniciar el sondeo.
  const seenRef = useRef(onSeen);
  useEffect(() => { seenRef.current = onSeen; }, [onSeen]);

  const apply = useCallback((c: Chat) => { setChat(c); seenRef.current?.(c.messages.length); }, []);
  const load = useCallback(() => {
    call<Chat>(path, { noRedirect: true }).then((c) => { apply(c); setError(''); }).catch((e) => setError(errorMessage(e)));
  }, [call, path, apply]);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  const count = chat?.messages.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [count]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      apply(await call<Chat>(path, { method: 'POST', body: { body: text }, noRedirect: true }));
      setText('');
      setError('');
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <div className="max-h-80 min-h-[8rem] space-y-2 overflow-y-auto rounded-xl bg-gray-950/60 p-3">
        {!chat ? <p className="text-sm text-gray-500">Cargando…</p> : chat.messages.length === 0 ? (
          <p className="text-sm text-gray-500">
            Aquí platican el cliente, el restaurante{chat.driver_assigned ? ' y el repartidor' : ' y, cuando lo tome, el repartidor'}.
          </p>
        ) : chat.messages.map((m) => {
          const mine = m.sender === me;
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-brand/20 text-white' : 'bg-gray-800 text-gray-100'}`}>
                {!mine && <div className={`text-[11px] font-semibold ${ROLE_STYLE[m.sender]}`}>{m.sender_name} · {ROLE_LABEL[m.sender]}</div>}
                <div className="whitespace-pre-wrap break-words">{m.body}</div>
                <div className="mt-0.5 text-right text-[10px] text-gray-500">{formatTime(m.created_at)}</div>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      {error && <Alert>{error}</Alert>}
      {chat && !chat.open ? (
        <p className="text-center text-xs text-gray-500">El pedido terminó; el chat queda solo para consulta.</p>
      ) : (
        <form onSubmit={send} className="flex gap-2">
          <input className="input flex-1" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe un mensaje" aria-label="Mensaje" />
          <Button type="submit" loading={busy} disabled={!text.trim()} aria-label="Enviar"><Send className="h-4 w-4" /></Button>
        </form>
      )}
    </div>
  );
}
