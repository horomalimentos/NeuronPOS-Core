// Datos publicos del sitio del restaurante resuelto por Host/slug: marca,
// modulos habilitados y sucursales. Sin autenticacion; sin precios.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { requireTenant } from '../middleware/tenant.js';
import { checkRestaurantAccess } from '../services/access.js';
import { listRestaurantModules } from '../services/restaurants.js';
import { ah } from '../utils/http.js';

const router = Router();

router.get('/site', requireTenant, ah(async (req, res) => {
  const t = req.tenant;
  const { modules, branches } = await withTenant(t.id, async (db) => ({
    modules: await listRestaurantModules(db, t.id),
    branches: (await db.query(
      `SELECT name, address, phone, timezone FROM branches
        WHERE restaurant_id = $1 AND active ORDER BY name`,
      [t.id],
    )).rows,
  }));
  const available = !checkRestaurantAccess(t);
  res.json({
    restaurant: {
      slug: t.slug,
      name: t.name,
      logo_url: t.logo_url,
      primary_color: t.primary_color,
      secondary_color: t.secondary_color,
      available,
    },
    modules: available ? modules.filter((m) => m.is_active).map((m) => m.module_code) : [],
    branches: available ? branches : [],
  });
}));

export default router;
