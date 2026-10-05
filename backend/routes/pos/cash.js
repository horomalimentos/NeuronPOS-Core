// Caja: turnos por sucursal y terminal (fondo inicial), entradas y salidas de
// efectivo, y cierre con corte (esperado contra contado por metodo de pago).
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { calculateCashCut } from '../../services/posMath.js';
import {
  HttpError, ah, badRequest, forbidden, money, notFound, oneOf, requireUuid, str,
} from '../../utils/http.js';
import { ROLES, assertBranchExists, canAccessBranch, int, isManager, requireBranch } from './common.js';

const router = Router();
const cashier = requireRole(...ROLES.cashier);

const SESSION_SELECT = `
  SELECT s.id, s.branch_id, b.name AS branch_name, s.terminal, s.status, s.opening_cash,
         s.opened_by, uo.name AS opened_by_name, s.opened_at,
         s.expected_cash, s.counted_cash, s.difference, s.total_sales, s.total_tips, s.orders_count,
         s.closed_by, uc.name AS closed_by_name, s.closed_at, s.notes
    FROM cash_sessions s
    JOIN branches b ON b.id = s.branch_id AND b.restaurant_id = s.restaurant_id
    JOIN users uo ON uo.id = s.opened_by AND uo.restaurant_id = s.restaurant_id
    LEFT JOIN users uc ON uc.id = s.closed_by AND uc.restaurant_id = s.restaurant_id`;

async function getSession(db, req, id, { lock = false } = {}) {
  requireUuid(id);
  if (lock) {
    await db.query('SELECT 1 FROM cash_sessions WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, req.tenant.id]);
  }
  const { rows } = await db.query(`${SESSION_SELECT} WHERE s.id = $1 AND s.restaurant_id = $2`, [id, req.tenant.id]);
  const s = rows[0];
  if (!s || !canAccessBranch(req.user, s.branch_id)) throw notFound('Turno de caja no encontrado', 'CASH_SESSION_NOT_FOUND');
  return s;
}

/** Datos para el corte: metodos, pagos y movimientos del turno. */
async function cutInputs(db, restaurantId, sessionId) {
  const payments = (await db.query(
    `SELECT payment_method_id, amount, tip, order_id FROM order_payments
      WHERE restaurant_id = $1 AND cash_session_id = $2`,
    [restaurantId, sessionId],
  )).rows;
  const movements = (await db.query(
    `SELECT m.id, m.kind, m.amount, m.reason, m.created_at, u.name AS created_by_name
       FROM cash_movements m JOIN users u ON u.id = m.created_by AND u.restaurant_id = m.restaurant_id
      WHERE m.restaurant_id = $1 AND m.session_id = $2 ORDER BY m.created_at`,
    [restaurantId, sessionId],
  )).rows;
  // Metodos activos y cualquier otro que se haya usado en el turno. Los pagos
  // en linea (Clip) no pasan por caja: no tienen turno y no entran al corte.
  const methods = (await db.query(
    `SELECT id, name, kind FROM payment_methods
      WHERE restaurant_id = $1 AND kind <> 'en_linea' AND (active OR id = ANY($2::uuid[]))
      ORDER BY sort_order, name`,
    [restaurantId, [...new Set(payments.map((p) => p.payment_method_id))]],
  )).rows;
  return { payments, movements, methods };
}

router.get('/cash-sessions', cashier, ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const status = oneOf(req.query.status, ['abierta', 'cerrada'], 'status');
  const limit = int(req.query.limit ?? 50, { field: 'limit', min: 1, max: 200 });
  const params = [req.tenant.id, branchId, limit];
  let where = 's.restaurant_id = $1 AND s.branch_id = $2';
  if (status) { params.push(status); where += ` AND s.status = $${params.length}`; }
  const sessions = await withTenant(req.tenant.id, async (db) => (await db.query(
    `${SESSION_SELECT} WHERE ${where} ORDER BY s.opened_at DESC LIMIT $3`,
    params,
  )).rows);
  res.json({ sessions });
}));

