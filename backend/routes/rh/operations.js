// Operacion del personal (modulo "rh"), como en Horom: checklists diarios con
// foto, incidencias (actas) que firma el empleado y comunicados con
// confirmacion de lectura.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { localToday } from '../../services/rh/dates.js';
import { ah, badRequest, bool, notFound, oneOf, requireUuid, str } from '../../utils/http.js';
import { canAccessBranch, requireBranch } from '../pos/common.js';
import { manager } from './common.js';

const router = Router();
const MANAGERS = ['admin', 'gerente'];
const isManager = (req) => MANAGERS.includes(req.user.role);

/** Solo fotos subidas por este restaurante (routes/uploads.js). */
function photoUrl(req, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const prefix = `/api/uploads/${req.tenant.id}/`;
  if (typeof value !== 'string' || !value.startsWith(prefix) || !/^[a-f0-9-]+\.(jpg|png|webp)$/.test(value.slice(prefix.length))) {
    throw badRequest('La foto no es valida', 'INVALID_PHOTO');
  }
  return value;
}

async function myEmployee(db, req) {
  return (await db.query('SELECT id, branch_id, area_id FROM employees WHERE restaurant_id = $1 AND user_id = $2', [req.tenant.id, req.user.id])).rows[0] || null;
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

async function loadTemplates(db, rid, where = '', params = []) {
  const templates = (await db.query(
    `SELECT t.id, t.name, t.branch_id, b.name AS branch_name, t.area_id, a.name AS area_name, t.active
       FROM hr_checklist_templates t
       LEFT JOIN branches b ON b.id = t.branch_id AND b.restaurant_id = t.restaurant_id
       LEFT JOIN hr_areas a ON a.id = t.area_id AND a.restaurant_id = t.restaurant_id
      WHERE t.restaurant_id = $1 ${where} ORDER BY t.name`,
    [rid, ...params],
  )).rows;
  const items = (await db.query(
    'SELECT id, template_id, position, text, requires_photo FROM hr_checklist_items WHERE restaurant_id = $1 AND active ORDER BY position, text',
    [rid],
  )).rows;
  return templates.map((t) => ({ ...t, items: items.filter((i) => i.template_id === t.id) }));
}

router.get('/checklists/templates', manager, ah(async (req, res) => {
  res.json({ templates: await withTenant(req.tenant.id, (db) => loadTemplates(db, req.tenant.id)) });
}));

function templateBody(req, creating) {
  const b = req.body || {};
  const f = {
    name: str(b.name, { field: 'name', required: creating, max: 80 }),
    branch_id: b.branch_id === undefined ? undefined : b.branch_id ? requireUuid(b.branch_id, 'branch_id') : null,
    area_id: b.area_id === undefined ? undefined : b.area_id ? requireUuid(b.area_id, 'area_id') : null,
    active: bool(b.active, 'active'),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  let items;
  if (b.items !== undefined) {
    if (!Array.isArray(b.items) || b.items.length > 60) throw badRequest('items debe ser una lista', 'INVALID_FIELD');
    items = b.items.map((it, i) => ({
      id: it?.id ? requireUuid(it.id, 'items.id') : null,
      text: str(it?.text, { field: 'items.text', required: true, max: 200 }),
      requires_photo: Boolean(it?.requires_photo), position: i,
    }));
    if (creating && !items.length) throw badRequest('Agrega al menos un punto a revisar', 'MISSING_FIELD');
  }
  return { f, items };
}

async function saveItems(db, rid, templateId, items) {
  const keep = items.filter((i) => i.id).map((i) => i.id);
  // Los puntos quitados se desactivan (conservan el historial).
  await db.query('UPDATE hr_checklist_items SET active = false WHERE restaurant_id = $1 AND template_id = $2 AND NOT (id = ANY($3::uuid[]))', [rid, templateId, keep]);
  for (const it of items) {
    if (it.id) {
      await db.query('UPDATE hr_checklist_items SET text = $4, requires_photo = $5, position = $6, active = true WHERE id = $1 AND restaurant_id = $2 AND template_id = $3',
        [it.id, rid, templateId, it.text, it.requires_photo, it.position]);
    } else {
      await db.query('INSERT INTO hr_checklist_items (restaurant_id, template_id, text, requires_photo, position) VALUES ($1, $2, $3, $4, $5)',
        [rid, templateId, it.text, it.requires_photo, it.position]);
    }
  }
}

router.post('/checklists/templates', manager, ah(async (req, res) => {
  const { f, items } = templateBody(req, true);
  if (!items) throw badRequest('Agrega al menos un punto a revisar', 'MISSING_FIELD');
  const template = await withTenant(req.tenant.id, async (db) => {
    const { rows } = await db.query(
      'INSERT INTO hr_checklist_templates (restaurant_id, name, branch_id, area_id, active) VALUES ($1, $2, $3, $4, coalesce($5, true)) RETURNING id',
      [req.tenant.id, f.name, f.branch_id ?? null, f.area_id ?? null, f.active ?? null],
    );
    await saveItems(db, req.tenant.id, rows[0].id, items);
    return (await loadTemplates(db, req.tenant.id, 'AND t.id = $2', [rows[0].id]))[0];
  });
  res.status(201).json({ template });
}));

router.patch('/checklists/templates/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const { f, items } = templateBody(req, false);
  const template = await withTenant(req.tenant.id, async (db) => {
    const cur = await db.query('SELECT 1 FROM hr_checklist_templates WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!cur.rowCount) throw notFound('Checklist no encontrado', 'CHECKLIST_NOT_FOUND');
    const entries = Object.entries(f).filter(([, v]) => v !== undefined);
    if (entries.length) {
      await db.query(`UPDATE hr_checklist_templates SET ${entries.map(([k], i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND restaurant_id = $2`,
        [req.params.id, req.tenant.id, ...entries.map(([, v]) => v)]);
    }
    if (items) await saveItems(db, req.tenant.id, req.params.id, items);
    return (await loadTemplates(db, req.tenant.id, 'AND t.id = $2', [req.params.id]))[0];
  });
  res.json({ template });
}));

/** Corrida de hoy (la crea si no existe) con sus puntos. */
async function todayRun(db, req, templateId, branchId) {
  const tz = (await db.query('SELECT timezone FROM branches WHERE id = $1 AND restaurant_id = $2', [branchId, req.tenant.id])).rows[0]?.timezone;
  const day = localToday(tz || 'America/Mexico_City');
  await db.query(
    `INSERT INTO hr_checklist_runs (restaurant_id, template_id, branch_id, run_date) VALUES ($1, $2, $3, $4)
     ON CONFLICT (template_id, branch_id, run_date) DO NOTHING`,
    [req.tenant.id, templateId, branchId, day],
  );
  return (await db.query('SELECT * FROM hr_checklist_runs WHERE template_id = $1 AND branch_id = $2 AND run_date = $3', [templateId, branchId, day])).rows[0];
}

async function runDetail(db, rid, runId) {
  const run = (await db.query(
    `SELECT r.id, r.template_id, t.name, r.branch_id, b.name AS branch_name, to_char(r.run_date, 'YYYY-MM-DD') AS run_date,
            r.status, r.notes, r.submitted_at, u.name AS submitted_by_name
       FROM hr_checklist_runs r
       JOIN hr_checklist_templates t ON t.id = r.template_id AND t.restaurant_id = r.restaurant_id
       JOIN branches b ON b.id = r.branch_id AND b.restaurant_id = r.restaurant_id
       LEFT JOIN users u ON u.id = r.submitted_by AND u.restaurant_id = r.restaurant_id
      WHERE r.id = $1 AND r.restaurant_id = $2`,
    [runId, rid],
  )).rows[0];
  if (!run) return null;
  run.items = (await db.query(
    `SELECT i.id, i.text, i.requires_photo, coalesce(ri.done, false) AS done, ri.photo_url, ri.note, ri.done_at, u.name AS done_by_name
       FROM hr_checklist_items i
       LEFT JOIN hr_checklist_run_items ri ON ri.item_id = i.id AND ri.run_id = $1 AND ri.restaurant_id = i.restaurant_id
       LEFT JOIN users u ON u.id = ri.done_by AND u.restaurant_id = i.restaurant_id
      WHERE i.restaurant_id = $2 AND i.template_id = $3 AND (i.active OR ri.item_id IS NOT NULL)
      ORDER BY i.position, i.text`,
    [runId, rid, run.template_id],
  )).rows;
  return run;
}

// Checklists de hoy de una sucursal (para quien los llena).
router.get('/checklists/today', ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const data = await withTenant(req.tenant.id, async (db) => {
    const emp = await myEmployee(db, req);
    // Los de la sucursal (o de todas) y, si es empleado con area, los de su area o sin area.
    const templates = (await loadTemplates(db, req.tenant.id, 'AND t.active AND (t.branch_id IS NULL OR t.branch_id = $2)', [branchId]))
      .filter((t) => isManager(req) || !t.area_id || !emp?.area_id || t.area_id === emp.area_id);
    const out = [];
    for (const t of templates) {
      const run = await todayRun(db, req, t.id, branchId);
      out.push(await runDetail(db, req.tenant.id, run.id));
    }
    return out;
  });
  res.json({ runs: data });
}));

