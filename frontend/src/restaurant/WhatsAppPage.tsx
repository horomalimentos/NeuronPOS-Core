import {
  AlertTriangle, Bot, Check, CheckCheck, Copy, MessageCircle, Plus, Search, Send, Settings2, Trash2, UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Field, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatDateTime } from '../pos/lib';
import { useAdmin } from './context';

interface Conversation {
  id: string; wa_id: string; profile_name: string | null; mode: 'bot' | 'humano'; needs_attention: boolean; state: string;
  unread: number; last_inbound_at: string | null; last_message_at: string; last_message_preview?: string | null;
  window_open?: boolean; cart_items?: number;
}
interface ChatMessage {
  id: string; direction: 'in' | 'out'; sender: 'cliente' | 'bot' | 'personal'; type: string; body: string | null;
  status: 'recibido' | 'enviado' | 'entregado' | 'leido' | 'fallido'; error: string | null; created_at: string; sent_by_name: string | null;
}
interface ChatOrder { id: string; folio: number; total: string; status: string; online_status: string | null; created_at: string }
interface Faq { question: string; answer: string }
interface Settings {
  enabled: boolean; phone_number_id: string | null; display_phone: string | null; has_access_token: boolean; has_app_secret: boolean;
  platform_app_secret: boolean; verify_token: string | null; bot_enabled: boolean; welcome_text: string | null; faqs: Faq[];
  notify_status: boolean; webhook_url: string; secrets_available: boolean;
}

const phone = (wa: string) => (wa.startsWith('521') && wa.length === 13 ? `+52 ${wa.slice(3, 6)} ${wa.slice(6, 9)} ${wa.slice(9)}` : `+${wa}`);

