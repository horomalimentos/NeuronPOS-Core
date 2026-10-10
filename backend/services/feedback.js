// Calificaciones y quejas de pedidos en linea (modulo 'quejas'), adaptado de
// Horom. El cliente califica o se queja desde el seguimiento de su pedido
// (token: sirve para invitados y con sesion) una vez que lo recibio, y hasta
// FEEDBACK_DAYS dias despues. El administrador resuelve las quejas.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { HttpError, badRequest, notFound } from '../utils/http.js';
import { applyPoints, activeLoyalty } from './loyalty.js';
import { activeWallet, applyWallet } from './wallet.js';

export const FEEDBACK_DAYS = 15;
export const MAX_EVIDENCE = 4;

const conflict = (msg, code) => new HttpError(409, msg, code);

/** Ya lo recibio (pagado) y no han pasado FEEDBACK_DAYS dias. */
export function feedbackOpen(o, now = new Date()) {
  if (o.status !== 'pagada') return false;
  const since = new Date(o.paid_at || o.updated_at || o.created_at);
  return now - since <= FEEDBACK_DAYS * 86400000;
}

const COMPENSATION_TEXT = (c) => {
  if (c.compensation_type === 'monedero') return `Te abonamos $${Number(c.compensation_amount).toFixed(2)} a tu monedero.`;
  if (c.compensation_type === 'puntos') return `Te regalamos ${c.compensation_points} puntos.`;
  return null;
};

/** Lo que el cliente ve en su seguimiento. */
export async function customerFeedback(db, rid, o, active) {
  if (!active) return null;
  const rating = (await db.query(
    'SELECT overall, food, service, comment, created_at FROM order_ratings WHERE restaurant_id = $1 AND order_id = $2',
    [rid, o.id],
  )).rows[0] || null;
  const c = (await db.query(
    `SELECT status, reason, created_at, reviewed_at, review_notes, compensation_type, compensation_amount, compensation_points
       FROM customer_complaints WHERE restaurant_id = $1 AND order_id = $2`,
    [rid, o.id],
  )).rows[0];
  const open = feedbackOpen(o);
  return {
    // Con cuenta el correo sale de la cuenta; al invitado se le pide.
    has_account: Boolean(o.customer_id),
    can_rate: open && !rating,
    can_complain: open && !c,
    rating,
    complaint: c ? {
      status: c.status,
      reason: c.reason,
      created_at: c.created_at,
      reviewed_at: c.reviewed_at,
      // Al aprobar la nota es interna; al rechazar es el motivo para el cliente.
      response: c.status === 'rechazada' ? c.review_notes : c.status === 'aprobada' ? COMPENSATION_TEXT(c) : null,
    } : null,
  };
}

function stars(value, field, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest('Elige de 1 a 5 estrellas', 'MISSING_FIELD');
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw badRequest(`"${field}" debe ser de 1 a 5 estrellas`, 'INVALID_FIELD');
  return n;
}

function text(value, field, max, { required = false, min = 0 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw badRequest(`Escribe ${field}`, 'MISSING_FIELD');
    return null;
  }
  if (typeof value !== 'string') throw badRequest(`"${field}" debe ser texto`, 'INVALID_FIELD');
  const v = value.trim();
  if (v.length < min) throw badRequest(`Cuéntanos un poco más en ${field}`, 'INVALID_FIELD');
  if (v.length > max) throw badRequest(`${field} es demasiado largo (máximo ${max})`, 'INVALID_FIELD');
  return v;
}

function assertOpen(o) {
  if (!feedbackOpen(o)) {
    throw badRequest(
      o.status === 'pagada'
        ? `Solo se puede dentro de los ${FEEDBACK_DAYS} días después de recibir tu pedido`
        : 'Podrás hacerlo cuando recibas tu pedido',
      'FEEDBACK_CLOSED',
    );
  }
}

