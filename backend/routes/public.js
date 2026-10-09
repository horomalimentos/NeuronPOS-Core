// Datos publicos del sitio del restaurante resuelto por Host/slug. Sin
// autenticacion; nunca regresan precios de plataforma ni datos internos.
//
//   GET /api/public/site     marca, modulos habilitados, sucursales con
//                            horario y SEO basico (siempre disponible).
//   GET /api/public/landing  contenido del sitio web (modulo "landing"):
//                            portada, acerca de, galeria, menu de muestra.
//   GET /api/public/plans    pagina principal de NeuronPOS: modulos activos
//                            con su precio mensual de catalogo y dias de
//                            prueba (no requiere restaurante).
import { Router } from 'express';
import pool, { withTenant } from '../config/database.js';
import { publicLimiter } from '../middleware/rateLimits.js';
import { loadModuleRow, requireModule } from '../middleware/requireModule.js';
import { requireTenant } from '../middleware/tenant.js';
import { checkModuleAccess, checkRestaurantAccess } from '../services/access.js';
import { getOnlineSettings, loadBranches, publicBranch } from '../services/online.js';
import { listRestaurantModules } from '../services/restaurants.js';
import { withDefaults } from '../services/siteContent.js';
import { ah } from '../utils/http.js';

const router = Router();
router.use(publicLimiter);

async function readContent(db, restaurantId) {
  const { rows } = await db.query('SELECT content FROM site_content WHERE restaurant_id = $1', [restaurantId]);
  return withDefaults(rows[0]?.content);
}

const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS, 10) || 14;

router.get('/plans', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT code, name, description, monthly_price_mxn
       FROM modules WHERE active ORDER BY sort_order, code`,
  );
  res.json({ modules: rows, trial_days: TRIAL_DAYS });
}));

router.get('/site', requireTenant, ah(async (req, res) => {
  const t = req.tenant;
  const available = !checkRestaurantAccess(t);
  const data = await withTenant(t.id, async (db) => {
    const modules = (await listRestaurantModules(db, t.id)).filter((m) => m.is_active).map((m) => m.module_code);
    const content = modules.includes('landing') ? await readContent(db, t.id) : {};
    const online = modules.includes('portal') ? await getOnlineSettings(db, t.id) : null;
    return { modules, content, online, branches: await loadBranches(db, t.id) };
  });
  const modules = available ? data.modules : [];
  res.json({
    restaurant: {
      slug: t.slug,
      name: t.name,
      logo_url: t.logo_url,
      primary_color: t.primary_color,
      secondary_color: t.secondary_color,
      available,
    },
    modules,
    // Pedidos en linea: portal contratado y encendido por el restaurante.
    ordering: modules.includes('portal') && Boolean(data.online?.enabled),
    seo: {
      title: (modules.includes('landing') && data.content.seo_title) || t.name,
      description: (modules.includes('landing') && (data.content.seo_description || data.content.hero_subtitle)) || null,
    },
    branches: available ? data.branches.map(publicBranch) : [],
  });
}));

router.get('/landing', requireTenant, requireModule('landing'), ah(async (req, res) => {
  const t = req.tenant;
  const portalRow = await loadModuleRow(t.id, 'portal');
  const portalActive = !checkModuleAccess(t, 'portal', portalRow);
  const data = await withTenant(t.id, async (db) => {
    const content = await readContent(db, t.id);
    const gallery = content.show_gallery ? (await db.query(
      `SELECT id, image_url, caption FROM site_gallery WHERE restaurant_id = $1 ORDER BY sort_order, created_at`,
      [t.id],
    )).rows : [];
    let menu = [];
    if (content.show_menu) {
      const cats = (await db.query(
        `SELECT id, name, description FROM menu_categories WHERE restaurant_id = $1 AND active ORDER BY sort_order, name`,
        [t.id],
      )).rows;
      const items = (await db.query(
        `SELECT id, category_id, name, description, price, image_url FROM menu_items
          WHERE restaurant_id = $1 AND active ORDER BY sort_order, name`,
        [t.id],
      )).rows;
      menu = cats
        .map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id).map(({ category_id, ...i }) => i) }))
        .filter((c) => c.items.length);
    }
    const online = portalActive ? await getOnlineSettings(db, t.id) : null;
    return { content, gallery, menu, online, branches: await loadBranches(db, t.id) };
  });
  res.json({
    restaurant: { slug: t.slug, name: t.name, logo_url: t.logo_url, primary_color: t.primary_color, secondary_color: t.secondary_color },
    content: data.content,
    gallery: data.gallery,
    menu: data.menu,
    branches: data.branches.map(publicBranch),
    ordering: portalActive && Boolean(data.online?.enabled),
  });
}));

export default router;
