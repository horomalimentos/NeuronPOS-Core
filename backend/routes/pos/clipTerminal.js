// Terminal fisica de Clip en la caja (modulo "terminal_clip"), como el PinPad
// de Horom. Usa la cuenta de Clip del restaurante (la misma de los pagos en
// linea). Flujo: la caja pide el cobro -> la terminal se enciende -> la caja
// consulta (o llega el webhook) -> Clip confirma -> la caja registra el pago con
// tarjeta usando el cobro aprobado (orders.js lo verifica y lo marca usado).
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { env } from '../../config/env.js';
import { requireRole } from '../../middleware/auth.js';
import { requireModule } from '../../middleware/requireModule.js';
import { createClipClient, hasCheckoutCredentials } from '../../services/clip/client.js';
import { publicCobro, refreshCobro } from '../../services/clip/pinpad.js';
import { toCents } from '../../services/posMath.js';
import { loadRestaurantClipCredentials } from '../../services/restaurantPayments.js';
import { HttpError, ah, badRequest, money, notFound, requireUuid, str } from '../../utils/http.js';
import { ROLES, canAccessBranch, requireBranch } from './common.js';

const router = Router();
router.use('/clip', requireModule('terminal_clip'));

const SERIAL_RE = /^[A-Z0-9-]{6,40}$/;

async function credentials(restaurantId) {
  const creds = await loadRestaurantClipCredentials(restaurantId);
  if (!hasCheckoutCredentials(creds)) {
    throw new HttpError(409, 'Configura la cuenta de Clip del restaurante en Pedidos en linea > Pagos', 'CLIP_NOT_CONFIGURED');
  }
  return creds;
}

// Numero de serie de la terminal de una caja.
router.get('/clip/terminal', requireRole(...ROLES.cashier), ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const terminal = str(req.query.terminal, { field: 'terminal', required: true, max: 40 });
  const row = await withTenant(req.tenant.id, async (db) => (await db.query(
    'SELECT serial_number FROM pos_clip_terminals WHERE restaurant_id = $1 AND branch_id = $2 AND lower(terminal) = lower($3)',
    [req.tenant.id, branchId, terminal],
  )).rows[0]);
  res.json({ serial_number: row?.serial_number || null, enabled: Boolean(row) });
}));

router.put('/clip/terminal', requireRole(...ROLES.manage), ah(async (req, res) => {
  const body = req.body || {};
  const branchId = requireBranch(req, body.branch_id);
  const terminal = str(body.terminal, { field: 'terminal', required: true, max: 40 });
  const serial = String(body.serial_number || '').trim().toUpperCase() || null;
  if (serial && !SERIAL_RE.test(serial)) throw badRequest('Numero de serie invalido', 'INVALID_FIELD');
  await withTenant(req.tenant.id, async (db) => {
    await db.query('DELETE FROM pos_clip_terminals WHERE restaurant_id = $1 AND branch_id = $2 AND lower(terminal) = lower($3)', [req.tenant.id, branchId, terminal]);
    if (serial) {
      await db.query(
        'INSERT INTO pos_clip_terminals (restaurant_id, branch_id, terminal, serial_number) VALUES ($1, $2, $3, $4)',
        [req.tenant.id, branchId, terminal, serial],
      );
    }
  });
  res.json({ serial_number: serial, enabled: Boolean(serial) });
}));

