import { CheckCircle2, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, PageHeader, Spinner } from '../components/ui';
import { errorMessage, platformApi } from '../lib/api';
import type { PlatformSettings } from '../lib/types';

/**
 * Ajustes de la plataforma: dias de gracia antes de suspender y estado de la
 * cuenta de Clip con la que se cobran las mensualidades. Las credenciales se
 * configuran en el servidor (variables de entorno) y aqui nunca se muestran.
 */
export default function PlatformSettingsPage() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [grace, setGrace] = useState('5');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    platformApi<{ settings: PlatformSettings }>('/platform/settings')
      .then((r) => { setSettings(r.settings); setGrace(String(r.settings.grace_days)); })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const r = await platformApi<{ settings: PlatformSettings }>('/platform/settings', { method: 'PUT', body: { grace_days: Number(grace) } });
      setSettings(r.settings);
      setNotice('Ajustes guardados');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <>
      <PageHeader title="Ajustes de cobro" subtitle="Cobranza de las mensualidades y cuenta de Clip de NeuronPOS." />
      <div className="mb-4 space-y-2">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={save} className="card space-y-4 p-5">
          <h2 className="font-semibold text-white">Cobranza</h2>
          <Field label="Días de gracia" hint="Días después de la fecha límite antes de suspender un restaurante que no ha pagado.">
            <input className="input" type="number" min={0} max={60} required value={grace} onChange={(e) => setGrace(e.target.value)} />
          </Field>
          <p className="text-xs text-gray-500">
            Cobro automático: <b className="text-gray-300">{settings.billing_auto ? 'activo' : 'apagado (BILLING_AUTO=false)'}</b> ·
            fechas en {settings.billing_timezone}. Pagar una factura vencida reactiva al restaurante al instante.
          </p>
          <div className="flex justify-end"><Button type="submit" loading={saving}>Guardar</Button></div>
        </form>

        <section className="card space-y-3 p-5">
          <h2 className="font-semibold text-white">Clip de NeuronPOS</h2>
          <Status ok={settings.clip.configured} label="API key y clave secreta" />
          <Status ok={settings.clip.webhook_secret_configured} label="Secreto de webhooks" />
          <Status ok={settings.secrets_key_configured} label="Llave de cifrado para las credenciales de los restaurantes" />
          <div className="rounded-xl bg-gray-950/60 p-3 text-xs text-gray-400">
            <p className="mb-1 font-medium text-gray-300">Webhook de la plataforma (en el panel de Clip):</p>
            <code className="break-all text-sky-300">{settings.clip.webhook_url}</code>
            <p className="mb-1 mt-3 font-medium text-gray-300">Webhook de cada restaurante (en el Clip del restaurante):</p>
            <code className="break-all text-sky-300">{settings.clip.restaurant_webhook_url_example}</code>
          </div>
          <p className="text-xs text-gray-500">Las credenciales se configuran en el servidor (CLIP_API_KEY, CLIP_SECRET_KEY, CLIP_WEBHOOK_SECRET, PAYMENT_SECRETS_KEY) y nunca se muestran aquí.</p>
        </section>
      </div>
    </>
  );
}

function Status({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className={`flex items-center gap-2 text-sm ${ok ? 'text-emerald-300' : 'text-amber-300'}`}>
      {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      {label}: {ok ? 'configurado' : 'no configurado'}
    </p>
  );
}
