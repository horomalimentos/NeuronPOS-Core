import { Landmark, Pencil } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Spinner } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import { clabeBank, clabeDigits, clabeGroups, clabeIsValid, clabeMasked, type BankInfo } from '../driver/clabe';

/**
 * Datos bancarios del restaurante en Nayo: CLABE, banco y titular, para que
 * le depositemos lo de sus pedidos. Igual que la pantalla del repartidor; el
 * banco se llena solo con la CLABE. Solo dueno y gerente (un cajero no lo ve).
 */
export default function RestaurantBankCard() {
  const [bank, setBank] = useState<BankInfo | null | undefined>(undefined);
  const [hidden, setHidden] = useState(false);
  const [editing, setEditing] = useState(false);
  const [clabe, setClabe] = useState('');
  const [name, setName] = useState('');
  const [holder, setHolder] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ bank: BankInfo }>('/marketplace/bank').then((r) => {
      setBank(r.bank);
      setEditing(!r.bank.bank_clabe);
      setHolder(r.bank.bank_holder ?? '');
    }).catch((e) => {
      if (e instanceof ApiError && e.status === 403) setHidden(true);
      else { setError(errorMessage(e)); setBank(null); }
    });
  }, []);

  const auto = clabeBank(clabe);
  const complete = clabe.length === 18;
  const valid = complete && clabeIsValid(clabe);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!valid) { setError('La CLABE no es válida: revisa los 18 dígitos.'); return; }
    setBusy(true);
    setError('');
    try {
      const r = await api<{ bank: BankInfo }>('/marketplace/bank', { method: 'PUT', body: { clabe, bank: auto ?? name, holder } });
      setBank(r.bank);
      setEditing(false);
      setSaved(true);
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  if (hidden) return null;
  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 font-semibold text-white"><Landmark className="h-5 w-5 text-brand" /> Datos bancarios para depósitos</h2>
      <p className="mt-1 text-sm text-gray-400">Aquí te depositamos lo de tus pedidos de Nayo. Usa una cuenta a nombre del restaurante o del dueño.</p>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {saved && !editing && <div className="mt-3"><Alert kind="success">Listo, guardamos tus datos bancarios.</Alert></div>}
      {bank === undefined ? <Spinner /> : !editing && bank?.bank_clabe ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-950/40 p-4">
          <div>
            <p className="font-medium text-white">{bank.bank_holder}</p>
            <p className="text-sm text-gray-300">{bank.bank_name} · CLABE {clabeMasked(bank.bank_clabe)}</p>
            {bank.bank_updated_at && <p className="text-xs text-gray-500">Actualizada el {formatDate(bank.bank_updated_at)}</p>}
          </div>
          <Button variant="secondary" onClick={() => { setClabe(''); setName(''); setEditing(true); setSaved(false); }}>
            <Pencil className="h-4 w-4" /> Cambiar cuenta
          </Button>
        </div>
      ) : (
        <form onSubmit={(e) => void save(e)} className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="CLABE interbancaria" hint={complete && !valid ? 'Esta CLABE no es válida: revisa los dígitos.' : '18 dígitos. Está en tu app del banco o en tu estado de cuenta.'}>
            <input className="input font-mono tracking-wider" inputMode="numeric" autoComplete="off" required
              value={clabeGroups(clabe)} onChange={(e) => { setClabe(clabeDigits(e.target.value)); setSaved(false); }} placeholder="0000 0000 0000 0000 00" />
          </Field>
          <Field label="Banco">
            {auto ? <input className="input" value={auto} readOnly />
              : <input className="input" required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del banco" />}
          </Field>
          <Field label="Titular de la cuenta" hint="Como aparece en el banco">
            <input className="input" required minLength={3} maxLength={120} value={holder} onChange={(e) => setHolder(e.target.value)} />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit" loading={busy} disabled={!valid} className="flex-1">Guardar</Button>
            {bank?.bank_clabe && <Button type="button" variant="ghost" onClick={() => { setEditing(false); setError(''); }}>Cancelar</Button>}
          </div>
        </form>
      )}
    </section>
  );
}
