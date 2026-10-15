// Restaurantes de Nayo que cocinan con su propio POS (por ahora, Horom).
//
// El restaurante existe en NeuronPOS como cualquier otro (ficha de Nayo,
// sucursal, horario), pero:
//   - su menu se copia del POS externo (syncExternalMenus): mismos productos,
//     precios, extras y disponibilidad, con el id de alla en external_id;
//   - cada pedido de Nayo se reenvia al POS externo (forwardExternalOrders),
//     que lo mete a su cocina como un pedido mas; aqui queda aceptado solo;
//   - cuando su cocina lo termina, aqui pasa a "listo" (pollExternalOrders)
//     y el repartidor lo ve como en cualquier restaurante.
//
// La conexion (URL, sucursal de alla) va en external_pos_links, que solo la
// plataforma puede cambiar; la clave compartida va en el .env
// (EXTERNAL_POS_KEY_HOROM). Todo corre en jobs.js.
import { withPlatform, withTenant } from '../config/database.js';
import { acceptOnlineOrder } from './online.js';

const TIMEOUT_MS = 8000;
// Despues de tantos intentos fallidos (POS caido) el pedido se rechaza para
// que el cliente no se quede esperando: con tarjeta queda para reembolso.
const MAX_ATTEMPTS = 6;

export class ExternalPosError extends Error {
  constructor(message, { status = 0, code = null, definitive = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.definitive = definitive;
  }
}

function keyFor(provider) {
  return process.env[`EXTERNAL_POS_KEY_${provider.toUpperCase()}`] || '';
}

/** Llamada al POS externo. 4xx = definitivo (cerrado, producto agotado...); red o 5xx = reintentar. */
export async function callExternal(link, path, { method = 'GET', body } = {}) {
  const url = `${link.base_url.replace(/\/+$/, '')}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-integration-key': keyFor(link.provider) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ExternalPosError(`Sin respuesta del POS externo: ${err.message}`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    throw new ExternalPosError(String(message).slice(0, 300), {
      status: res.status, code: data?.code || null, definitive: res.status >= 400 && res.status < 500,
    });
  }
  return data;
}

async function activeLinks() {
  return withPlatform(async (db) => (await db.query(
    'SELECT * FROM external_pos_links WHERE active ORDER BY created_at',
  )).rows);
}

async function saveLinkStatus(link, { error = null, synced = false }) {
  await withPlatform((db) => db.query(
    `UPDATE external_pos_links SET last_error = $2, menu_synced_at = CASE WHEN $3 THEN now() ELSE menu_synced_at END,
            updated_at = now() WHERE restaurant_id = $1`,
    [link.restaurant_id, error, synced],
  ));
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function imageUrl(link, url) {
  if (!url || typeof url !== 'string') return null;
  if (/^https:\/\//.test(url)) return url.slice(0, 1000);
  if (url.startsWith('/') && link.public_url) return `${link.public_url.replace(/\/+$/, '')}${url}`.slice(0, 1000);
  return null;
}

/**
 * Un grupo de alla puede tener minimo/maximo distinto en cada producto; aqui
 * el minimo/maximo es del grupo, asi que hay un grupo por combinacion.
 */
export function groupShape(g) {
  const single = g.selection_type === 'single';
  let min = Math.max(0, Number(g.min_selections) || 0);
  if (g.is_required && min < 1) min = 1;
  let max = single ? 1 : (g.max_selections === null || g.max_selections === undefined ? null : Number(g.max_selections));
  if (max !== null && (!Number.isInteger(max) || max < 1)) max = null;
  if (max !== null && max < min) max = min;
  return { key: `${g.modifier_group_id}:${min}:${max ?? ''}`, min, max };
}

/** Lee el menu completo de la sucursal externa. */
export async function fetchExternalMenu(link) {
  const q = `?branch_id=${encodeURIComponent(link.external_branch_id)}`;
  const categories = await callExternal(link, `/api/web/menu/categories${q}`);
  const items = await callExternal(link, `/api/web/menu/items${q}`);
  if (!Array.isArray(categories) || !Array.isArray(items)) throw new ExternalPosError('Menu externo con formato inesperado');
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    const groups = await callExternal(link, `/api/web/menu/items/${encodeURIComponent(item.id)}/modifiers`);
    item.modifier_groups = Array.isArray(groups) ? groups : [];
  }
  return { categories, items };
}

/** Copia el menu externo al restaurante (idempotente; lo que ya no esta queda inactivo, nunca se borra). */
export async function applyExternalMenu(link, menu) {
  const rid = link.restaurant_id;
  return withTenant(rid, async (db) => {
    const catIds = new Map();
    let order = 0;
    for (const c of menu.categories) {
      order += 1;
      const { rows } = await db.query(
        `INSERT INTO menu_categories (restaurant_id, name, description, sort_order, active, external_id)
         VALUES ($1, $2, $3, $4, true, $5)
         ON CONFLICT (restaurant_id, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, sort_order = EXCLUDED.sort_order,
                       active = true, updated_at = now()
         RETURNING id`,
        [rid, String(c.name).slice(0, 200), c.description || null, Number(c.display_order) || order, String(c.id)],
      );
      catIds.set(String(c.id), rows[0].id);
    }
    await db.query(
      `UPDATE menu_categories SET active = false, updated_at = now()
        WHERE restaurant_id = $1 AND external_id IS NOT NULL AND active AND NOT (external_id = ANY($2::text[]))`,
      [rid, [...catIds.keys()]],
    );

    const groupIds = new Map();
    const seenGroups = new Set();
    const seenItems = [];
    let itemOrder = 0;
    for (const item of menu.items) {
      const cid = catIds.get(String(item.category_id));
      if (!cid) continue;
      itemOrder += 1;
      const available = item.is_available !== false && !item.active_override;
      const { rows } = await db.query(
        `INSERT INTO menu_items (restaurant_id, category_id, name, description, price, image_url, active, sort_order, external_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (restaurant_id, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET category_id = EXCLUDED.category_id, name = EXCLUDED.name, description = EXCLUDED.description,
                       price = EXCLUDED.price, image_url = coalesce(EXCLUDED.image_url, menu_items.image_url),
                       active = EXCLUDED.active, sort_order = EXCLUDED.sort_order, updated_at = now()
         RETURNING id`,
        [rid, cid, String(item.name).slice(0, 200), item.description || null, Math.max(0, Number(item.price) || 0),
          imageUrl(link, item.display_image_url), available, itemOrder, String(item.id)],
      );
      const itemId = rows[0].id;
      seenItems.push(String(item.id));

      const linked = [];
      for (const g of item.modifier_groups || []) {
        const shape = groupShape(g);
        let gid = groupIds.get(shape.key);
        if (!gid) {
          const r = await db.query(
            `INSERT INTO modifier_groups (restaurant_id, name, min_selections, max_selections, active, external_id)
             VALUES ($1, $2, $3, $4, true, $5)
             ON CONFLICT (restaurant_id, external_id) WHERE external_id IS NOT NULL
             DO UPDATE SET name = EXCLUDED.name, min_selections = EXCLUDED.min_selections,
                           max_selections = EXCLUDED.max_selections, active = true, updated_at = now()
             RETURNING id`,
            [rid, String(g.modifier_group_name).slice(0, 200), shape.min, shape.max, shape.key],
          );
          gid = r.rows[0].id;
          groupIds.set(shape.key, gid);
          const mods = Array.isArray(g.modifiers) ? g.modifiers : [];
          let modOrder = 0;
          for (const m of mods) {
            modOrder += 1;
            await db.query(
              `INSERT INTO modifiers (restaurant_id, group_id, name, price_delta, sort_order, active, external_id)
               VALUES ($1, $2, $3, $4, $5, true, $6)
               ON CONFLICT (restaurant_id, group_id, external_id) WHERE external_id IS NOT NULL
               DO UPDATE SET name = EXCLUDED.name, price_delta = EXCLUDED.price_delta, sort_order = EXCLUDED.sort_order,
                             active = true, updated_at = now()`,
              [rid, gid, String(m.name).slice(0, 200), Number(m.price_adjustment) || 0, modOrder, String(m.id)],
            );
          }
          await db.query(
            `UPDATE modifiers SET active = false, updated_at = now()
              WHERE restaurant_id = $1 AND group_id = $2 AND external_id IS NOT NULL AND active
                AND NOT (external_id = ANY($3::text[]))`,
            [rid, gid, mods.map((m) => String(m.id))],
          );
        }
        seenGroups.add(shape.key);
        linked.push(gid);
      }
      await db.query(
        `DELETE FROM menu_item_modifier_groups mg USING modifier_groups g
          WHERE mg.menu_item_id = $1 AND mg.restaurant_id = $2 AND g.id = mg.modifier_group_id AND g.external_id IS NOT NULL`,
        [itemId, rid],
      );
      for (let i = 0; i < linked.length; i += 1) {
        await db.query(
          `INSERT INTO menu_item_modifier_groups (restaurant_id, menu_item_id, modifier_group_id, sort_order)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [rid, itemId, linked[i], i + 1],
        );
      }
    }
    await db.query(
      `UPDATE menu_items SET active = false, updated_at = now()
        WHERE restaurant_id = $1 AND external_id IS NOT NULL AND active AND NOT (external_id = ANY($2::text[]))`,
      [rid, seenItems],
    );
    await db.query(
      `UPDATE modifier_groups SET active = false, updated_at = now()
        WHERE restaurant_id = $1 AND external_id IS NOT NULL AND active AND NOT (external_id = ANY($2::text[]))`,
      [rid, [...seenGroups]],
    );
    return { categories: catIds.size, items: seenItems.length, groups: seenGroups.size };
  });
}

