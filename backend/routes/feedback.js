// Calificaciones y quejas (modulo 'quejas'): resumen de estrellas por
// sucursal y bandeja de quejas para aprobarlas (con compensacion y descuento
// al responsable) o rechazarlas con motivo. Solo administrador y gerente.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { loadModuleRow, requireModule } from '../middleware/requireModule.js';
import { checkModuleAccess } from '../services/access.js';
import { sendComplaintResolved } from '../services/emails.js';
import {
  approveComplaint, listComplaints, loadComplaint, ratingsSummary, rejectComplaint, resolutionOptions,
} from '../services/feedback.js';
import {
  ah, badRequest, money, oneOf, requireUuid, str,
} from '../utils/http.js';
import { ROLES, int } from './pos/common.js';

const router = Router();
router.use(authenticateUser, requireModule('quejas'), requireRole(...ROLES.manage));

const hasRh = async (tenant) => !checkModuleAccess(tenant, 'rh', await loadModuleRow(tenant.id, 'rh'));

function branchFilter(value) {
  if (!value) return null;
  return requireUuid(value, 'branch_id');
}

router.get('/ratings', ah(async (req, res) => {
  const days = int(req.query.days ?? '30', { field: 'days', min: 1, max: 365 });
  const branchId = branchFilter(req.query.branch_id);
  res.json({ summary: await withTenant(req.tenant.id, (db) => ratingsSummary(db, req.tenant.id, { branchId, days })) });
}));

router.get('/complaints', ah(async (req, res) => {
  const status = oneOf(req.query.status || undefined, ['pendiente', 'aprobada', 'rechazada'], 'status');
  const branchId = branchFilter(req.query.branch_id);
  const rh = await hasRh(req.tenant);
  const data = await withTenant(req.tenant.id, async (db) => {
    const complaints = await listComplaints(db, req.tenant.id, { status, branchId });
    const pending = (await db.query(
      "SELECT count(*)::int AS n FROM customer_complaints WHERE restaurant_id = $1 AND status = 'pendiente'", [req.tenant.id],
    )).rows[0].n;
    return { complaints, pending_count: pending, options: await resolutionOptions(db, req.tenant.id, { rh }) };
  });
  res.json(data);
}));

router.get('/complaints/pending-count', ah(async (req, res) => {
  const n = await withTenant(req.tenant.id, async (db) => (await db.query(
    "SELECT count(*)::int AS n FROM customer_complaints WHERE restaurant_id = $1 AND status = 'pendiente'", [req.tenant.id],
  )).rows[0].n);
  res.json({ pending_count: n });
}));

function readCompensation(value) {
  if (value === undefined || value === null) return { type: 'ninguna' };
  if (typeof value !== 'object') throw badRequest('compensation no es valido', 'INVALID_FIELD');
  const type = oneOf(value.type ?? 'ninguna', ['ninguna', 'monedero', 'puntos'], 'compensation.type');
  if (type === 'monedero') {
    const amount = money(value.amount, { field: 'compensation.amount' });
    if (!(amount > 0) || amount > 100000) throw badRequest('Indica el monto a abonar al monedero', 'INVALID_FIELD');
    return { type, amount };
  }
  if (type === 'puntos') {
    const points = int(value.points, { field: 'compensation.points', min: 1, max: 1000000 });
    if (!points) throw badRequest('Indica los puntos a regalar', 'INVALID_FIELD');
    return { type, points };
  }
  return { type };
}

async function resolved(req, id) {
  const c = await withTenant(req.tenant.id, (db) => loadComplaint(db, req.tenant.id, id));
  if (c.contact_email) void sendComplaintResolved(req.tenant, c);
  return c;
}

router.post('/complaints/:id/approve', ah(async (req, res) => {
  requireUuid(req.params.id);
  const b = req.body || {};
  const input = {
    responsible_employee_id: b.responsible_employee_id ? requireUuid(b.responsible_employee_id, 'responsible_employee_id') : null,
    compensation: readCompensation(b.compensation),
    employee_charge: b.employee_charge ? money(b.employee_charge, { field: 'employee_charge' }) || null : null,
    notes: str(b.notes, { field: 'notes', max: 1000 }) ?? null,
  };
  const rh = await hasRh(req.tenant);
  await withTenant(req.tenant.id, (db) => approveComplaint(db, req.tenant.id, req.params.id, input, { userId: req.user.id, rh }));
  res.json({ complaint: await resolved(req, req.params.id) });
}));

router.post('/complaints/:id/reject', ah(async (req, res) => {
  requireUuid(req.params.id);
  const notes = str((req.body || {}).notes, { field: 'notes', required: true, max: 1000 });
  await withTenant(req.tenant.id, (db) => rejectComplaint(db, req.tenant.id, req.params.id, notes, { userId: req.user.id }));
  res.json({ complaint: await resolved(req, req.params.id) });
}));

export default router;
