import { Landmark, Pencil } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Spinner } from '../components/ui';
import { ApiError, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';

export interface PayoutAccount { holder_name: string; bank: string; clabe_last4: string; updated_at: string }

// Bancos por los primeros 3 digitos de la CLABE (los mas comunes).
const BANKS: Record<string, string> = {
  '002': 'Banamex', '012': 'BBVA', '014': 'Santander', '021': 'HSBC', '030': 'BanBajío', '036': 'Inbursa',
  '044': 'Scotiabank', '058': 'Banregio', '072': 'Banorte', '127': 'Banco Azteca', '137': 'BanCoppel',
  '638': 'Nu', '646': 'STP', '722': 'Mercado Pago',
};

/** Mismo calculo que el backend: 18 digitos y digito verificador. */
function validClabe(clabe: string) {
  if (!/^[0-9]{18}$/.test(clabe)) return false;
  const w = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += (Number(clabe[i]) * w[i % 3]) % 10;
  return (10 - (sum % 10)) % 10 === Number(clabe[17]);
}

/**
 * Cuenta para depositos de Nayo (CLABE). La usan el restaurante y el
 * repartidor: cada quien pasa como cargar y guardar con su sesion.
 */
export default function PayoutAccountForm({ load, save, intro }: {
  load: () => Promise<{ account: PayoutAccount | null }>;
  save: (body: { holder_name: string; bank: string; clabe: string }) => Promise<{ account: PayoutAccount | null }>;
  intro: string;
}) {
  const [account, setAccount] = useState<PayoutAccount | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ holder_name: '', bank: '', clabe: '' });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    load().then((r) => { setAccount(r.account); setEditing(!r.account); }).catch((e) => {
      // Sin permiso (p. ej. un cajero): no se muestra.
      if (e instanceof ApiError && e.status === 403) setHidden(true);
      else { setError(errorMessage(e)); setAccount(null); }
    });
    // Solo al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clabe = form.clabe.replace(/\D/g, '');
  const guessed = clabe.length >= 3 ? BANKS[clabe.slice(0, 3)] : undefined;
  const setClabe = (v: string) => {
    const digits = v.replace(/\D/g, '').slice(0, 18);
    const bank = digits.length >= 3 ? BANKS[digits.slice(0, 3)] : undefined;
    setForm((f) => ({ ...f, clabe: digits, bank: bank && (!f.bank || Object.values(BANKS).includes(f.bank)) ? bank : f.bank }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!validClabe(clabe)) { setError('La CLABE debe tener 18 dígitos y ser válida. Cópiala de tu app del banco.'); return; }
    setBusy(true);
    setError('');
    try {
      const r = await save({ holder_name: form.holder_name, bank: form.bank, clabe });
      setAccount(r.account);
      setEditing(false);
      setSaved(true);
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  if (hidden) return null;
  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 font-semibold text-white"><Landmark className="h-5 w-5 text-brand" /> Cuenta para depósitos</h2>
      <p className="mt-1 text-sm text-gray-400">{intro}</p>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {saved && !editing && <div className="mt-3"><Alert kind="success">Cuenta guardada.</Alert></div>}
      {account === undefined ? <Spinner /> : !editing && account ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-950/40 p-4">
          <div>
            <p className="font-medium text-white">{account.holder_name}</p>
            <p className="text-sm text-gray-300">{account.bank} · CLABE terminación {account.clabe_last4}</p>
            <p className="text-xs text-gray-500">Actualizada el {formatDate(account.updated_at)}</p>
          </div>
          <Button variant="secondary" onClick={() => { setForm({ holder_name: account.holder_name, bank: account.bank, clabe: '' }); setEditing(true); setSaved(false); }}>
            <Pencil className="h-4 w-4" /> Cambiar cuenta
          </Button>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Titular de la cuenta">
            <input className="input" required maxLength={120} value={form.holder_name} onChange={(e) => setForm({ ...form, holder_name: e.target.value })} placeholder="Como aparece en el banco" />
          </Field>
          <Field label="CLABE (18 dígitos)" hint={clabe.length === 18 && !validClabe(clabe) ? 'Esta CLABE no es válida; revísala.' : undefined}>
            <input className="input font-mono tracking-wider" required inputMode="numeric" autoComplete="off" value={clabe}
              onChange={(e) => setClabe(e.target.value)} placeholder="000000000000000000" />
          </Field>
          <Field label="Banco" hint={guessed && form.bank === guessed ? 'Lo tomamos de la CLABE.' : undefined}>
            <input className="input" required maxLength={60} value={form.bank} onChange={(e) => setForm({ ...form, bank: e.target.value })} />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit" loading={busy} className="flex-1">Guardar cuenta</Button>
            {account && <Button type="button" variant="ghost" onClick={() => { setEditing(false); setError(''); }}>Cancelar</Button>}
          </div>
        </form>
      )}
    </section>
  );
}
