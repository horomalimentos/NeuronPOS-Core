// Nayo Partner: numeros del restaurante en Nayo (ventas, pedidos, horas
// conectado) y el registro de minutos conectado (migracion 063).
//
// "Conectado" = la pantalla de pedidos (app Nayo Restaurante o Partner) esta
// abierta y manda su latido cada minuto, con la ficha publicada, aprobada,
// sin bloqueo ni pausa. Un minuto cuenta una sola vez por sucursal.

export const STATS_DAYS = [1, 7, 30];

/**
 * Guarda el minuto actual para las sucursales del restaurante que en este
 * momento reciben pedidos (o solo branchId). Regresa cuantas quedaron conectadas.
 */
export async function recordOnlineMinute(db, rid, branchId = null) {
  const { rowCount } = await db.query(
    `INSERT INTO nayo_online_minutes (restaurant_id, branch_id, minute)
     SELECT l.restaurant_id, l.branch_id, date_trunc('minute', now())
       FROM marketplace_listings l
       JOIN branches b ON b.restaurant_id = l.restaurant_id AND b.id = l.branch_id
      WHERE l.restaurant_id = $1 AND ($2::uuid IS NULL OR l.branch_id = $2)
        AND l.published AND l.approval_status = 'aprobado' AND NOT l.blocked AND b.active
        AND (l.paused_until IS NULL OR l.paused_until <= now())
     ON CONFLICT DO NOTHING`,
    [rid, branchId],
  );
  return rowCount;
}

const n = (v) => Number(v || 0);
const round2 = (v) => Math.round(v * 100) / 100;

/** Minutos de horario de un dia (YYYY-MM-DD) segun branch_hours de las sucursales. */
function scheduledMinutes(hours, day) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return hours.filter((h) => h.weekday === weekday).reduce((sum, h) => {
    const [oh, om] = h.opens_at.split(':').map(Number);
    const [ch, cm] = h.closes_at.split(':').map(Number);
    let mins = ch * 60 + cm - (oh * 60 + om);
    if (mins <= 0) mins += 24 * 60; // cierra despues de medianoche
    return sum + mins;
  }, 0);
}

/**
 * Resumen del periodo (hoy, 7 o 30 dias, en la zona horaria de la sucursal)
 * y del periodo anterior del mismo largo, para comparar.
 */