// Marcar un punto: { done, photo_url?, note? }.
router.put('/checklists/runs/:id/items/:itemId', ah(async (req, res) => {
  requireUuid(req.params.id);
  requireUuid(req.params.itemId, 'itemId');
  const b = req.body || {};
  const done = bool(b.done, 'done');
  if (done === undefined) throw badRequest('Indica si esta hecho', 'MISSING_FIELD');
  const photo = photoUrl(req, b.photo_url);
  const note = str(b.note, { field: 'note', max: 300 });
  const run = await withTenant(req.tenant.id, async (db) => {
    const r = (await db.query('SELECT * FROM hr_checklist_runs WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [req.params.id, req.tenant.id])).rows[0];
    if (!r || !canAccessBranch(req.user, r.branch_id)) throw notFound('Checklist no encontrado', 'CHECKLIST_NOT_FOUND');
    if (r.status === 'enviado') throw badRequest('El checklist ya se envio', 'CHECKLIST_SENT');
    const item = (await db.query('SELECT requires_photo FROM hr_checklist_items WHERE id = $1 AND template_id = $2 AND restaurant_id = $3', [req.params.itemId, r.template_id, req.tenant.id])).rows[0];
    if (!item) throw notFound('Punto no encontrado', 'ITEM_NOT_FOUND');
    await db.query(
      `INSERT INTO hr_checklist_run_items (restaurant_id, run_id, item_id, done, photo_url, note, done_by, done_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 THEN now() END)
       ON CONFLICT (run_id, item_id) DO UPDATE SET done = EXCLUDED.done,
         photo_url = coalesce(EXCLUDED.photo_url, hr_checklist_run_items.photo_url),
         note = coalesce(EXCLUDED.note, hr_checklist_run_items.note),
         done_by = EXCLUDED.done_by, done_at = EXCLUDED.done_at`,
      [req.tenant.id, r.id, req.params.itemId, done, photo ?? null, note ?? null, req.user.id],
    );
    return runDetail(db, req.tenant.id, r.id);
  });
  res.json({ run });
}));

// Enviar: todos los puntos hechos y con foto donde se pide.
router.post('/checklists/runs/:id/submit', ah(async (req, res) => {
  requireUuid(req.params.id);
  const run = await withTenant(req.tenant.id, async (db) => {
    const r = await runDetail(db, req.tenant.id, req.params.id);
    if (!r || !canAccessBranch(req.user, r.branch_id)) throw notFound('Checklist no encontrado', 'CHECKLIST_NOT_FOUND');
    if (r.status === 'enviado') throw badRequest('El checklist ya se envio', 'CHECKLIST_SENT');
    const missing = r.items.filter((i) => !i.done || (i.requires_photo && !i.photo_url));
    if (missing.length) throw badRequest(`Falta: ${missing.map((i) => i.text).join(', ')}`, 'CHECKLIST_INCOMPLETE');
    await db.query(`UPDATE hr_checklist_runs SET status = 'enviado', submitted_by = $3, submitted_at = now(), notes = $4 WHERE id = $1 AND restaurant_id = $2`,
      [r.id, req.tenant.id, req.user.id, str(req.body?.notes, { field: 'notes', max: 500 }) || null]);
    return runDetail(db, req.tenant.id, r.id);
  });
  res.json({ run });
}));

// Historial (gerente): ?branch_id=&from=&to=
router.get('/checklists/runs', manager, ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const runs = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT r.id, t.name, to_char(r.run_date, 'YYYY-MM-DD') AS run_date, r.status, r.submitted_at, u.name AS submitted_by_name,
            (SELECT count(*)::int FROM hr_checklist_run_items ri WHERE ri.run_id = r.id AND ri.done) AS done,
            (SELECT count(*)::int FROM hr_checklist_items i WHERE i.template_id = r.template_id AND i.active) AS total
       FROM hr_checklist_runs r
       JOIN hr_checklist_templates t ON t.id = r.template_id AND t.restaurant_id = r.restaurant_id
       LEFT JOIN users u ON u.id = r.submitted_by AND u.restaurant_id = r.restaurant_id
      WHERE r.restaurant_id = $1 AND r.branch_id = $2 ORDER BY r.run_date DESC, t.name LIMIT 200`,
    [req.tenant.id, branchId],
  )).rows);
  res.json({ runs });
}));

router.get('/checklists/runs/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const run = await withTenant(req.tenant.id, (db) => runDetail(db, req.tenant.id, req.params.id));
  if (!run) throw notFound('Checklist no encontrado', 'CHECKLIST_NOT_FOUND');
  res.json({ run });
}));

// ---------------------------------------------------------------------------
// Incidencias
// ---------------------------------------------------------------------------

const INCIDENT_KINDS = ['retardo', 'falta', 'conducta', 'accidente', 'otro'];
const INCIDENT_SELECT = `
  SELECT i.id, i.employee_id, e.full_name AS employee_name, i.kind, to_char(i.occurred_on, 'YYYY-MM-DD') AS occurred_on,
         i.description, i.action_taken, i.evidence, i.status, i.employee_comment, i.employee_signed_at,
         u.name AS created_by_name, i.created_at
    FROM hr_incidents i
    JOIN employees e ON e.id = i.employee_id AND e.restaurant_id = i.restaurant_id
    LEFT JOIN users u ON u.id = i.created_by AND u.restaurant_id = i.restaurant_id`;

router.get('/incidents', manager, ah(async (req, res) => {
  const employeeId = req.query.employee_id ? requireUuid(req.query.employee_id, 'employee_id') : null;
  const incidents = await withTenant(req.tenant.id, async (db) => (await db.query(
    `${INCIDENT_SELECT} WHERE i.restaurant_id = $1 AND ($2::uuid IS NULL OR i.employee_id = $2) ORDER BY i.occurred_on DESC, i.created_at DESC LIMIT 300`,
    [req.tenant.id, employeeId],
  )).rows);
  res.json({ incidents });
}));

router.post('/incidents', manager, ah(async (req, res) => {
  const b = req.body || {};
  const employeeId = requireUuid(b.employee_id, 'employee_id');
  const kind = oneOf(b.kind, INCIDENT_KINDS, 'kind');
  if (!kind) throw badRequest('Elige el tipo de incidencia', 'MISSING_FIELD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.occurred_on || ''))) throw badRequest('La fecha debe ser AAAA-MM-DD', 'INVALID_FIELD');
  const description = str(b.description, { field: 'description', required: true, max: 2000 });
  const evidence = Array.isArray(b.evidence) ? b.evidence.slice(0, 6).map((u) => photoUrl(req, u)) : [];
  const incident = await withTenant(req.tenant.id, async (db) => {
    const e = await db.query('SELECT 1 FROM employees WHERE id = $1 AND restaurant_id = $2', [employeeId, req.tenant.id]);
    if (!e.rowCount) throw badRequest('El empleado no existe', 'EMPLOYEE_NOT_FOUND');
    const { rows } = await db.query(
      `INSERT INTO hr_incidents (restaurant_id, employee_id, kind, occurred_on, description, action_taken, evidence, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.tenant.id, employeeId, kind, b.occurred_on, description, str(b.action_taken, { field: 'action_taken', max: 500 }) || null, evidence, req.user.id],
    );
    return (await db.query(`${INCIDENT_SELECT} WHERE i.id = $1`, [rows[0].id])).rows[0];
  });
  res.status(201).json({ incident });
}));

