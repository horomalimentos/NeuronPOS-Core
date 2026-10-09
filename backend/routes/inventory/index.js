// Modulo de inventario ('inventario'): insumos, areas, proveedores,
// existencias por sucursal con kardex, conteos, mermas, recetas y compras.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { authenticateUser, requireRole } from '../../middleware/auth.js';
import { requireModule } from '../../middleware/requireModule.js';
import { ah, bool } from '../../utils/http.js';
import { int } from '../pos/common.js';
import catalogRouter from './catalog.js';
import { INV_ROLES, loadSettings } from './common.js';
import countsRouter from './counts.js';
import purchasesRouter from './purchases.js';
import recipesRouter from './recipes.js';
import stockRouter from './stock.js';

const router = Router();
router.use(authenticateUser, requireModule('inventario'));

router.get('/settings', requireRole(...INV_ROLES.staff), ah(async (req, res) => {
  res.json({ settings: await withTenant(req.tenant.id, (db) => loadSettings(db, req.tenant.id)) });
}));

router.patch('/settings', requireRole(...INV_ROLES.manage), ah(async (req, res) => {
  const body = req.body || {};
  const deduct = bool(body.deduct_on_sale, 'deduct_on_sale');
  const days = int(body.order_cover_days, { field: 'order_cover_days', min: 1, max: 60 });
  const settings = await withTenant(req.tenant.id, async (db) => {
    const cur = await loadSettings(db, req.tenant.id);
    await db.query(
      `INSERT INTO inv_settings (restaurant_id, deduct_on_sale, order_cover_days) VALUES ($1, $2, $3)
       ON CONFLICT (restaurant_id) DO UPDATE SET deduct_on_sale = $2, order_cover_days = $3, updated_at = now()`,
      [req.tenant.id, deduct ?? cur.deduct_on_sale, days ?? cur.order_cover_days],
    );
    return loadSettings(db, req.tenant.id);
  });
  res.json({ settings });
}));

router.use(catalogRouter);
router.use(stockRouter);
router.use(countsRouter);
router.use(recipesRouter);
router.use(purchasesRouter);

export default router;