export async function rateOrder(db, rid, o, body = {}) {
  assertOpen(o);
  const overall = stars(body.overall, 'overall', true);
  const food = stars(body.food, 'food');
  const service = stars(body.service, 'service');
  const comment = text(body.comment, 'el comentario', 500);
  const { rowCount } = await db.query(
    `INSERT INTO order_ratings (restaurant_id, order_id, branch_id, customer_id, overall, food, service, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (restaurant_id, order_id) DO NOTHING`,
    [rid, o.id, o.branch_id, o.customer_id, overall, food, service, comment],
  );
  if (!rowCount) throw conflict('Este pedido ya fue calificado', 'ALREADY_RATED');
}

/** Guarda una foto de evidencia del cliente. Regresa su URL. */
export async function saveEvidence(rid, buf, ext) {
  const dir = path.join(env.uploadsDir, rid, 'quejas');
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(dir, name), buf);
  return `/api/uploads/${rid}/quejas/${name}`;
}

function evidenceList(value, rid) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('evidence_urls debe ser una lista', 'INVALID_FIELD');
  if (value.length > MAX_EVIDENCE) throw badRequest(`Máximo ${MAX_EVIDENCE} fotos`, 'TOO_MANY_PHOTOS');
  const re = new RegExp(`^/api/uploads/${rid}/quejas/[0-9a-f-]{36}\\.(jpg|png|webp|gif)$`);
  for (const u of value) {
    if (typeof u !== 'string' || !re.test(u)) throw badRequest('Foto no válida: súbela de nuevo', 'INVALID_PHOTO');
  }
  return [...new Set(value)];
}

/** Crea la queja. Regresa la fila para los avisos. */
export async function createComplaint(db, rid, o, items, body = {}, customer = null) {
  assertOpen(o);
  const reason = text(body.reason, 'el motivo', 1000, { required: true, min: 3 });
  const ids = body.item_ids === undefined ? [] : body.item_ids;
  if (!Array.isArray(ids)) throw badRequest('item_ids debe ser una lista', 'INVALID_FIELD');
  const chosen = items.filter((i) => !i.voided_at && ids.includes(i.id));
  if (chosen.length !== new Set(ids).size) throw badRequest('Los productos no son de este pedido', 'INVALID_ITEMS');
  const emailIn = text(body.contact_email, 'el correo', 200);
  if (emailIn && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailIn)) throw badRequest('El correo no es válido', 'INVALID_EMAIL');
  const evidence = evidenceList(body.evidence_urls, rid);
  const row = (await db.query(
    `INSERT INTO customer_complaints (restaurant_id, order_id, branch_id, customer_id, contact_name, contact_phone,
                                      contact_email, reason, items, evidence_urls)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (restaurant_id, order_id) DO NOTHING RETURNING *`,
    [rid, o.id, o.branch_id, o.customer_id, o.customer_name, o.customer_phone,
      emailIn || customer?.email || null, reason,
      JSON.stringify(chosen.map((i) => ({ order_item_id: i.id, name: i.name, quantity: i.quantity }))), evidence],
  )).rows[0];
  if (!row) throw conflict('Ya enviaste una queja de este pedido', 'COMPLAINT_EXISTS');
  return row;
}

// ---------------------------------------------------------------------------
// Administracion
// ---------------------------------------------------------------------------

const COMPLAINT_SELECT = `
  SELECT c.*, o.folio, o.order_type, o.total, o.public_token, o.created_at AS order_created_at,
         b.name AS branch_name, e.full_name AS responsible_name, u.name AS reviewed_by_name,
         r.overall AS rating_overall, r.comment AS rating_comment
    FROM customer_complaints c
    JOIN orders o ON o.id = c.order_id AND o.restaurant_id = c.restaurant_id
    JOIN branches b ON b.id = c.branch_id AND b.restaurant_id = c.restaurant_id
    LEFT JOIN employees e ON e.id = c.responsible_employee_id AND e.restaurant_id = c.restaurant_id
    LEFT JOIN users u ON u.id = c.reviewed_by AND u.restaurant_id = c.restaurant_id
    LEFT JOIN order_ratings r ON r.order_id = c.order_id AND r.restaurant_id = c.restaurant_id`;

