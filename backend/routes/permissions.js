// Permisos por rol del restaurante (pantalla Usuarios > Permisos). Leer:
// admin y gerente; cambiar: solo admin.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { requireOperational } from '../middleware/requireModule.js';
import { CAPABILITIES, EDITABLE_ROLES, capabilitiesFor } from '../services/permissions.js';
import { ah, badRequest, bool, oneOf } from '../utils/http.js';

const router = Router();
router.use(authenticateUser, requireOperational);

async function matrix(db, rid) {
  const roles = {};
  for (const role of EDITABLE_ROLES) roles[role] = [...await capabilitiesFor(db, rid, role)];
  return {
    capabilities: Object.entries(CAPABILITIES).map(([key, c]) => ({ key, label: c.label, defaults: c.defaults })),
    roles,
  };
}

router.get('/', requireRole('admin', 'gerente'), ah(async (req, res) => {
  res.json(await withTenant(req.tenant.id, (db) => matrix(db, req.tenant.id)));
}));

// { role, capability, allowed } ; allowed null = regresar al valor por omision.
router.put('/', requireRole('admin'), ah(async (req, res) => {
  const b = req.body || {};
  const role = oneOf(b.role, EDITABLE_ROLES, 'role');
  if (!role) throw badRequest('Elige el rol', 'MISSING_FIELD');
  if (!CAPABILITIES[b.capability]) throw badRequest('Permiso desconocido', 'INVALID_FIELD');
  const allowed = b.allowed === null ? null : bool(b.allowed, 'allowed');
  if (allowed === undefined) throw badRequest('Indica si se permite', 'MISSING_FIELD');
  const data = await withTenant(req.tenant.id, async (db) => {
    if (allowed === null) {
      await db.query('DELETE FROM role_permissions WHERE restaurant_id = $1 AND role = $2 AND capability = $3', [req.tenant.id, role, b.capability]);
    } else {
      await db.query(
        `INSERT INTO role_permissions (restaurant_id, role, capability, allowed, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (restaurant_id, role, capability) DO UPDATE SET allowed = EXCLUDED.allowed, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.tenant.id, role, b.capability, allowed, req.user.id],
      );
    }
    return matrix(db, req.tenant.id);
  });
  res.json(data);
}));

export default router;