router.post('/incidents/:id/close', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const incident = await withTenant(req.tenant.id, async (db) => {
    const { rowCount } = await db.query(`UPDATE hr_incidents SET status = 'cerrada', updated_at = now() WHERE id = $1 AND restaurant_id = $2`, [req.params.id, req.tenant.id]);
    if (!rowCount) throw notFound('Incidencia no encontrada', 'INCIDENT_NOT_FOUND');
    return (await db.query(`${INCIDENT_SELECT} WHERE i.id = $1`, [req.params.id])).rows[0];
  });
  res.json({ incident });
}));

// El empleado ve las suyas y las firma (enterado) con su comentario.
router.get('/me/incidents', ah(async (req, res) => {
  const incidents = await withTenant(req.tenant.id, async (db) => {
    const emp = await myEmployee(db, req);
    if (!emp) return [];
    return (await db.query(`${INCIDENT_SELECT} WHERE i.restaurant_id = $1 AND i.employee_id = $2 ORDER BY i.occurred_on DESC`, [req.tenant.id, emp.id])).rows;
  });
  res.json({ incidents });
}));

router.post('/me/incidents/:id/sign', ah(async (req, res) => {
  requireUuid(req.params.id);
  const comment = str(req.body?.comment, { field: 'comment', max: 1000 }) || null;
  const incident = await withTenant(req.tenant.id, async (db) => {
    const emp = await myEmployee(db, req);
    const { rowCount } = await db.query(
      `UPDATE hr_incidents SET status = 'firmada', employee_signed_at = now(), employee_comment = $4, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2 AND employee_id = $3 AND status = 'pendiente'`,
      [req.params.id, req.tenant.id, emp?.id ?? null, comment],
    );
    if (!rowCount) throw notFound('Incidencia no encontrada o ya firmada', 'INCIDENT_NOT_FOUND');
    return (await db.query(`${INCIDENT_SELECT} WHERE i.id = $1`, [req.params.id])).rows[0];
  });
  res.json({ incident });
}));