export async function loadComplaint(db, rid, id, { lock = false } = {}) {
  const row = (await db.query(
    lock
      ? 'SELECT * FROM customer_complaints WHERE id = $1 AND restaurant_id = $2 FOR UPDATE'
      : `${COMPLAINT_SELECT} WHERE c.id = $1 AND c.restaurant_id = $2`,
    [id, rid],
  )).rows[0];
  if (!row) throw notFound('Queja no encontrada', 'COMPLAINT_NOT_FOUND');
  return row;
}

export async function listComplaints(db, rid, { status, branchId }) {
  const params = [rid];
  let where = 'c.restaurant_id = $1';
  if (status) { params.push(status); where += ` AND c.status = $${params.length}`; }
  if (branchId) { params.push(branchId); where += ` AND c.branch_id = $${params.length}`; }
  return (await db.query(
    `${COMPLAINT_SELECT} WHERE ${where} ORDER BY (c.status = 'pendiente') DESC, c.created_at DESC LIMIT 200`,
    params,
  )).rows;
}

/** Promedio, distribucion y comentarios recientes de los ultimos `days` dias. */
export async function ratingsSummary(db, rid, { branchId, days }) {
  const params = [rid, days];
  let where = `r.restaurant_id = $1 AND r.created_at > now() - make_interval(days => $2)`;
  if (branchId) { params.push(branchId); where += ` AND r.branch_id = $${params.length}`; }
  const s = (await db.query(
    `SELECT count(*)::int AS count, round(avg(overall), 2)::float AS overall,
            round(avg(food), 2)::float AS food, round(avg(service), 2)::float AS service,
            count(*) FILTER (WHERE overall = 1)::int AS s1, count(*) FILTER (WHERE overall = 2)::int AS s2,
            count(*) FILTER (WHERE overall = 3)::int AS s3, count(*) FILTER (WHERE overall = 4)::int AS s4,
            count(*) FILTER (WHERE overall = 5)::int AS s5
       FROM order_ratings r WHERE ${where}`,
    params,
  )).rows[0];
  const byBranch = (await db.query(
    `SELECT r.branch_id, b.name AS branch_name, count(*)::int AS count, round(avg(overall), 2)::float AS overall
       FROM order_ratings r JOIN branches b ON b.id = r.branch_id AND b.restaurant_id = r.restaurant_id
      WHERE ${where} GROUP BY r.branch_id, b.name ORDER BY b.name`,
    params,
  )).rows;
  const recent = (await db.query(
    `SELECT r.id, r.overall, r.food, r.service, r.comment, r.created_at, o.folio, o.customer_name, o.public_token,
            b.name AS branch_name
       FROM order_ratings r
       JOIN orders o ON o.id = r.order_id AND o.restaurant_id = r.restaurant_id
       JOIN branches b ON b.id = r.branch_id AND b.restaurant_id = r.restaurant_id
      WHERE ${where} ORDER BY r.created_at DESC LIMIT 100`,
    params,
  )).rows;
  return {
    days,
    count: s.count,
    average: { overall: s.overall, food: s.food, service: s.service },
    distribution: [s.s1, s.s2, s.s3, s.s4, s.s5],
    by_branch: byBranch,
    recent,
  };
}

/** Que se puede dar al resolver una queja (depende de los modulos contratados). */
export async function resolutionOptions(db, rid, { rh }) {
  const [wallet, loyalty] = await Promise.all([activeWallet(db, rid), activeLoyalty(db, rid)]);
  const employees = rh
    ? (await db.query(
      'SELECT id, full_name, branch_id, position FROM employees WHERE restaurant_id = $1 AND active ORDER BY full_name',
      [rid],
    )).rows
    : [];
  return { wallet: Boolean(wallet), points: Boolean(loyalty), payroll: rh, employees };
}