export async function syncExternalMenus() {
  const results = [];
  for (const link of await activeLinks()) {
    try {
      const counts = await applyExternalMenu(link, await fetchExternalMenu(link));
      await saveLinkStatus(link, { synced: true });
      results.push({ restaurant_id: link.restaurant_id, ...counts });
    } catch (err) {
      console.error(`[pos externo] menu de ${link.restaurant_id}:`, err.message);
      await saveLinkStatus(link, { error: `Menu: ${err.message}`.slice(0, 500) });
      results.push({ restaurant_id: link.restaurant_id, error: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------

/** Lo que se le manda al POS externo: productos con los ids de alla. */
export async function externalOrderPayload(db, link, m) {
  const items = (await db.query(
    `SELECT i.id, i.quantity, i.notes, i.name, mi.external_id
       FROM order_items i JOIN menu_items mi ON mi.id = i.menu_item_id AND mi.restaurant_id = i.restaurant_id
      WHERE i.order_id = $1 AND i.restaurant_id = $2 AND i.voided_at IS NULL
      ORDER BY i.created_at`,
    [m.order_id, m.restaurant_id],
  )).rows;
  const mods = (await db.query(
    `SELECT x.order_item_id, md.external_id, x.name
       FROM order_item_modifiers x JOIN order_items i ON i.id = x.order_item_id AND i.restaurant_id = x.restaurant_id
       LEFT JOIN modifiers md ON md.id = x.modifier_id AND md.restaurant_id = x.restaurant_id
      WHERE i.order_id = $1 AND i.restaurant_id = $2 AND i.voided_at IS NULL`,
    [m.order_id, m.restaurant_id],
  )).rows;
  const missing = [...items.filter((i) => !i.external_id), ...mods.filter((x) => !x.external_id)].map((x) => x.name);
  if (missing.length) {
    throw new ExternalPosError(`No existen en el POS del restaurante: ${missing.join(', ')}`, { definitive: true, code: 'NOT_LINKED' });
  }
  return {
    branch_id: link.external_branch_id,
    nayo_order_id: m.id,
    folio: m.folio,
    customer_name: m.customer_name,
    customer_phone: m.customer_phone,
    address: m.address,
    reference: m.reference,
    notes: m.notes,
    payment_method: m.payment_method,
    paid: m.payment_method === 'tarjeta',
    pay_with: m.pay_with === null ? null : Number(m.pay_with),
    food_total: Number(m.food_total),
    items: items.map((i) => ({
      menu_item_id: i.external_id,
      quantity: i.quantity,
      notes: i.notes,
      modifiers: mods.filter((x) => x.order_item_id === i.id).map((x) => ({ modifier_id: x.external_id })),
    })),
  };
}

async function rejectOrder(rid, orderId, reason) {
  await withTenant(rid, (db) => db.query(
    `UPDATE orders SET status = 'cancelada', online_status = 'rechazada', cancelled_at = now(),
            cancel_reason = $3, updated_at = now()
      WHERE id = $1 AND restaurant_id = $2 AND status <> 'cancelada'`,
    [orderId, rid, reason.slice(0, 300)],
  ));
}

/** Pedidos de restaurantes conectados que todavia no se mandan a su POS. */
export async function forwardExternalOrders() {
  const pending = await withPlatform(async (db) => (await db.query(
    `SELECT m.*, o.folio, o.notes, k.provider, k.base_url, k.external_branch_id, l.prep_minutes
       FROM marketplace_orders m
       JOIN external_pos_links k ON k.restaurant_id = m.restaurant_id AND k.branch_id = m.branch_id AND k.active
       JOIN orders o ON o.id = m.order_id
       LEFT JOIN marketplace_listings l ON l.branch_id = m.branch_id
      WHERE m.external_order_id IS NULL AND m.status IN ('nuevo', 'aceptado')
        AND m.created_at > now() - interval '6 hours'
      ORDER BY m.created_at LIMIT 20`,
  )).rows);
  const results = [];
  for (const m of pending) {
    const link = { restaurant_id: m.restaurant_id, provider: m.provider, base_url: m.base_url, external_branch_id: m.external_branch_id };
    try {
      const payload = await withTenant(m.restaurant_id, (db) => externalOrderPayload(db, link, m));
      const out = await callExternal(link, '/api/integrations/nayo/orders', { method: 'POST', body: payload });
      await withTenant(m.restaurant_id, async (db) => {
        await db.query(
          `UPDATE marketplace_orders SET external_order_id = $2, external_order_number = $3, external_sent_at = now(),
                  external_error = NULL, updated_at = now() WHERE id = $1`,
          [m.id, String(out.order_id), out.order_number ? String(out.order_number) : null],
        );
        // En efectivo entra 'nuevo': ya esta en la cocina del restaurante, se acepta solo.
        if (m.status === 'nuevo') {
          await acceptOnlineOrder(db, m.restaurant_id, m.order_id, { prepMinutes: m.prep_minutes ?? 25 });
        }
      });
      results.push({ id: m.id, sent: true });
    } catch (err) {
      const attempts = m.external_attempts + 1;
      const giveUp = err.definitive || attempts >= MAX_ATTEMPTS;
      await withTenant(m.restaurant_id, (db) => db.query(
        'UPDATE marketplace_orders SET external_attempts = $2, external_error = $3, updated_at = now() WHERE id = $1',
        [m.id, attempts, err.message.slice(0, 500)],
      ));
      if (giveUp) {
        const reason = err.code === 'STORE_CLOSED' ? 'El restaurante esta cerrado en este momento' : 'El restaurante no pudo recibir el pedido';
        await rejectOrder(m.restaurant_id, m.order_id, reason);
      }
      console.error(`[pos externo] pedido ${m.id} (intento ${attempts}):`, err.message);
      results.push({ id: m.id, sent: false, error: err.message, rejected: giveUp });
    }
  }
  return results;
}

/** Sigue en el POS externo los pedidos ya enviados: listo o cancelado alla. */
export async function pollExternalOrders() {
  const sent = await withPlatform(async (db) => (await db.query(
    `SELECT m.id, m.restaurant_id, m.order_id, m.status, k.provider, k.base_url, k.external_branch_id
       FROM marketplace_orders m
       JOIN external_pos_links k ON k.restaurant_id = m.restaurant_id AND k.branch_id = m.branch_id AND k.active
      WHERE m.external_order_id IS NOT NULL AND m.status = 'aceptado'
        AND m.created_at > now() - interval '12 hours'
      ORDER BY m.created_at LIMIT 50`,
  )).rows);
  const results = [];
  for (const m of sent) {
    const link = { restaurant_id: m.restaurant_id, provider: m.provider, base_url: m.base_url, external_branch_id: m.external_branch_id };
    try {
      const s = await callExternal(link, `/api/integrations/nayo/orders/${encodeURIComponent(m.id)}`);
      if (s.cancelled) {
        await rejectOrder(m.restaurant_id, m.order_id, 'El restaurante cancelo el pedido');
        results.push({ id: m.id, status: 'cancelado' });
      } else if (s.ready) {
        await withTenant(m.restaurant_id, (db) => db.query(
          'UPDATE orders SET ready_at = coalesce(ready_at, now()), updated_at = now() WHERE id = $1 AND restaurant_id = $2',
          [m.order_id, m.restaurant_id],
        ));
        results.push({ id: m.id, status: 'listo' });
      }
    } catch (err) {
      console.error(`[pos externo] estado de ${m.id}:`, err.message);
    }
  }
  return results;
}