// ---------------------------------------------------------------------------
// Comunicados
// ---------------------------------------------------------------------------

router.get('/announcements', manager, ah(async (req, res) => {
  const announcements = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT n.id, n.title, n.body, n.priority, n.branch_id, b.name AS branch_name, n.area_id, a.name AS area_name,
            n.starts_at, n.ends_at, n.created_at, u.name AS created_by_name,
            (SELECT count(*)::int FROM hr_announcement_reads r WHERE r.announcement_id = n.id) AS reads
       FROM hr_announcements n
       LEFT JOIN branches b ON b.id = n.branch_id AND b.restaurant_id = n.restaurant_id
       LEFT JOIN hr_areas a ON a.id = n.area_id AND a.restaurant_id = n.restaurant_id
       LEFT JOIN users u ON u.id = n.created_by AND u.restaurant_id = n.restaurant_id
      WHERE n.restaurant_id = $1 ORDER BY n.starts_at DESC LIMIT 200`,
    [req.tenant.id],
  )).rows);
  res.json({ announcements });
}));

router.post('/announcements', manager, ah(async (req, res) => {
  const b = req.body || {};
  const ends = b.ends_at ? new Date(b.ends_at) : null;
  if (ends && Number.isNaN(ends.getTime())) throw badRequest('La fecha de fin no es valida', 'INVALID_FIELD');
  const announcement = await withTenant(req.tenant.id, async (db) => (await db.query(
    `INSERT INTO hr_announcements (restaurant_id, title, body, priority, branch_id, area_id, ends_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, title, priority`,
    [req.tenant.id, str(b.title, { field: 'title', required: true, max: 120 }), str(b.body, { field: 'body', required: true, max: 4000 }),
      oneOf(b.priority, ['normal', 'importante'], 'priority') || 'normal',
      b.branch_id ? requireUuid(b.branch_id, 'branch_id') : null, b.area_id ? requireUuid(b.area_id, 'area_id') : null, ends, req.user.id],
  )).rows[0]);
  res.status(201).json({ announcement });
}));

router.delete('/announcements/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, (db) => db.query('DELETE FROM hr_announcements WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]));
  res.status(204).end();
}));

// Avisos vigentes para el usuario (por su sucursal y su area), con leido / no leido.
router.get('/announcements/feed', ah(async (req, res) => {
  const announcements = await withTenant(req.tenant.id, async (db) => {
    const emp = await myEmployee(db, req);
    const branches = isManager(req) ? null : [...(req.user.branch_ids || []), emp?.branch_id].filter(Boolean);
    return (await db.query(
      `SELECT n.id, n.title, n.body, n.priority, n.starts_at, n.ends_at, u.name AS created_by_name,
              (r.user_id IS NOT NULL) AS read
         FROM hr_announcements n
         LEFT JOIN users u ON u.id = n.created_by AND u.restaurant_id = n.restaurant_id
         LEFT JOIN hr_announcement_reads r ON r.announcement_id = n.id AND r.user_id = $2
        WHERE n.restaurant_id = $1 AND n.starts_at <= now() AND (n.ends_at IS NULL OR n.ends_at > now())
          AND (n.branch_id IS NULL OR $3::uuid[] IS NULL OR n.branch_id = ANY($3::uuid[]))
          AND (n.area_id IS NULL OR $4::uuid IS NULL OR n.area_id = $4)
        ORDER BY (r.user_id IS NOT NULL), n.priority = 'importante' DESC, n.starts_at DESC LIMIT 50`,
      [req.tenant.id, req.user.id, branches, isManager(req) ? null : emp?.area_id ?? null],
    )).rows;
  });
  res.json({ announcements });
}));

router.post('/announcements/:id/read', ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, async (db) => {
    const n = await db.query('SELECT 1 FROM hr_announcements WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!n.rowCount) throw notFound('Comunicado no encontrado', 'ANNOUNCEMENT_NOT_FOUND');
    await db.query('INSERT INTO hr_announcement_reads (restaurant_id, announcement_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [req.tenant.id, req.params.id, req.user.id]);
  });
  res.json({ ok: true });
}));

export default router;
