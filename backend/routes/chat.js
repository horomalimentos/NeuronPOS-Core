// Chat del equipo (modulo "chat"), como el chat del tablero de Horom: todo el
// personal publica y responde; admin y gerente fijan mensajes y borran los de
// cualquiera. Un mensaje es para todas las sucursales o para una; quien no es
// gerente solo ve (y publica en) las suyas.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser } from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';
import { ah, badRequest, bool, forbidden, notFound, requireUuid, str } from '../utils/http.js';
import { canAccessBranch, isManager } from './pos/common.js';

const router = Router();
router.use(authenticateUser, requireModule('chat'));

const PAGE = 30;

/** Sucursales que ve el usuario (null = todas). */
const visibleBranches = (user) => (isManager(user) ? null : user.branch_ids || []);

const POST_COLS = `p.id, p.branch_id, b.name AS branch_name, p.author_id, u.name AS author_name, u.role AS author_role,
  p.body, p.pinned, p.edited_at, p.created_at, p.last_activity_at,
  (SELECT count(*)::int FROM chat_replies r WHERE r.post_id = p.id) AS reply_count`;
const POST_FROM = `chat_posts p
  JOIN users u ON u.id = p.author_id AND u.restaurant_id = p.restaurant_id
  LEFT JOIN branches b ON b.id = p.branch_id AND b.restaurant_id = p.restaurant_id`;

async function loadPost(db, req, id) {
  requireUuid(id);
  const post = (await db.query(
    `SELECT ${POST_COLS} FROM ${POST_FROM}
      WHERE p.restaurant_id = $1 AND p.id = $2
        AND (p.branch_id IS NULL OR $3::uuid[] IS NULL OR p.branch_id = ANY($3::uuid[]))`,
    [req.tenant.id, id, visibleBranches(req.user)],
  )).rows[0];
  if (!post) throw notFound('Mensaje no encontrado', 'POST_NOT_FOUND');
  return post;
}

function readBranch(req, value) {
  if (value === undefined || value === null || value === '') {
    if (!isManager(req.user)) throw badRequest('Elige la sucursal del mensaje', 'MISSING_FIELD');
    return null;
  }
  requireUuid(value, 'branch_id');
  if (!canAccessBranch(req.user, String(value))) throw forbidden('No tienes acceso a esa sucursal', 'BRANCH_FORBIDDEN');
  return String(value);
}

// Muro: fijados primero y luego por ultima actividad. ?before=<ISO> pagina.
router.get('/posts', ah(async (req, res) => {
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  if (before && Number.isNaN(before.getTime())) throw badRequest('before no es una fecha valida', 'INVALID_FIELD');
  const branch = req.query.branch_id ? requireUuid(String(req.query.branch_id), 'branch_id') : null;
  const result = await withTenant(req.tenant.id, async (db) => {
    const posts = (await db.query(
      `SELECT ${POST_COLS} FROM ${POST_FROM}
        WHERE p.restaurant_id = $1
          AND (p.branch_id IS NULL OR $2::uuid[] IS NULL OR p.branch_id = ANY($2::uuid[]))
          AND ($3::uuid IS NULL OR p.branch_id IS NULL OR p.branch_id = $3)
          AND ($4::timestamptz IS NULL OR (NOT p.pinned AND p.last_activity_at < $4))
        ORDER BY p.pinned DESC, p.last_activity_at DESC LIMIT ${PAGE}`,
      [req.tenant.id, visibleBranches(req.user), branch, before],
    )).rows;
    const seen = (await db.query('SELECT seen_at FROM chat_reads WHERE restaurant_id = $1 AND user_id = $2', [req.tenant.id, req.user.id])).rows[0];
    return { posts, seen_at: seen?.seen_at ?? null };
  });
  res.json({ ...result, has_more: result.posts.filter((p) => !p.pinned).length === PAGE });
}));

// Cuantos mensajes y respuestas de otros hay desde la ultima vez que abrio el chat.
router.get('/unread', ah(async (req, res) => {
  const unread = await withTenant(req.tenant.id, async (db) => (await db.query(
    `WITH seen AS (SELECT coalesce((SELECT seen_at FROM chat_reads WHERE restaurant_id = $1 AND user_id = $2), '-infinity'::timestamptz) AS at)
     SELECT (SELECT count(*)::int FROM chat_posts p, seen
              WHERE p.restaurant_id = $1 AND p.author_id <> $2 AND p.created_at > seen.at
                AND (p.branch_id IS NULL OR $3::uuid[] IS NULL OR p.branch_id = ANY($3::uuid[])))
          + (SELECT count(*)::int FROM chat_replies r JOIN chat_posts p ON p.id = r.post_id, seen
              WHERE r.restaurant_id = $1 AND r.author_id <> $2 AND r.created_at > seen.at
                AND (p.branch_id IS NULL OR $3::uuid[] IS NULL OR p.branch_id = ANY($3::uuid[]))) AS n`,
    [req.tenant.id, req.user.id, visibleBranches(req.user)],
  )).rows[0].n);
  res.json({ unread });
}));

