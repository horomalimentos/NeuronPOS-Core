import { Camera, CheckCircle2, Clock, Loader2, MessageSquareWarning, Star, X, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { errorMessage, portalApi } from '../lib/api';
import { MAX_BYTES, shrink } from '../lib/images';
import { Notice } from './OrderPage';
import type { CustomerOrder } from './types';

const MAX_PHOTOS = 4;
const STAR_LABEL = ['', 'Muy mal', 'Mal', 'Regular', 'Bien', 'Excelente'];

function Stars({ value, onChange, size = 'h-8 w-8', label }: {
  value: number; onChange?: (n: number) => void; size?: string; label: string;
}) {
  return (
    <div className="flex items-center gap-1" role={onChange ? 'radiogroup' : undefined} aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => {
        const icon = <Star className={`${size} ${n <= value ? 'fill-amber-400 text-amber-400' : 'text-gray-300'}`} />;
        return onChange ? (
          <button key={n} type="button" role="radio" aria-checked={n === value} aria-label={`${n} de 5`} onClick={() => onChange(n)} className="p-0.5">
            {icon}
          </button>
        ) : <span key={n}>{icon}</span>;
      })}
    </div>
  );
}

/**
 * Calificar el pedido y reportar un problema (modulo quejas). Aparece en el
 * seguimiento cuando el pedido ya se entrego.
 */
export default function FeedbackCard({ order, token, onChange }: {
  order: CustomerOrder; token: string; onChange: (o: CustomerOrder) => void;
}) {
  const f = order.feedback;
  const [complaining, setComplaining] = useState(false);
  if (!f || (!f.can_rate && !f.rating && !f.can_complain && !f.complaint)) return null;
  return (
    <div className="card-light mt-4 space-y-5 p-5">
      {f.can_rate ? <RateForm token={token} onChange={onChange} /> : f.rating && (
        <div>
          <h2 className="font-bold">Tu calificación</h2>
          <div className="mt-1 flex items-center gap-2">
            <Stars value={f.rating.overall} size="h-5 w-5" label="Calificación" />
            <span className="text-sm text-gray-600">{STAR_LABEL[f.rating.overall]}</span>
          </div>
          {f.rating.comment && <p className="mt-1 text-sm italic text-gray-600">“{f.rating.comment}”</p>}
        </div>
      )}

      {f.complaint ? <ComplaintStatus c={f.complaint} />
        : f.can_complain && (complaining
          ? <ComplaintForm order={order} token={token} onChange={onChange} onCancel={() => setComplaining(false)} />
          : (
            <button className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-brand" onClick={() => setComplaining(true)}>
              <MessageSquareWarning className="h-4 w-4" /> ¿Algo salió mal? Repórtalo
            </button>
          ))}
    </div>
  );
}

function RateForm({ token, onChange }: { token: string; onChange: (o: CustomerOrder) => void }) {
  const [overall, setOverall] = useState(0);
  const [food, setFood] = useState(0);
  const [service, setService] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send() {
    setBusy(true);
    setError('');
    try {
      const r = await portalApi<{ order: CustomerOrder }>(`/portal/track/${encodeURIComponent(token)}/rating`, {
        method: 'POST', noRedirect: true,
        body: { overall, food: food || null, service: service || null, comment: comment.trim() || null },
      });
      onChange(r.order);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="font-bold">¿Qué tal estuvo tu pedido?</h2>
      <div className="mt-2 flex items-center gap-3">
        <Stars value={overall} onChange={setOverall} label="Calificación general" />
        {overall > 0 && <span className="text-sm font-medium text-gray-600">{STAR_LABEL[overall]}</span>}
      </div>
      {overall > 0 && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-gray-700">Comida</span>
            <Stars value={food} onChange={setFood} size="h-6 w-6" label="Comida" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-gray-700">Servicio</span>
            <Stars value={service} onChange={setService} size="h-6 w-6" label="Servicio" />
          </div>
          <textarea className="input-light" rows={2} maxLength={500} placeholder="Cuéntanos más (opcional)"
            value={comment} onChange={(e) => setComment(e.target.value)} />
          {error && <Notice kind="error">{error}</Notice>}
          <button className="btn-brand w-full" onClick={send} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enviar calificación
          </button>
        </div>
      )}
    </div>
  );
}

