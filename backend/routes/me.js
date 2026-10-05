import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser } from '../middleware/auth.js';
import { checkRestaurantAccess } from '../services/access.js';
import { listRestaurantModules } from '../services/restaurants.js';
import { ah } from '../utils/http.js';

const router = Router();

// Sesion actual: usuario, restaurante (marca y estado), modulos y sucursales.
router.get('/', authenticateUser, ah(async (req, res) => {
  const { tenant, user } = req;
  const data = await withTenant(tenant.id, async (db) => {
    const modules = await listRestaurantModules(db, tenant.id);
    const branches = await db.query(
      `SELECT id, name, address, phone, timezone, active FROM branches
        WHERE restaurant_id = $1 AND ($2 OR id = ANY($3::uuid[]))
        ORDER BY name`,
      [tenant.id, ['admin', 'gerente'].includes(user.role), user.branch_ids],
    );
    return { modules, branches: branches.rows };
  });
  const access = checkRestaurantAccess(tenant);
  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role, branch_ids: user.branch_ids },
    restaurant: { ...tenant, access_error: access ? { code: access.code, error: access.error } : null },
    // Al restaurante no se le muestran precios de plataforma.
    modules: data.modules.map((m) => ({
      code: m.module_code, name: m.name, description: m.description, enabled: m.is_active,
    })),
    branches: data.branches,
  });
}));

export default router;