/**
 * Aprueba: empleado responsable (opcional), compensacion al cliente
 * (monedero o puntos, si tiene cuenta y el modulo) y descuento en nomina al
 * responsable (si hay modulo de RH). Todo en la misma transaccion.
 */
export async function approveComplaint(db, rid, id, input, { userId, rh }) {
  const c = await loadComplaint(db, rid, id, { lock: true });
  if (c.status !== 'pendiente') throw conflict('Esta queja ya fue revisada', 'ALREADY_REVIEWED');
  const folio = (await db.query('SELECT folio FROM orders WHERE id = $1 AND restaurant_id = $2', [c.order_id, rid])).rows[0].folio;

  let employeeId = null;
  if (input.responsible_employee_id) {
    if (!rh) throw badRequest('El empleado responsable necesita el módulo de Recursos humanos', 'MODULE_REQUIRED');
    const e = (await db.query(
      'SELECT id FROM employees WHERE id = $1 AND restaurant_id = $2 AND active', [input.responsible_employee_id, rid],
    )).rows[0];
    if (!e) throw badRequest('Empleado responsable no válido', 'EMPLOYEE_NOT_FOUND');
    employeeId = e.id;
  }

  const comp = input.compensation || { type: 'ninguna' };
  let amount = null;
  let points = null;
  if (comp.type === 'monedero' || comp.type === 'puntos') {
    if (!c.customer_id) throw badRequest('El cliente pidió como invitado: no tiene monedero ni puntos', 'GUEST_CUSTOMER');
    if (comp.type === 'monedero') {
      if (!(await activeWallet(db, rid))) throw badRequest('El módulo Monedero no está activo', 'MODULE_REQUIRED');
      amount = comp.amount;
      await applyWallet(db, rid, {
        customerId: c.customer_id, kind: 'adjust', amount, orderId: c.order_id,
        reason: `Compensación por queja del pedido #${folio}`, userId,
      });
    } else {
      if (!(await activeLoyalty(db, rid))) throw badRequest('El módulo Lealtad no está activo', 'MODULE_REQUIRED');
      points = comp.points;
      await applyPoints(db, rid, {
        customerId: c.customer_id, kind: 'adjust', points, orderId: c.order_id,
        reason: `Compensación por queja del pedido #${folio}`, userId,
      });
    }
  }

  let adjustmentId = null;
  if (input.employee_charge) {
    if (!employeeId) throw badRequest('Elige al empleado responsable para descontarle', 'EMPLOYEE_REQUIRED');
    adjustmentId = (await db.query(
      `INSERT INTO payroll_adjustments (restaurant_id, employee_id, kind, concept, amount, recurrence, apply_date, source, notes, created_by)
       VALUES ($1, $2, 'descuento', $3, $4, 'unico', current_date, 'queja', $5, $6) RETURNING id`,
      [rid, employeeId, `Queja de cliente · pedido #${folio}`, input.employee_charge, c.reason.slice(0, 500), userId],
    )).rows[0].id;
  }

  await db.query(
    `UPDATE customer_complaints
        SET status = 'aprobada', reviewed_by = $3, reviewed_at = now(), review_notes = $4,
            responsible_employee_id = $5, compensation_type = $6, compensation_amount = $7, compensation_points = $8,
            employee_charge = $9, payroll_adjustment_id = $10
      WHERE id = $1 AND restaurant_id = $2`,
    [id, rid, userId, input.notes ?? null, employeeId, amount ? 'monedero' : points ? 'puntos' : 'ninguna',
      amount, points, input.employee_charge ?? null, adjustmentId],
  );
}

export async function rejectComplaint(db, rid, id, notes, { userId }) {
  const c = await loadComplaint(db, rid, id, { lock: true });
  if (c.status !== 'pendiente') throw conflict('Esta queja ya fue revisada', 'ALREADY_REVIEWED');
  await db.query(
    `UPDATE customer_complaints SET status = 'rechazada', reviewed_by = $3, reviewed_at = now(), review_notes = $4
      WHERE id = $1 AND restaurant_id = $2`,
    [id, rid, userId, notes],
  );
}