function ComplaintForm({ order, token, onChange, onCancel }: {
  order: CustomerOrder; token: string; onChange: (o: CustomerOrder) => void; onCancel: () => void;
}) {
  const [items, setItems] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [email, setEmail] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const guest = !order.feedback?.has_account;
  const base = `/portal/track/${encodeURIComponent(token)}`;

  const toggle = (id: string) => setItems((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    setError('');
    setUploading(true);
    try {
      for (const file of [...files].slice(0, MAX_PHOTOS - photos.length)) {
        if (!file.type.startsWith('image/')) throw new Error('Elige fotos (JPG, PNG o WebP)');
        const blob = await shrink(file);
        if (blob.size > MAX_BYTES) throw new Error('Una foto pesa más de 5 MB');
        const r = await portalApi<{ url: string }>(`${base}/evidence`, { method: 'POST', file: blob, noRedirect: true });
        setPhotos((l) => [...l, r.url]);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  async function send() {
    setBusy(true);
    setError('');
    try {
      const r = await portalApi<{ order: CustomerOrder }>(`${base}/complaint`, {
        method: 'POST', noRedirect: true,
        body: { reason: reason.trim(), item_ids: items, evidence_urls: photos, contact_email: email.trim() || null },
      });
      onChange(r.order);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-bold">Reportar un problema</h2>
        <button onClick={onCancel} aria-label="Cerrar" className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
      </div>
      <p className="mt-1 text-sm text-gray-500">El restaurante lo revisa y te responde aquí{guest ? ' y por correo si lo dejas' : ' y por correo'}.</p>

      <p className="label-light mt-4">¿Con qué productos? (opcional)</p>
      <div className="space-y-1.5">
        {order.items.map((it) => (
          <label key={it.id} className="flex items-center gap-2.5 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-brand" checked={items.includes(it.id)} onChange={() => toggle(it.id)} />
            {it.quantity} × {it.name}
          </label>
        ))}
      </div>

      <label className="label-light mt-4" htmlFor="queja-motivo">¿Qué pasó?</label>
      <textarea id="queja-motivo" className="input-light" rows={3} maxLength={1000} placeholder="Ej. los tacos llegaron fríos"
        value={reason} onChange={(e) => setReason(e.target.value)} />

      <p className="label-light mt-4">Fotos (hasta {MAX_PHOTOS})</p>
      <div className="flex flex-wrap gap-2">
        {photos.map((u) => (
          <div key={u} className="relative h-20 w-20 overflow-hidden rounded-xl border border-gray-200">
            <img src={u} alt="Evidencia" className="h-full w-full object-cover" />
            <button className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white" aria-label="Quitar foto"
              onClick={() => setPhotos((l) => l.filter((x) => x !== u))}><X className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        {photos.length < MAX_PHOTOS && (
          <button type="button" onClick={() => input.current?.click()} disabled={uploading}
            className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-gray-300 text-xs text-gray-500 hover:border-brand hover:text-brand">
            {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />} Agregar
          </button>
        )}
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void addPhotos(e.target.files)} />
      </div>

      {guest && (
        <>
          <label className="label-light mt-4" htmlFor="queja-correo">Tu correo para responderte (opcional)</label>
          <input id="queja-correo" type="email" className="input-light" value={email} onChange={(e) => setEmail(e.target.value)} />
        </>
      )}

      {error && <div className="mt-3"><Notice kind="error">{error}</Notice></div>}
      <button className="btn-brand mt-4 w-full" onClick={send} disabled={busy || uploading || reason.trim().length < 3}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enviar
      </button>
    </div>
  );
}

function ComplaintStatus({ c }: { c: NonNullable<NonNullable<CustomerOrder['feedback']>['complaint']> }) {
  const view = c.status === 'pendiente'
    ? { icon: Clock, tone: 'bg-amber-50 text-amber-900', title: 'Recibimos tu reporte', text: 'El restaurante lo está revisando.' }
    : c.status === 'aprobada'
      ? { icon: CheckCircle2, tone: 'bg-emerald-50 text-emerald-900', title: 'Tienes razón, lo sentimos', text: c.response || 'Ya lo estamos corrigiendo.' }
      : { icon: XCircle, tone: 'bg-gray-100 text-gray-800', title: 'Revisamos tu reporte', text: c.response || '' };
  const Icon = view.icon;
  return (
    <div className={`rounded-2xl p-4 text-sm ${view.tone}`}>
      <p className="flex items-center gap-2 font-semibold"><Icon className="h-5 w-5" /> {view.title}</p>
      {view.text && <p className="mt-1">{view.text}</p>}
      <p className="mt-2 text-xs opacity-75">Tu reporte: “{c.reason}”</p>
    </div>
  );
}
