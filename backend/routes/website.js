// "Sitio web" del restaurante (modulo landing): contenido de la pagina
// publica y galeria. Lectura y escritura: admin y gerente.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';
import { SITE_FIELDS, galleryUrl, normalizeContentPatch, withDefaults } from '../services/siteContent.js';
import { ah, badRequest, notFound, requireUuid, str } from '../utils/http.js';
import { int } from './pos/common.js';

const router = Router();
router.use(authenticateUser, requireModule('landing'), requireRole('admin', 'gerente'));

const GALLERY_COLS = 'id, image_url, caption, sort_order, created_at';
const MAX_GALLERY = 60;

async function readAll(db, restaurantId) {
  const content = (await db.query('SELECT content FROM site_content WHERE restaurant_id = $1', [restaurantId])).rows[0]?.content;
  const gallery = (await db.query(
    `SELECT ${GALLERY_COLS} FROM site_gallery WHERE restaurant_id = $1 ORDER BY sort_order, created_at`,
    [restaurantId],
  )).rows;
  return { content: withDefaults(content), gallery, fields: Object.keys(SITE_FIELDS) };
}

router.get('/', ah(async (req, res) => {
  res.json(await withTenant(req.tenant.id, (db) => readAll(db, req.tenant.id)));
}));

// Cambio parcial del contenido: las llaves enviadas se reemplazan; '' o null las borran.
router.patch('/content', ah(async (req, res) => {
  const { set, unset } = normalizeContentPatch(req.body);
  if (!Object.keys(set).length && !unset.length) throw badRequest('No hay cambios', 'NO_CHANGES');
  const data = await withTenant(req.tenant.id, async (db) => {
    await db.query(
      `INSERT INTO site_content (restaurant_id, content) VALUES ($1, $2::jsonb - $3::text[])
       ON CONFLICT (restaurant_id) DO UPDATE
         SET content = (site_content.content || $2::jsonb) - $3::text[], updated_at = now()`,
      [req.tenant.id, JSON.stringify(set), unset],
    );
    return readAll(db, req.tenant.id);
  });
  res.json(data);
}));

function galleryFields(body, creating) {
  return {
    image_url: body.image_url === undefined && !creating ? undefined : galleryUrl(body.image_url),
    caption: str(body.caption, { field: 'caption', max: 200 }),
    sort_order: int(body.sort_order, { field: 'sort_order', max: 100000 }),
  };
}

router.post('/gallery', ah(async (req, res) => {
  const f = galleryFields(req.body || {}, true);
  const image = await withTenant(req.tenant.id, async (db) => {
    const n = (await db.query('SELECT count(*)::int AS n FROM site_gallery WHERE restaurant_id = $1', [req.tenant.id])).rows[0].n;
    if (n >= MAX_GALLERY) throw badRequest(`La galeria admite hasta ${MAX_GALLERY} imagenes`, 'GALLERY_FULL');
    return (await db.query(
      `INSERT INTO site_gallery (restaurant_id, image_url, caption, sort_order)
       VALUES ($1, $2, $3, coalesce($4::int, $5::int)) RETURNING ${GALLERY_COLS}`,
      [req.tenant.id, f.image_url, f.caption ?? null, f.sort_order ?? null, (n + 1) * 10],
    )).rows[0];
  });
  res.status(201).json({ image });
}));

router.patch('/gallery/:id', ah(async (req, res) => {
  requireUuid(req.params.id);
  const f = Object.entries(galleryFields(req.body || {}, false)).filter(([, v]) => v !== undefined);
  if (!f.length) throw badRequest('No hay cambios', 'NO_CHANGES');
  const image = await withTenant(req.tenant.id, async (db) => (await db.query(
    `UPDATE site_gallery SET ${f.map(([k], i) => `${k} = $${i + 3}`).join(', ')}
      WHERE id = $1 AND restaurant_id = $2 RETURNING ${GALLERY_COLS}`,
    [req.params.id, req.tenant.id, ...f.map(([, v]) => v)],
  )).rows[0]);
  if (!image) throw notFound('Imagen no encontrada', 'IMAGE_NOT_FOUND');
  res.json({ image });
}));

router.delete('/gallery/:id', ah(async (req, res) => {
  requireUuid(req.params.id);
  const { rowCount } = await withTenant(req.tenant.id, (db) =>
    db.query('DELETE FROM site_gallery WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]));
  if (!rowCount) throw notFound('Imagen no encontrada', 'IMAGE_NOT_FOUND');
  res.status(204).end();
}));

export default router;
