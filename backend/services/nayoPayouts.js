// Cuenta para depositos de Nayo (migracion 060): la CLABE de un repartidor
// de la flota o de un restaurante. El dueno la captura y la ve enmascarada;
// el Panel la ve completa para transferir.
import { withPlatform } from '../config/database.js';
import { badRequest, str } from '../utils/http.js';

const WEIGHTS = [3, 7, 1];

/** CLABE valida: 18 digitos con el digito verificador correcto. */
export function validClabe(clabe) {
  if (!/^[0-9]{18}$/.test(clabe)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += (Number(clabe[i]) * WEIGHTS[i % 3]) % 10;
  return (10 - (sum % 10)) % 10 === Number(clabe[17]);
}

const ownerSql = (owner) => (owner.driver_id ? ['driver_id', owner.driver_id] : ['restaurant_id', owner.restaurant_id]);

/** Vista para el dueno: solo los ultimos 4 digitos. */
export const maskedAccount = (a) => (a ? {
  holder_name: a.holder_name, bank: a.bank, clabe_last4: a.clabe.slice(-4), updated_at: a.updated_at,
} : null);

/** owner: { driver_id } | { restaurant_id } */
export async function getPayoutAccount(owner) {
  const [col, id] = ownerSql(owner);
  return withPlatform(async (db) => (await db.query(
    `SELECT holder_name, bank, clabe, updated_at FROM nayo_payout_accounts WHERE ${col} = $1`, [id],
  )).rows[0] || null);
}

export async function savePayoutAccount(owner, body, updatedBy = null) {
  const b = body || {};
  const holder = str(b.holder_name, { field: 'holder_name', required: true, max: 120 });
  const bank = str(b.bank, { field: 'bank', required: true, max: 60 });
  const clabe = String(b.clabe ?? '').replace(/\s+/g, '');
  if (holder.length < 2) throw badRequest('Escribe el nombre del titular de la cuenta', 'INVALID_FIELD');
  if (bank.length < 2) throw badRequest('Escribe el banco', 'INVALID_FIELD');
  if (!validClabe(clabe)) throw badRequest('La CLABE debe tener 18 dígitos y ser válida; revísala en tu app del banco', 'INVALID_CLABE');
  const [col, id] = ownerSql(owner);
  return withPlatform(async (db) => (await db.query(
    `INSERT INTO nayo_payout_accounts (${col}, holder_name, bank, clabe, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (${col}) DO UPDATE SET holder_name = EXCLUDED.holder_name, bank = EXCLUDED.bank,
            clabe = EXCLUDED.clabe, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING holder_name, bank, clabe, updated_at`,
    [id, holder, bank, clabe, updatedBy],
  )).rows[0]);
}
