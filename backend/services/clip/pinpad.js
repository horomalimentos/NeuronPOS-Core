// Cobros con la terminal Clip (PinPad), como services de Horom
// (routes/clipPinpad.js). El resultado solo se cree si Clip lo confirma al
// consultarlo; un cobro aprobado debe cuadrar con el monto pedido.
import { createClipClient } from './client.js';

const SUCCESS = ['COMPLETED', 'APPROVED'];
const FAILED = ['FAILED', 'REJECTED', 'DECLINED', 'EXPIRED', 'ERROR', 'TIMEOUT', 'DENIED'];
const CANCELLED = ['CANCELED', 'CANCELLED'];

export function publicCobro(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    status: row.status,
    amount: Number(row.amount),
    card_last_digits: row.card_last_digits,
    card_brand: row.card_brand,
    transaction_id: row.transaction_id || null,
    error_message: row.error_message,
    used: Boolean(row.used_payment_id),
    created_at: row.created_at,
  };
}

/**
 * Pregunta a Clip y guarda el resultado. Idempotente: si ya no esta PENDING
 * no vuelve a preguntar. db: transaccion con el tenant del restaurante.
 */
export async function refreshCobro(db, row, creds) {
  if (row.status !== 'PENDING' || !row.pinpad_request_id) return row;
  const data = await createClipClient(creds).getPinpadPayment(row.pinpad_request_id);
  if (!data) return row;
  const status = String(data.status || '').toUpperCase();
  if (CANCELLED.includes(status)) {
    const r = await db.query(
      `UPDATE clip_pinpad_requests SET status = 'CANCELLED', clip_response = $2, updated_at = now()
        WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [row.id, data],
    );
    return r.rows[0] || row;
  }
  const ok = SUCCESS.includes(status);
  if (!ok && !FAILED.includes(status)) return row;
  const approved = (data.detail?.results || []).find((t) => String(t.status).toLowerCase() === 'approved');
  const paid = Number(data.amount_paid ?? approved?.paid_amount ?? 0);
  // Nunca se da por pagado algo que no cuadra con lo pedido.
  const amountOk = Math.abs(Number(data.amount) - Number(row.amount)) < 0.01 && paid + 0.01 >= Number(row.amount);
  const final = ok && approved && amountOk ? 'COMPLETED' : 'FAILED';
  const card = approved?.payment_method?.card || {};
  const r = await db.query(
    `UPDATE clip_pinpad_requests SET status = $2, amount_paid = $3, transaction_id = $4, card_last_digits = $5,
            card_brand = $6, clip_response = $7, error_message = $8, completed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'PENDING' RETURNING *`,
    [row.id, final, paid || null, approved?.transaction_id || null, card.last_digits || null,
      approved?.payment_method?.id || card.brand || null, data,
      final === 'FAILED' ? (ok ? 'El monto cobrado por Clip no coincide con el de la orden' : 'La terminal rechazo o no completo el cobro') : null],
  );
  return r.rows[0] || (await db.query('SELECT * FROM clip_pinpad_requests WHERE id = $1', [row.id])).rows[0];
}