router.post('/cash-sessions/open', cashier, ah(async (req, res) => {
  const body = req.body || {};
  const branchId = requireBranch(req, body.branch_id);
  const terminal = str(body.terminal, { field: 'terminal', max: 40 }) || 'Caja 1';
  const openingCash = money(body.opening_cash ?? 0, { field: 'opening_cash' });
  try {
    const session = await withTenant(req.tenant.id, async (db) => {
      await assertBranchExists(db, req.tenant.id, branchId);
      const { rows } = await db.query(
        `INSERT INTO cash_sessions (restaurant_id, branch_id, terminal, opening_cash, opened_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [req.tenant.id, branchId, terminal, openingCash, req.user.id],
      );
      return getSession(db, req, rows[0].id);
    });
    res.status(201).json({ session });
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'cash_sessions_one_open') {
      throw new HttpError(409, `Ya hay un turno abierto en "${terminal}"`, 'CASH_SESSION_ALREADY_OPEN');
    }
    throw err;
  }
}));

// Detalle con el corte en vivo (o el guardado si ya se cerro).
router.get('/cash-sessions/:id', cashier, ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const session = await getSession(db, req, req.params.id);
    const { payments, movements, methods } = await cutInputs(db, req.tenant.id, session.id);
    let counts = null;
    if (session.status === 'cerrada') {
      const rows = (await db.query(
        'SELECT payment_method_id, counted FROM cash_session_counts WHERE restaurant_id = $1 AND session_id = $2',
        [req.tenant.id, session.id],
      )).rows;
      counts = Object.fromEntries(rows.map((r) => [r.payment_method_id, r.counted]));
    }
    const cut = calculateCashCut({ methods, payments, movements, openingCash: session.opening_cash, counts });
    cut.orders_count = new Set(payments.map((p) => p.order_id)).size;
    return { session, movements, cut };
  });
  res.json(data);
}));

router.post('/cash-sessions/:id/movements', cashier, ah(async (req, res) => {
  const body = req.body || {};
  const kind = oneOf(body.kind, ['entrada', 'salida'], 'kind');
  if (!kind) throw badRequest('Indica si es entrada o salida', 'MISSING_FIELD');
  const amount = money(body.amount, { field: 'amount' });
  if (!(amount > 0)) throw badRequest('El monto debe ser mayor a cero', 'INVALID_FIELD');
  const reason = str(body.reason, { field: 'reason', required: true, max: 200 });
  const movement = await withTenant(req.tenant.id, async (db) => {
    const s = await getSession(db, req, req.params.id, { lock: true });
    if (s.status !== 'abierta') throw badRequest('El turno ya esta cerrado', 'CASH_SESSION_CLOSED');
    return (await db.query(
      `INSERT INTO cash_movements (restaurant_id, session_id, kind, amount, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, kind, amount, reason, created_at`,
      [req.tenant.id, s.id, kind, amount, reason, req.user.id],
    )).rows[0];
  });
  res.status(201).json({ movement });
}));

// Cierre con corte: counts = [{ payment_method_id, counted }]. Es obligatorio
// capturar el efectivo y cada metodo que tenga movimientos en el turno.
router.post('/cash-sessions/:id/close', cashier, ah(async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.counts)) throw badRequest('counts debe ser una lista', 'INVALID_FIELD');
  const counts = {};
  for (const c of body.counts) {
    counts[requireUuid(c?.payment_method_id, 'payment_method_id')] = money(c.counted, { field: 'counted' });
  }
  const notes = str(body.notes, { field: 'notes', max: 500 }) || null;

  const data = await withTenant(req.tenant.id, async (db) => {
    const s = await getSession(db, req, req.params.id, { lock: true });
    if (s.status !== 'abierta') throw badRequest('El turno ya esta cerrado', 'CASH_SESSION_CLOSED');
    if (s.opened_by !== req.user.id && !isManager(req.user)) {
      throw forbidden('Solo quien abrio el turno o un gerente puede cerrarlo', 'ROLE_REQUIRED');
    }
    const { payments, movements, methods } = await cutInputs(db, req.tenant.id, s.id);
    const preview = calculateCashCut({ methods, payments, movements, openingCash: s.opening_cash });
    const missing = preview.methods.filter((m) => counts[m.payment_method_id] === undefined
      && (m.kind === 'efectivo' || m.expected !== 0));
    if (missing.length) {
      throw badRequest(`Captura lo contado en: ${missing.map((m) => m.name).join(', ')}`, 'MISSING_COUNTS');
    }
    const cut = calculateCashCut({ methods, payments, movements, openingCash: s.opening_cash, counts });
    cut.orders_count = new Set(payments.map((p) => p.order_id)).size;
    for (const m of cut.methods) {
      await db.query(
        `INSERT INTO cash_session_counts (restaurant_id, session_id, payment_method_id, expected, counted, difference)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.tenant.id, s.id, m.payment_method_id, m.expected, m.counted, m.difference],
      );
    }
    await db.query(
      `UPDATE cash_sessions SET status = 'cerrada', closed_at = now(), closed_by = $3,
              expected_cash = $4, counted_cash = $5, difference = $6, total_sales = $7,
              total_tips = $8, orders_count = $9, notes = $10
        WHERE id = $1 AND restaurant_id = $2`,
      [s.id, req.tenant.id, req.user.id, cut.expected_cash, cut.counted_cash, cut.cash_difference,
        cut.total_sales, cut.total_tips, cut.orders_count, notes],
    );
    return { session: await getSession(db, req, s.id), movements, cut };
  });
  res.json(data);
}));

export default router;
