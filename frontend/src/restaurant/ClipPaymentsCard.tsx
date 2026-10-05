import { CheckCircle2, CreditCard, KeyRound, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { OnlinePayments } from '../lib/types';

/**
 * Pago en linea con la cuenta de Clip DEL RESTAURANTE (el dinero llega
 * directo a su cuenta). Las credenciales se guardan cifradas y el servidor
 * nunca las regresa: aqui solo se ve "configurado". Cambiarlas: solo admin.
 */
export default function ClipPaymentsCard({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<OnlinePayments | null>(null);
  const [keys, setKeys] = useState({ clip_api_key: '', clip_secret_key: '', clip_webhook_secret: '' });
  const [timeout, setTimeoutMin] = useState('30');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [saving, setSaving] = useState(false);

  const apply = (p: OnlinePayments) => { setData(p); setTimeoutMin(String(p.payment_timeout_minutes)); };
  useEffect(() => {
    api<{ payments: OnlinePayments }>('/online/payments').then((r) => apply(r.payments)).catch((e) => setError(errorMessage(e)));
  }, []);

  async function send(body: Record<string, unknown>, msg: string) {
    setSaving(true);
    setError('');
    setOk('');
    try {
      const r = await api<{ payments: OnlinePayments }>('/online/payments', { method: 'PUT', body });
      apply(r.payments);
      setKeys({ clip_api_key: '', clip_secret_key: '', clip_webhook_secret: '' });
      setOk(msg);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function saveKeys(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { payment_timeout_minutes: Number(timeout) };
    for (const [k, v] of Object.entries(keys)) if (v.trim()) body[k] = v.trim();
    void send(body, 'Datos de Clip guardados.');
  }

  if (!data) return <section className="card p-5">{error ? <Alert>{error}</Alert> : <Spinner />}</section>;
  const c = data.clip;
  return (
    <section className="card mt-8 space-y-5 p-5">
      <div>
        <h2 className="flex items-center gap-2 font-semibold text-white"><CreditCard className="h-5 w-5 text-brand" /> Pago en línea con Clip</h2>
        <p className="mt-1 text-sm text-gray-400">
          El cliente paga con tarjeta al hacer su pedido y el dinero llega directo a tu cuenta de Clip. El pedido llega al punto de venta hasta que Clip confirma el pago;
          si no se paga a tiempo, se cancela solo.
        </p>
      </div>
      {error && <Alert>{error}</Alert>}
      {ok && <Alert kind="success">{ok}</Alert>}
      {!data.secrets_key_configured && <Alert kind="warning">El servidor todavía no puede guardar credenciales (falta la llave de cifrado). Avisa a NeuronPOS.</Alert>}

      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <StatusLine ok={c.configured} label="API key y clave secreta" />
        <StatusLine ok={c.webhook_secret_configured} label="Secreto de webhooks" />
      </div>

      <label className="flex items-center gap-3 text-sm text-gray-300">
        <Toggle label="Ofrecer pago en línea" checked={data.online_payment_enabled} disabled={!isAdmin || !c.configured || saving}
          onChange={(v) => send({ online_payment_enabled: v }, v ? 'Pago en línea activado.' : 'Pago en línea desactivado.')} />
        <span>Ofrecer “Pagar en línea con Clip” en el checkout
          {!c.configured && <span className="block text-xs text-gray-500">Primero captura tus credenciales de Clip.</span>}
        </span>
      </label>

      {isAdmin ? (
        <form onSubmit={saveKeys} className="space-y-4 rounded-xl border border-gray-800 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-white"><KeyRound className="h-4 w-4" /> Credenciales de tu cuenta de Clip</p>
          <p className="text-xs text-gray-500">Las encuentras en dashboard.payclip.com → Desarrolladores. Por seguridad nunca se muestran; deja un campo vacío para conservar el valor guardado.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="API key">
              <input className="input" type="password" autoComplete="off" value={keys.clip_api_key} placeholder={c.configured ? '•••••• guardada' : ''}
                onChange={(e) => setKeys({ ...keys, clip_api_key: e.target.value })} />
            </Field>
            <Field label="Clave secreta">
              <input className="input" type="password" autoComplete="off" value={keys.clip_secret_key} placeholder={c.configured ? '•••••• guardada' : ''}
                onChange={(e) => setKeys({ ...keys, clip_secret_key: e.target.value })} />
            </Field>
            <Field label="Secreto de webhooks (opcional)">
              <input className="input" type="password" autoComplete="off" value={keys.clip_webhook_secret} placeholder={c.webhook_secret_configured ? '•••••• guardado' : ''}
                onChange={(e) => setKeys({ ...keys, clip_webhook_secret: e.target.value })} />
            </Field>
          </div>
          <Field label="Minutos para pagar" hint="Si el cliente no paga en este tiempo, el pedido se cancela.">
            <input className="input w-32" type="number" min={5} max={1440} value={timeout} onChange={(e) => setTimeoutMin(e.target.value)} />
          </Field>
          {c.webhook_url && (
            <div className="rounded-lg bg-gray-950/60 p-3 text-xs text-gray-400">
              URL de webhook para tu panel de Clip: <code className="break-all text-sky-300">{c.webhook_url}</code>
            </div>
          )}
          <div className="flex flex-wrap justify-between gap-2">
            {c.configured ? (
              <Button type="button" variant="ghost" disabled={saving}
                onClick={() => { if (window.confirm('¿Quitar las credenciales de Clip? El pago en línea se desactiva.')) void send({ remove_clip: true }, 'Credenciales eliminadas.'); }}>
                <Trash2 className="h-4 w-4" /> Quitar credenciales
              </Button>
            ) : <span />}
            <Button type="submit" loading={saving}>Guardar</Button>
          </div>
        </form>
      ) : <p className="text-xs text-gray-500">Solo un administrador puede cambiar las credenciales de Clip.</p>}
    </section>
  );
}

function StatusLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className={`flex items-center gap-2 ${ok ? 'text-emerald-300' : 'text-gray-400'}`}>
      {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />} {label}: {ok ? 'configurado' : 'no configurado'}
    </p>
  );
}
