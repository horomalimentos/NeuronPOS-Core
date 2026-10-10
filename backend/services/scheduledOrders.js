// Job de pedidos programados (ver services/scheduling.js y la migracion 017).
import { withPlatform } from '../config/database.js';

/**
 * Job: los pedidos programados ya aceptados entran a cocina
 * schedule_kitchen_minutes antes de su hora. Regresa cuantos.
 */
export async function releaseScheduledOrders() {
  return withPlatform(async (db) => {
    const { rows } = await db.query(
      `SELECT o.id, o.restaurant_id FROM orders o
         JOIN online_settings s ON s.restaurant_id = o.restaurant_id
        WHERE o.scheduled_for IS NOT NULL AND o.sent_at IS NULL AND o.status = 'abierta'
          AND o.online_status = 'aceptada'
          AND o.scheduled_for - make_interval(mins => s.schedule_kitchen_minutes) <= now()
        ORDER BY o.scheduled_for LIMIT 200
        FOR UPDATE OF o SKIP LOCKED`,
    );
    for (const o of rows) {
      await db.query(
        `UPDATE order_items SET sent_at = now()
          WHERE order_id = $1 AND restaurant_id = $2 AND sent_at IS NULL AND voided_at IS NULL`,
        [o.id, o.restaurant_id],
      );
      await db.query(
        `UPDATE orders SET status = 'enviada', sent_at = now(), updated_at = now()
          WHERE id = $1 AND restaurant_id = $2`,
        [o.id, o.restaurant_id],
      );
    }
    return rows.length;
  });
}