// Pedir un cobro en la terminal: { order_id, amount, terminal }.
router.post('/clip/cobros', requireRole(...ROLES.cashier), ah(async (req, res) => {
  const body = req.body || {};
  const orderId = requireUuid(body.order_id, 'order_id');
  const amount = money(body.amount, { field: 'amount' });
  if (!(amount > 0)) throw badRequest('El monto debe ser mayor a cero', 'INVALID_FIELD');
  const terminal = str(body.terminal, { field: 'terminal', required: true, max: 40 });
  const creds = await credentials(req.tenant.id);
  const client = createClipClient(creds);

  const prepared = await withTenant(req.tenant.id, async (db) => {
    const o = (await db.query('SELECT id, branch_id, folio, status, total, paid_amount FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [orderId, req.tenant.id])).rows[0];
    if (!o || !canAccessBranch(req.user, o.branch_id)) throw notFound('Orden no encontrada', 'ORDER_NOT_FOUND');
    if (!['abierta', 'enviada', 'lista'].includes(o.status)) throw badRequest('La orden ya no se puede cobrar', 'ORDER_CLOSED');
    const remaining = (toCents(o.total) - toCents(o.paid_amount)) / 100;
    if (amount > remaining + 0.01) {
      throw badRequest(`El monto (${amount.toFixed(2)}) es mayor a lo que falta por pagar (${remaining.toFixed(2)})`, 'AMOUNT_TOO_HIGH');
    }
    const term = (await db.query(
      'SELECT serial_number FROM pos_clip_terminals WHERE restaurant_id = $1 AND branch_id = $2 AND lower(terminal) = lower($3)',
      [req.tenant.id, o.branch_id, terminal],
    )).rows[0];
    if (!term) throw badRequest('Esta caja no tiene una terminal Clip configurada', 'PINPAD_NOT_CONFIGURED');
    // Un cobro aprobado que la caja no alcanzo a registrar: se regresa ese, no se cobra otra vez.
    const approved = (await db.query(
      `SELECT * FROM clip_pinpad_requests WHERE restaurant_id = $1 AND order_id = $2 AND status = 'COMPLETED'
          AND used_payment_id IS NULL AND completed_at > now() - interval '12 hours' ORDER BY completed_at DESC LIMIT 1`,
      [req.tenant.id, o.id],
    )).rows[0];
    if (approved) return { existing: approved };
    // Un cobro a la vez por terminal: los pendientes se revisan y se cancelan.
    const pending = (await db.query(
      `SELECT * FROM clip_pinpad_requests WHERE restaurant_id = $1 AND serial_number = $2 AND status = 'PENDING'`,
      [req.tenant.id, term.serial_number],
    )).rows;
    for (const p of pending) {
      const fresh = await refreshCobro(db, p, creds);
      if (fresh.status === 'COMPLETED' && fresh.order_id === o.id && !fresh.used_payment_id) return { existing: fresh };
      if (fresh.status === 'PENDING') {
        await client.cancelPinpadPayment(fresh.pinpad_request_id).catch(() => false);
        await db.query("UPDATE clip_pinpad_requests SET status = 'CANCELLED', updated_at = now() WHERE id = $1 AND status = 'PENDING'", [fresh.id]);
      }
    }
    const reference = `POS-${o.folio}-${Date.now().toString(36)}`;
    const row = (await db.query(
      `INSERT INTO clip_pinpad_requests (restaurant_id, order_id, branch_id, terminal, serial_number, reference, amount, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.tenant.id, o.id, o.branch_id, terminal, term.serial_number, reference, amount, req.user.id],
    )).rows[0];
    return { row };
  });
  if (prepared.existing) {
    throw new HttpError(409, 'Esta orden ya tiene un cobro aprobado en la terminal', 'PINPAD_ALREADY_APPROVED', { cobro: publicCobro(prepared.existing) });
  }

  // La llamada a Clip va fuera de la transaccion (puede tardar).
  const { row } = prepared;
  try {
    const pinpadId = await client.createPinpadPayment({
      amount, reference: row.reference, serialNumber: row.serial_number,
      webhookUrl: `${env.publicApiUrl}/api/webhooks/clip/pinpad/${req.tenant.id}`,
    });
    const updated = await withTenant(req.tenant.id, async (db) => (await db.query(
      'UPDATE clip_pinpad_requests SET pinpad_request_id = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [row.id, pinpadId],
    )).rows[0]);
    res.status(201).json({ cobro: publicCobro(updated) });
  } catch (err) {
    await withTenant(req.tenant.id, (db) => db.query(
      "UPDATE clip_pinpad_requests SET status = 'FAILED', error_message = $2, updated_at = now() WHERE id = $1",
      [row.id, err.message],
    ));
    throw err;
  }
}));

async function loadCobro(db, req) {
  requireUuid(req.params.id);
  const row = (await db.query('SELECT * FROM clip_pinpad_requests WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id])).rows[0];
  if (!row || !canAccessBranch(req.user, row.branch_id)) throw notFound('Cobro no encontrado', 'PINPAD_NOT_FOUND');
  return row;
}

// Estado (consulta a Clip si sigue pendiente). La caja lo pregunta cada pocos segundos.
router.get('/clip/cobros/:id', requireRole(...ROLES.cashier), ah(async (req, res) => {
  const creds = await credentials(req.tenant.id);
  const cobro = await withTenant(req.tenant.id, async (db) => publicCobro(await refreshCobro(db, await loadCobro(db, req), creds)));
  res.json({ cobro });
}));

// Cancelar mientras la terminal no lo tome.
router.delete('/clip/cobros/:id', requireRole(...ROLES.cashier), ah(async (req, res) => {
  const creds = await credentials(req.tenant.id);
  const cobro = await withTenant(req.tenant.id, async (db) => {
    const row = await loadCobro(db, req);
    if (row.status !== 'PENDING') return publicCobro(row);
    const ok = await createClipClient(creds).cancelPinpadPayment(row.pinpad_request_id).catch(() => false);
    if (!ok) {
      const fresh = await refreshCobro(db, row, creds);
      throw new HttpError(409, 'La terminal ya tomo el cobro. Cancelalo en la terminal o espera el resultado.', 'PINPAD_IN_PROGRESS', { cobro: publicCobro(fresh) });
    }
    return publicCobro((await db.query(
      "UPDATE clip_pinpad_requests SET status = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING *",
      [row.id],
    )).rows[0]);
  });
  res.json({ cobro });
}));

export default router;