/** Bot de WhatsApp: conversaciones y configuracion del numero (modulo whatsapp). */
export default function WhatsAppPage() {
  const { me } = useAdmin();
  const isAdmin = me.user.role === 'admin';
  const [tab, setTab] = useState<'chats' | 'config'>('chats');
  return (
    <>
      <PageHeader title="WhatsApp" subtitle="El bot toma pedidos y contesta dudas; aquí atiendes a quien pide hablar con una persona." />
      {isAdmin && (
        <div className="mb-6 flex gap-1 border-b border-gray-800">
          {([['chats', 'Conversaciones', MessageCircle], ['config', 'Configuración', Settings2]] as const).map(([k, label, Icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-brand text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>
      )}
      {tab === 'chats' ? <Chats /> : <SettingsForm />}
    </>
  );
}

function Chats() {
  const [filter, setFilter] = useState<'atencion' | 'todas'>('atencion');
  const [q, setQ] = useState('');
  const [list, setList] = useState<Conversation[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ filter });
    if (q.trim()) params.set('q', q.trim());
    api<{ conversations: Conversation[] }>(`/whatsapp/conversations?${params}`)
      .then((r) => { setList(r.conversations); setError(''); })
      .catch((e) => setError(errorMessage(e)));
  }, [filter, q]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <section className="card flex max-h-[75vh] flex-col overflow-hidden">
        <div className="space-y-2 border-b border-gray-800 p-3">
          <div className="flex gap-1">
            {([['atencion', 'Por atender'], ['todas', 'Todas']] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setFilter(k)}
                className={`rounded-lg px-3 py-1 text-sm ${filter === k ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>{label}</button>
            ))}
          </div>
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
            <input className="input pl-8" placeholder="Nombre o teléfono" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
        {error && <div className="p-3"><Alert>{error}</Alert></div>}
        {!list ? <Spinner /> : list.length === 0 ? (
          <p className="p-5 text-sm text-gray-500">{filter === 'atencion' ? 'Nadie está esperando a una persona. El bot está atendiendo.' : 'Todavía no hay conversaciones.'}</p>
        ) : (
          <ul className="flex-1 divide-y divide-gray-800 overflow-y-auto">
            {list.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setOpen(c.id)}
                  className={`w-full px-3 py-2.5 text-left hover:bg-gray-800/50 ${open === c.id ? 'bg-gray-800/70' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-white">{c.profile_name || phone(c.wa_id)}</span>
                    <span className="shrink-0 text-xs text-gray-500">{formatDateTime(c.last_message_at)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="flex-1 truncate text-xs text-gray-400">{c.last_message_preview}</span>
                    {c.needs_attention && <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-gray-900">Atender</span>}
                    {!c.needs_attention && c.mode === 'humano' && <UserRound className="h-3.5 w-3.5 text-sky-300" aria-label="Con una persona" />}
                    {c.unread > 0 && <span className="rounded-full bg-emerald-500 px-1.5 text-[10px] font-bold text-gray-900">{c.unread}</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {open ? <ChatView key={open} id={open} onChanged={load} /> : (
        <section className="card hidden items-center justify-center p-10 text-sm text-gray-500 lg:flex">Elige una conversación.</section>
      )}
    </div>
  );
}

function StatusIcon({ m }: { m: ChatMessage }) {
  if (m.direction === 'in') return null;
  if (m.status === 'fallido') return <span title={m.error || 'No se envió'}><AlertTriangle className="h-3.5 w-3.5 text-red-400" /></span>;
  if (m.status === 'leido') return <CheckCheck className="h-3.5 w-3.5 text-sky-300" aria-label="Leído" />;
  if (m.status === 'entregado') return <CheckCheck className="h-3.5 w-3.5" aria-label="Entregado" />;
  return <Check className="h-3.5 w-3.5" aria-label="Enviado" />;
}

function ChatView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [data, setData] = useState<{ conversation: Conversation; messages: ChatMessage[]; orders: ChatOrder[] } | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const count = data?.messages.length ?? 0;

  const load = useCallback(() => {
    api<{ conversation: Conversation; messages: ChatMessage[]; orders: ChatOrder[] }>(`/whatsapp/conversations/${id}`)
      .then(setData).catch((e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [count]);

  async function act(path: string) {
    setBusy(true);
    try {
      await api(`/whatsapp/conversations/${id}/${path}`, { method: 'POST' });
      load();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api(`/whatsapp/conversations/${id}/messages`, { method: 'POST', body: { text } });
      setText('');
      load();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <section className="card p-5">{error ? <Alert>{error}</Alert> : <Spinner />}</section>;
  const c = data.conversation;
  return (
    <section className="card flex max-h-[75vh] flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-800 p-3">
        <div>
          <div className="font-semibold text-white">{c.profile_name || phone(c.wa_id)}</div>
          <div className="text-xs text-gray-400">
            {phone(c.wa_id)} · {c.mode === 'humano' ? 'Lo atiende una persona' : 'Lo atiende el bot'}
            {c.cart_items ? ` · ${c.cart_items} producto(s) en su carrito` : ''}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {c.needs_attention && <Button variant="secondary" onClick={() => act('seen')} disabled={busy}>Marcar atendido</Button>}
          {c.mode === 'bot'
            ? <Button variant="secondary" onClick={() => act('take')} disabled={busy}><UserRound className="h-4 w-4" /> Atender yo</Button>
            : <Button variant="secondary" onClick={() => act('release')} disabled={busy}><Bot className="h-4 w-4" /> Devolver al bot</Button>}
        </div>
      </header>
      {data.orders.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-gray-800 px-3 py-2 text-xs text-gray-400">
          Pedidos:
          {data.orders.map((o) => (
            <span key={o.id} className="rounded bg-gray-800 px-2 py-0.5 text-gray-300">#{o.folio} · {formatMXN(o.total)}</span>
          ))}
        </div>
      )}
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {data.messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${m.direction === 'in' ? 'rounded-bl-sm bg-gray-800 text-gray-100'
              : m.sender === 'personal' ? 'rounded-br-sm bg-emerald-700/60 text-white' : 'rounded-br-sm bg-gray-700/60 text-gray-200'}`}>
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
              <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-gray-400">
                {m.direction === 'out' && <span>{m.sender === 'bot' ? 'Bot' : m.sent_by_name || 'Personal'} ·</span>}
                {formatDateTime(m.created_at)}
                <StatusIcon m={m} />
              </div>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form onSubmit={send} className="border-t border-gray-800 p-3">
        {error && <div className="mb-2"><Alert>{error}</Alert></div>}
        {c.window_open ? (
          <div className="flex gap-2">
            <textarea className="input min-h-10 flex-1" rows={2} placeholder="Escribe tu respuesta…" value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            <Button type="submit" loading={busy} disabled={!text.trim()} aria-label="Enviar"><Send className="h-4 w-4" /></Button>
          </div>
        ) : (
          <p className="text-sm text-gray-500">Pasaron más de 24 horas desde su último mensaje: WhatsApp no deja escribirle hasta que vuelva a escribir.</p>
        )}
        {c.mode === 'bot' && c.window_open && <p className="mt-1 text-xs text-gray-500">Al contestar, el bot deja de responderle hasta que lo devuelvas.</p>}
      </form>
    </section>
  );
}

function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <input className="input font-mono text-xs" readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="secondary" aria-label={`Copiar ${label}`}
          onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </Field>
  );
}

function SettingsForm() {
  const [s, setS] = useState<Settings | null>(null);
  const [form, setForm] = useState({
    phone_number_id: '', display_phone: '', access_token: '', app_secret: '', welcome_text: '',
    enabled: false, bot_enabled: true, notify_status: true, faqs: [] as Faq[],
  });
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [saving, setSaving] = useState(false);

  const apply = (x: Settings) => {
    setS(x);
    setForm({
      phone_number_id: x.phone_number_id || '', display_phone: x.display_phone || '', access_token: '', app_secret: '',
      welcome_text: x.welcome_text || '', enabled: x.enabled, bot_enabled: x.bot_enabled, notify_status: x.notify_status, faqs: x.faqs,
    });
  };
  useEffect(() => {
    api<{ settings: Settings }>('/whatsapp/settings').then((r) => apply(r.settings)).catch((e) => setError(errorMessage(e)));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setOk('');
    try {
      const body: Record<string, unknown> = {
        phone_number_id: form.phone_number_id || null, display_phone: form.display_phone || null,
        welcome_text: form.welcome_text || null, enabled: form.enabled, bot_enabled: form.bot_enabled,
        notify_status: form.notify_status, faqs: form.faqs.filter((f) => f.question.trim() || f.answer.trim()),
      };
      if (form.access_token) body.access_token = form.access_token;
      if (form.app_secret) body.app_secret = form.app_secret;
      const r = await api<{ settings: Settings }>('/whatsapp/settings', { method: 'PUT', body });
      apply(r.settings);
      setOk('Guardado.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!s) return error ? <Alert>{error}</Alert> : <Spinner />;
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setFaq = (i: number, patch: Partial<Faq>) => set('faqs', form.faqs.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  return (
    <form onSubmit={save} className="grid gap-6 lg:grid-cols-2">
      <section className="card space-y-4 p-5">
        <h2 className="font-semibold text-white">1. Conecta tu número</h2>
        <p className="text-sm text-gray-400">
          En tu app de Meta (developers.facebook.com) › WhatsApp › Configuración, pega esta URL y este token de verificación
          y suscríbete al campo <b>messages</b>. Luego copia aquí el identificador del número y un token de acceso permanente.
        </p>
        <CopyField label="URL del webhook" value={s.webhook_url} />
        {s.verify_token && <CopyField label="Token de verificación" value={s.verify_token} />}
        <Field label="Phone number ID" hint="Número largo que Meta muestra junto a tu número (no es el teléfono).">
          <input className="input" inputMode="numeric" value={form.phone_number_id} onChange={(e) => set('phone_number_id', e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Field label="Teléfono (como lo ven tus clientes)">
          <input className="input" value={form.display_phone} onChange={(e) => set('display_phone', e.target.value)} placeholder="656 123 4567" />
        </Field>
        <Field label="Token de acceso" hint={s.has_access_token ? 'Ya está guardado (cifrado). Escribe uno nuevo solo para cambiarlo.' : 'Token permanente de un usuario del sistema.'}>
          <input className="input" type="password" autoComplete="off" value={form.access_token} onChange={(e) => set('access_token', e.target.value)}
            placeholder={s.has_access_token ? '••••••••' : ''} />
        </Field>
        <Field label={`App secret${s.platform_app_secret ? ' (opcional)' : ''}`}
          hint={s.platform_app_secret ? 'Solo si usas una app de Meta propia; si no, se usa la de NeuronPOS.' : 'Con él se comprueba que los mensajes vienen de Meta.'}>
          <input className="input" type="password" autoComplete="off" value={form.app_secret} onChange={(e) => set('app_secret', e.target.value)}
            placeholder={s.has_app_secret ? '••••••••' : ''} />
        </Field>
        {!s.secrets_available && <Alert kind="warning">El servidor no tiene PAYMENT_SECRETS_KEY: no se pueden guardar llaves.</Alert>}
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="font-semibold text-white">2. El bot</h2>
        {([
          ['enabled', 'WhatsApp activo', 'Recibir y contestar mensajes en este número.'],
          ['bot_enabled', 'Contesta el bot', 'Si lo apagas, todos los mensajes llegan a Conversaciones para una persona.'],
          ['notify_status', 'Avisos del pedido', 'Avisar por WhatsApp cuando el pedido se acepta, está listo o va en camino.'],
        ] as const).map(([k, label, hint]) => (
          <div key={k} className="flex items-start justify-between gap-4">
            <div><div className="text-sm text-white">{label}</div><div className="text-xs text-gray-500">{hint}</div></div>
            <Toggle checked={form[k]} onChange={(v) => set(k, v)} label={label} />
          </div>
        ))}
        <Field label="Saludo" hint="Lo primero que lee el cliente. Si lo dejas vacío: «¡Hola! Soy el asistente de tu restaurante. ¿En qué te ayudo?»">
          <textarea className="input min-h-20" maxLength={600} value={form.welcome_text} onChange={(e) => set('welcome_text', e.target.value)} />
        </Field>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-300">Preguntas frecuentes (aparecen en el menú)</span>
            {form.faqs.length < 5 && (
              <Button type="button" variant="secondary" onClick={() => set('faqs', [...form.faqs, { question: '', answer: '' }])}><Plus className="h-4 w-4" /> Agregar</Button>
            )}
          </div>
          {form.faqs.length === 0 && <p className="text-xs text-gray-500">Por ejemplo: ¿Tienen estacionamiento?, ¿Facturan?</p>}
          <div className="space-y-3">
            {form.faqs.map((f, i) => (
              <div key={i} className="rounded-lg border border-gray-800 p-3">
                <div className="flex gap-2">
                  <input className="input" maxLength={24} placeholder="Pregunta (24 letras)" value={f.question} onChange={(e) => setFaq(i, { question: e.target.value })} />
                  <Button type="button" variant="secondary" aria-label="Quitar pregunta" onClick={() => set('faqs', form.faqs.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                </div>
                <textarea className="input mt-2 min-h-16" maxLength={1000} placeholder="Respuesta" value={f.answer} onChange={(e) => setFaq(i, { answer: e.target.value })} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="flex items-center justify-end gap-3 lg:col-span-2">
        {error && <Alert>{error}</Alert>}
        {ok && <span className="text-sm text-emerald-300">{ok}</span>}
        <Button type="submit" loading={saving}>Guardar</Button>
      </div>
    </form>
  );
}