export async function readPartnerStats(db, rid, { days = 7, branchId = null } = {}) {
  const range = (await db.query(
    `SELECT tz,
            (local_today - make_interval(days => $2 - 1)) AT TIME ZONE tz AS start_at,
            (local_today - make_interval(days => 2 * $2 - 1)) AT TIME ZONE tz AS prev_start_at,
            to_char(local_today - make_interval(days => $2 - 1), 'YYYY-MM-DD') AS first_day,
            to_char(local_today, 'YYYY-MM-DD') AS last_day
       FROM (SELECT timezone AS tz, date_trunc('day', now() AT TIME ZONE timezone) AS local_today
               FROM branches WHERE restaurant_id = $1 AND ($3::uuid IS NULL OR id = $3)
              ORDER BY (id = $3) DESC NULLS LAST, created_at LIMIT 1) r`,
    [rid, days, branchId],
  )).rows[0];
  if (!range) return emptyStats(days);
  const { tz } = range;
  // $1 restaurante, $2 sucursal (o todas), $3 desde.
  const scope = 'm.restaurant_id = $1 AND ($2::uuid IS NULL OR m.branch_id = $2)';
  const since = [rid, branchId, range.start_at];
  const local = [...since, tz]; // $4 zona horaria

  // $4 hasta (null = ahora).
  const totalsSql = `
    SELECT count(*)::int AS orders,
           count(*) FILTER (WHERE m.status = 'entregado')::int AS delivered,
           count(*) FILTER (WHERE m.status IN ('rechazado', 'cancelado'))::int AS lost,
           count(*) FILTER (WHERE m.accepted_at IS NOT NULL)::int AS accepted,
           coalesce(sum(m.food_total) FILTER (WHERE m.status = 'entregado'), 0) AS sales,
           avg(extract(epoch FROM m.accepted_at - m.created_at)) AS accept_seconds,
           avg(extract(epoch FROM m.ready_at - m.accepted_at)) AS prep_seconds
      FROM marketplace_orders m
     WHERE ${scope} AND m.created_at >= $3 AND ($4::timestamptz IS NULL OR m.created_at < $4)`;

  const [current, previous, daily, hourly, top, online, prevOnline, hours] = await Promise.all([
    db.query(totalsSql, [...since, null]),
    db.query(totalsSql, [rid, branchId, range.prev_start_at, range.start_at]),
    db.query(
      `SELECT to_char(m.created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day,
              count(*)::int AS orders,
              coalesce(sum(m.food_total) FILTER (WHERE m.status = 'entregado'), 0) AS sales
         FROM marketplace_orders m
        WHERE ${scope} AND m.created_at >= $3
        GROUP BY 1`,
      local,
    ),
    db.query(
      `SELECT extract(hour FROM m.created_at AT TIME ZONE $4)::int AS hour, count(*)::int AS orders
         FROM marketplace_orders m
        WHERE ${scope} AND m.created_at >= $3
        GROUP BY 1`,
      local,
    ),
    db.query(
      `SELECT i.name, sum(i.quantity)::int AS quantity, sum(i.line_total) AS total
         FROM marketplace_orders m
         JOIN order_items i ON i.restaurant_id = m.restaurant_id AND i.order_id = m.order_id AND i.voided_at IS NULL
        WHERE ${scope} AND m.status = 'entregado' AND m.created_at >= $3
        GROUP BY i.name ORDER BY 2 DESC, 3 DESC LIMIT 5`,
      since,
    ),
    db.query(
      `SELECT to_char(m.minute AT TIME ZONE $4, 'YYYY-MM-DD') AS day, count(*)::int AS minutes
         FROM nayo_online_minutes m
        WHERE ${scope} AND m.minute >= $3
        GROUP BY 1`,
      local,
    ),
    db.query(
      `SELECT count(*)::int AS minutes FROM nayo_online_minutes m
        WHERE ${scope} AND m.minute >= $3 AND m.minute < $4`,
      [rid, branchId, range.prev_start_at, range.start_at],
    ),
    // Horario de las sucursales que estan en Nayo (o de la elegida).
    db.query(
      `SELECT h.weekday, to_char(h.opens_at, 'HH24:MI') AS opens_at, to_char(h.closes_at, 'HH24:MI') AS closes_at
         FROM branch_hours h
         JOIN marketplace_listings l ON l.branch_id = h.branch_id AND l.restaurant_id = h.restaurant_id
        WHERE h.restaurant_id = $1 AND ($2::uuid IS NULL OR h.branch_id = $2) AND l.published`,
      [rid, branchId],
    ),
  ]);

  const totals = (r, onlineMinutes) => {
    const t = r.rows[0];
    return {
      orders: t.orders,
      delivered: t.delivered,
      lost: t.lost,
      sales: round2(n(t.sales)),
      avg_ticket: t.delivered ? round2(n(t.sales) / t.delivered) : 0,
      acceptance_pct: t.orders ? Math.round((t.accepted / t.orders) * 100) : null,
      accept_minutes: t.accept_seconds === null ? null : round2(n(t.accept_seconds) / 60),
      prep_minutes: t.prep_seconds === null ? null : round2(n(t.prep_seconds) / 60),
      online_hours: round2(onlineMinutes / 60),
    };
  };

  // Un renglon por dia del periodo, aunque no haya pedidos.
  const byDay = new Map(daily.rows.map((r) => [r.day, r]));
  const onlineByDay = new Map(online.rows.map((r) => [r.day, r.minutes]));
  const series = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(`${range.first_day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10);
    series.push({
      day,
      orders: byDay.get(day)?.orders || 0,
      sales: round2(n(byDay.get(day)?.sales)),
      online_hours: round2((onlineByDay.get(day) || 0) / 60),
      scheduled_hours: round2(scheduledMinutes(hours.rows, day) / 60),
    });
  }
  const perHour = Array.from({ length: 24 }, (_, hour) => ({
    hour, orders: hourly.rows.find((r) => r.hour === hour)?.orders || 0,
  }));
  const onlineMinutes = online.rows.reduce((s, r) => s + r.minutes, 0);

  return {
    days,
    timezone: tz,
    from: range.first_day,
    to: range.last_day,
    current: totals(current, onlineMinutes),
    previous: totals(previous, prevOnline.rows[0].minutes),
    scheduled_hours: round2(series.reduce((s, d) => s + d.scheduled_hours, 0)),
    daily: series,
    hourly: perHour,
    top_products: top.rows.map((r) => ({ name: r.name, quantity: r.quantity, total: round2(n(r.total)) })),
  };
}

/** Sin sucursal (otra sucursal o ninguna): todo en cero. */
function emptyStats(days) {
  const zero = { orders: 0, delivered: 0, lost: 0, sales: 0, avg_ticket: 0, acceptance_pct: null, accept_minutes: null, prep_minutes: null, online_hours: 0 };
  return { days, timezone: null, from: null, to: null, current: zero, previous: zero, scheduled_hours: 0, daily: [], hourly: [], top_products: [] };
}