router.post('/seen', ah(async (req, res) => {
  await withTenant(req.tenant.id, (db) => db.query(
    `INSERT INTO chat_reads (restaurant_id, user_id, seen_at) VALUES ($1, $2, now())
     ON CONFLICT (restaurant_id, user_id) DO UPDATE SET seen_at = now()`,
    [req.tenant.id, req.user.id],
  ));
  res.json({ ok: true });
}));

router.post('/posts', ah(async (req, res) => {
  const b = req.body || {};
  const body = str(b.body, { field: 'body', required: true, max: 2000 });
  const branchId = readBranch(req, b.branch_id);
  const post = await withTenant(req.tenant.id, async (db) => {
    const { id } = (await db.query(
      'INSERT INTO chat_posts (restaurant_id, branch_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.tenant.id, branchId, req.user.id, body],
    )).rows[0];
    return loadPost(db, req, id);
  });
  res.status(201).json({ post });
}));

// Editar el texto: solo quien lo escribio.
router.put('/posts/:id', ah(async (req, res) => {
  const body = str((req.body || {}).body, { field: 'body', required: true, max: 2000 });
  const post = await withTenant(req.tenant.id, async (db) => {
    const current = await loadPost(db, req, req.params.id);
    if (current.author_id !== req.user.id) throw forbidden('Solo quien lo escribió puede editarlo', 'NOT_AUTHOR');
    await db.query('UPDATE chat_posts SET body = $3, edited_at = now() WHERE id = $1 AND restaurant_id = $2', [current.id, req.tenant.id, body]);
    return loadPost(db, req, current.id);
  });
  res.json({ post });
}));

router.delete('/posts/:id', ah(async (req, res) => {
  await withTenant(req.tenant.id, async (db) => {
    const current = await loadPost(db, req, req.params.id);
    if (current.author_id !== req.user.id && !isManager(req.user)) throw forbidden('Solo quien lo escribió o un gerente puede borrarlo', 'NOT_AUTHOR');
    await db.query('DELETE FROM chat_posts WHERE id = $1 AND restaurant_id = $2', [current.id, req.tenant.id]);
  });
  res.status(204).end();
}));

router.patch('/posts/:id/pin', ah(async (req, res) => {
  if (!isManager(req.user)) throw forbidden('Solo un gerente puede fijar mensajes');
  const pinned = bool((req.body || {}).pinned, 'pinned');
  if (pinned === undefined) throw badRequest('Indica pinned', 'MISSING_FIELD');
  const post = await withTenant(req.tenant.id, async (db) => {
    const current = await loadPost(db, req, req.params.id);
    await db.query('UPDATE chat_posts SET pinned = $3 WHERE id = $1 AND restaurant_id = $2', [current.id, req.tenant.id, pinned]);
    return loadPost(db, req, current.id);
  });
  res.json({ post });
}));

router.get('/posts/:id/replies', ah(async (req, res) => {
  const replies = await withTenant(req.tenant.id, async (db) => {
    const post = await loadPost(db, req, req.params.id);
    return (await db.query(
      `SELECT r.id, r.author_id, u.name AS author_name, u.role AS author_role, r.body, r.created_at
         FROM chat_replies r JOIN users u ON u.id = r.author_id AND u.restaurant_id = r.restaurant_id
        WHERE r.restaurant_id = $1 AND r.post_id = $2 ORDER BY r.created_at LIMIT 500`,
      [req.tenant.id, post.id],
    )).rows;
  });
  res.json({ replies });
}));

router.post('/posts/:id/replies', ah(async (req, res) => {
  const body = str((req.body || {}).body, { field: 'body', required: true, max: 1000 });
  const reply = await withTenant(req.tenant.id, async (db) => {
    const post = await loadPost(db, req, req.params.id);
    const row = (await db.query(
      `INSERT INTO chat_replies (restaurant_id, post_id, author_id, body) VALUES ($1, $2, $3, $4)
       RETURNING id, author_id, body, created_at`,
      [req.tenant.id, post.id, req.user.id, body],
    )).rows[0];
    await db.query('UPDATE chat_posts SET last_activity_at = now() WHERE id = $1 AND restaurant_id = $2', [post.id, req.tenant.id]);
    return { ...row, author_name: req.user.name, author_role: req.user.role };
  });
  res.status(201).json({ reply });
}));

router.delete('/replies/:id', ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, async (db) => {
    const reply = (await db.query(
      `SELECT r.id, r.author_id, r.post_id FROM chat_replies r WHERE r.restaurant_id = $1 AND r.id = $2`,
      [req.tenant.id, req.params.id],
    )).rows[0];
    if (!reply) throw notFound('Respuesta no encontrada', 'REPLY_NOT_FOUND');
    await loadPost(db, req, reply.post_id); // que pueda ver el mensaje
    if (reply.author_id !== req.user.id && !isManager(req.user)) throw forbidden('Solo quien la escribió o un gerente puede borrarla', 'NOT_AUTHOR');
    await db.query('DELETE FROM chat_replies WHERE id = $1 AND restaurant_id = $2', [reply.id, req.tenant.id]);
  });
  res.status(204).end();
}));

export default router;
