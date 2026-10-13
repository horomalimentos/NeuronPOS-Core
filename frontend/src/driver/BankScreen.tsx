import { CheckCircle2, Landmark } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field } from '../components/ui';
import { errorMessage, fleetApi } from '../lib/api';
import { clabeBank, clabeDigits, clabeGroups, clabeIsValid, type BankInfo } from './clabe';
import { Screen } from './Panels';

/**
 * Datos bancarios del repartidor: CLABE, banco y titular, para que Nayo le
 * deposite su saldo a favor. El banco se llena solo con la CLABE.
 */
export default function BankScreen({ bank, onSaved, onClose }: {
  bank: BankInfo | null; onSaved: (b: BankInfo) => void; onClose: () => void;
}) {
  const [clabe, setClabe] = useState(bank?.bank_clabe ?? '');
  const [name, setName] = useState(bank?.bank_name ?? '');
  const [holder, setHolder] = useState(bank?.bank_holder ?? '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const auto = clabeBank(clabe);
  const complete = clabe.length === 18;
  const valid = complete && clabeIsValid(clabe);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!valid) { setError('La CLABE no es válida: revisa los 18 dígitos.'); return; }
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const r = await fleetApi<{ bank: BankInfo }>('/fleet/bank', { method: 'PUT', body: { clabe, bank: auto ?? name, holder } });
      onSaved(r.bank);
      setSaved(true);
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  return (
    <Screen title="Datos bancarios" onClose={onClose}>
      <div className="flex items-start gap-3 rounded-2xl bg-gray-900 p-4 text-sm text-gray-300 ring-1 ring-gray-800">
        <Landmark className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand" />
        <p>Aquí te depositamos tu saldo a favor (lo que te abonamos por pedidos con tarjeta). La cuenta debe estar a tu nombre.</p>
      </div>
      <form onSubmit={save} className="space-y-4">
        <Field label="CLABE interbancaria" hint="18 dígitos. La encuentras en tu app del banco o en tu estado de cuenta.">
          <input className="input font-mono text-lg tracking-wider" inputMode="numeric" autoComplete="off" required
            value={clabeGroups(clabe)} onChange={(e) => { setClabe(clabeDigits(e.target.value)); setSaved(false); }} placeholder="0000 0000 0000 0000 00" />
        </Field>
        {complete && !valid && <p className="-mt-2 text-sm text-red-300">Esta CLABE no es válida: revisa los dígitos.</p>}
        <Field label="Banco">
          {auto ? <input className="input" value={auto} readOnly />
            : <input className="input" required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del banco" />}
        </Field>
        <Field label="Titular de la cuenta" hint="Como aparece en tu banco">
          <input className="input" required minLength={3} maxLength={120} autoComplete="name" value={holder} onChange={(e) => { setHolder(e.target.value); setSaved(false); }} />
        </Field>
        {error && <Alert>{error}</Alert>}
        {saved && <Alert kind="success">Listo, guardamos tus datos bancarios.</Alert>}
        <Button type="submit" loading={busy} disabled={!valid} className="w-full py-3 text-base">
          <CheckCircle2 className="h-5 w-5" /> Guardar
        </Button>
      </form>
    </Screen>
  );
}
