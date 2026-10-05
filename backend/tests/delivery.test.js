// Fase 5 de punta a punta contra Postgres: domicilios con repartidores
// propios y con la flota de la plataforma (modo horom).
//
// Cubre: 402 sin el modulo 'domicilios'; aislamiento (un repartidor de A no
// ve pedidos de B; un repartidor de la flota solo ve lo que tiene asignado;
// un restaurante no ve solicitudes ni ubicaciones de la flota fuera de las
// suyas; API y RLS); estados validos; cobro en la puerta y corte del
// repartidor en centavos; seguimiento del cliente con ubicacion aproximada;
// la flota solo con permiso del Panel; ofertas; comision fija y porcentual,
// liquidaciones y lineas de factura idempotentes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_DOMAIN, SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const DAY = 86400000;

describe('fase 5: domicilios', { skip: SKIP_DB }, () => {
  let ctx; let owner; let subs;
  let A; let B; let C; let D;
  let branchA; let branchB; let branchD;
  let itemA; let itemB; let itemD;
  let cajeroA; let r1; let r2; let rB;
  let f1; let f2; let f1Token; let f2Token;
  // Ordenes y repartos que se reusan entre pruebas.
  let o1; let d1; let reqB1; let reqD1;

  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const panel = (method, path, body) => ctx.request(method, `/api/platform${path}`, { token: owner, body });
  const fleet = (token, method, path, body) => ctx.request(method, `/api/fleet${path}`, { token, body });
  const num = (v) => Number(v);

  async function addUser(who, slug, branch, role, email) {
    const password = 'clave-segura-9';
    const res = await api(who, 'POST', '/api/users', { email, name: `${role} ${email.split('@')[0]}`, role, password, branch_ids: [branch.id] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const login = await ctx.request('POST', '/api/auth/login', { slug, body: { email, password } });
    return { id: res.body.user.id, token: login.body.token, name: res.body.user.name };
  }

  async function menuItem(who, name, price) {
    const cat = (await api(who, 'POST', '/api/pos/categories', { name: 'Comida' })).body.category;
    return (await api(who, 'POST', '/api/pos/items', { category_id: cat.id, name, price })).body.item;
  }

  /** Orden a domicilio del POS ya enviada a cocina. */
  async function deliveryOrder(who, branch, item, quantity = 2, extra = {}) {
    const res = await api(who, 'POST', '/api/pos/orders', {
      branch_id: branch.id, order_type: 'domicilio', customer_name: 'Maria Lopez', customer_phone: '6561234567',
      customer_address: 'Calle Uno 123, Col. Centro, Juarez', items: [{ menu_item_id: item.id, quantity }], ...extra,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const sent = await api(who, 'POST', `/api/pos/orders/${res.body.order.id}/send`);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    return sent.body.order;
  }

  const order = async (who, id) => (await api(who, 'GET', `/api/pos/orders/${id}`)).body.order;

  before(async () => {
    ctx = await setupDb();
    subs = await import('../services/subscriptions.js');
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal', 'domicilios'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos', 'domicilios'] });
    C = await createRestaurant(ctx, owner, 'gamma', { modules: ['pos'] });
    D = await createRestaurant(ctx, owner, 'delta', { modules: ['pos', 'domicilios'] });
    branchA = (await api(A, 'GET', '/api/branches')).body.branches[0];
    branchB = (await api(B, 'GET', '/api/branches')).body.branches[0];
    branchD = (await api(D, 'GET', '/api/branches')).body.branches[0];
    await api(B, 'PATCH', `/api/branches/${branchB.id}`, { address: 'Av. Tecnologico 500', phone: '6560001111' });
    cajeroA = await addUser(A, 'alfa', branchA, 'cajero', 'cajero@alfa.test');
    r1 = await addUser(A, 'alfa', branchA, 'repartidor', 'pedro@alfa.test');
    r2 = await addUser(A, 'alfa', branchA, 'repartidor', 'luis@alfa.test');
    rB = await addUser(B, 'beta', branchB, 'repartidor', 'ana@beta.test');
    itemA = await menuItem(A, 'Rollo California', 115.5);
    itemB = await menuItem(B, 'Pizza', 115.5);
    itemD = await menuItem(D, 'Hamburguesa', 80);
  });
  after(() => ctx?.close());

  // -------------------------------------------------------------------------
  describe('modulo y permisos', () => {
    test('sin el modulo domicilios todas las rutas responden 402', async () => {
      for (const [m, p] of [
        ['GET', '/api/delivery/settings'], ['GET', `/api/delivery/board?branch_id=${branchA.id}`],
        ['POST', `/api/delivery/orders/${branchA.id}/assign`], ['GET', '/api/delivery/driver/deliveries'],
        ['POST', '/api/delivery/driver/location'], ['GET', `/api/delivery/driver-cuts?branch_id=${branchA.id}`],
        ['POST', `/api/delivery/orders/${branchA.id}/request`],
      ]) {
        const res = await api(C, m, p, m === 'GET' ? undefined : {});
        assert.equal(res.status, 402, `${m} ${p}`);
        assert.equal(res.body.code, 'MODULE_NOT_ENABLED');
      }
      assert.equal((await ctx.request('GET', '/api/delivery/settings')).status, 401);
    });

    test('el repartidor solo usa su app; la caja no usa la app del repartidor', async () => {
      assert.equal((await api(r1, 'GET', `/api/delivery/board?branch_id=${branchA.id}`)).status, 403);
      assert.equal((await api(r1, 'GET', `/api/delivery/driver-cuts?branch_id=${branchA.id}`)).status, 403);
      assert.equal((await api(cajeroA, 'GET', '/api/delivery/driver/deliveries')).status, 403);
      const board = await api(cajeroA, 'GET', `/api/delivery/board?branch_id=${branchA.id}`);
      assert.equal(board.status, 200, JSON.stringify(board.body));
      assert.deepEqual(board.body.settings, { mode: 'propio', horom_enabled: false }, 'el cajero no ve condiciones de la flota');
      assert.deepEqual(board.body.drivers.map((d) => d.name).sort(), [r2.name, r1.name].sort());
    });
  });

  // -------------------------------------------------------------------------
  describe('repartidores propios', () => {
    test('la caja asigna; solo repartidores activos de la sucursal', async () => {
      o1 = await deliveryOrder(A, branchA, itemA); // 2 x 115.50 = 231.00
      assert.equal(num(o1.total), 231);
      const bad = await api(cajeroA, 'POST', `/api/delivery/orders/${o1.id}/assign`, { driver_user_id: rB.id });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'DRIVER_NOT_FOUND');
      const notDriver = await api(cajeroA, 'POST', `/api/delivery/orders/${o1.id}/assign`, { driver_user_id: cajeroA.id });
      assert.equal(notDriver.body.code, 'DRIVER_NOT_FOUND');
      // Una orden que no es a domicilio no sale a reparto.
      const llevar = (await api(A, 'POST', '/api/pos/orders', {
        branch_id: branchA.id, order_type: 'para_llevar', items: [{ menu_item_id: itemA.id, quantity: 1 }],
      })).body.order;
      const nd = await api(cajeroA, 'POST', `/api/delivery/orders/${llevar.id}/assign`, { driver_user_id: r1.id });
      assert.equal(nd.body.code, 'NOT_DELIVERY');

      const first = await api(cajeroA, 'POST', `/api/delivery/orders/${o1.id}/assign`, { driver_user_id: r2.id });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      // Cambiar de repartidor antes de que lo recoja.
      const res = await api(cajeroA, 'POST', `/api/delivery/orders/${o1.id}/assign`, { driver_user_id: r1.id });
      assert.equal(res.status, 201);
      d1 = res.body.delivery;
      assert.equal(d1.id, first.body.delivery.id);
      assert.equal(d1.driver_user_id, r1.id);
      assert.equal(num(d1.cash_to_collect), 231);
    });

    test('aislamiento: cada repartidor ve solo lo suyo; otro restaurante no ve nada', async () => {
      const mine = await api(r1, 'GET', '/api/delivery/driver/deliveries');
      assert.equal(mine.status, 200);
      assert.deepEqual(mine.body.deliveries.map((d) => d.id), [d1.id]);
      const dl = mine.body.deliveries[0];
      assert.equal(dl.customer_phone, '6561234567');
      assert.match(dl.maps_url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Calle%20Uno/);
      assert.match(dl.waze_url, /^https:\/\/waze\.com\/ul\?q=Calle%20Uno/);
      assert.deepEqual(dl.items.map((i) => [i.name, i.quantity]), [['Rollo California', 2]]);

      assert.deepEqual((await api(r2, 'GET', '/api/delivery/driver/deliveries')).body.deliveries, []);
      const other = await api(r2, 'POST', `/api/delivery/driver/deliveries/${d1.id}/status`, { status: 'recogido' });
      assert.equal(other.status, 404);
      // Repartidor de B: no ve ni toca pedidos de A, ni con su token en el restaurante de A.
      assert.deepEqual((await api(rB, 'GET', '/api/delivery/driver/deliveries')).body.deliveries, []);
      assert.equal((await api(rB, 'POST', `/api/delivery/driver/deliveries/${d1.id}/status`, { status: 'recogido' })).status, 404);
      const cross = await ctx.request('GET', '/api/delivery/driver/deliveries', { token: rB.token, slug: 'alfa' });
      assert.equal(cross.status, 403);
      assert.equal(cross.body.code, 'TENANT_MISMATCH');
      assert.equal((await api(B, 'POST', `/api/delivery/deliveries/${d1.id}/status`, { status: 'cancelado' })).status, 404);
      // RLS: en el contexto de B no existe ningun reparto de A.
      const rows = await ctx.withTenant(B.id, async (db) => (await db.query('SELECT count(*)::int AS n FROM order_deliveries')).rows[0].n);
      assert.equal(rows, 0);
    });

    test('estados validos y cobro en la puerta con cambio y propina', async () => {
      const skip = await api(r1, 'POST', `/api/delivery/driver/deliveries/${d1.id}/status`, { status: 'entregado' });
      assert.equal(skip.status, 409);
      assert.equal(skip.body.code, 'INVALID_TRANSITION');
      assert.equal((await api(r1, 'POST', `/api/delivery/driver/deliveries/${d1.id}/status`, { status: 'cancelado' })).status, 400,
        'el repartidor no cancela');
      // Un pedido con reparto en curso no se cancela desde la orden.
      const cancel = await api(A, 'POST', `/api/pos/orders/${o1.id}/cancel`, { reason: 'prueba' });
      assert.equal(cancel.status, 409);
      assert.equal(cancel.body.code, 'DELIVERY_IN_PROGRESS');

      assert.equal((await api(r1, 'POST', `/api/delivery/driver/deliveries/${d1.id}/status`, { status: 'recogido' })).status, 200);
      const onWay = await api(r1, 'POST', `/api/delivery/driver/deliveries/${d1.id}/status`, { status: 'en_camino' });
      assert.equal(onWay.body.delivery.status, 'en_camino');
      assert.ok((await order(A, o1.id)).dispatched_at, 'el cliente lo ve en camino');

      const short = await api(r1, 'POST', `/api/delivery/driver/deliveries/${d1.id}/status`, { status: 'entregado', received: 200 });
      assert.equal(short.status, 400);
      assert.equal(short.body.code, 'INSUFFICIENT_CASH');
      // Recibe 300 con 20 de propina: cambio 300 - 231 - 20 = 49.
      const done = await api(r1, 'POST', `/api/delivery/driver/deliveries/${d1.id}/status`, { status: 'entregado', received: 300, tip: 20 });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(done.body.delivery.status, 'entregado');
      assert.equal(num(done.body.delivery.cash_collected), 251);
      const o = await order(A, o1.id);
      assert.equal(o.status, 'pagada');
      assert.equal(num(o.paid_amount), 231);
      assert.equal(num(o.tip_amount), 20);
      assert.equal(o.payments.length, 1);
      assert.deepEqual([o.payments[0].method_kind, num(o.payments[0].received), num(o.payments[0].change_given)], ['efectivo', 300, 49]);
      assert.equal(o.payments[0].cash_session_id, null, 'sin turno hasta el corte');
      const summary = await api(r1, 'GET', '/api/delivery/driver/deliveries');
      assert.equal(num(summary.body.cash_pending), 251);
    });

    test('fallido con motivo regresa el pedido a la caja y se puede reasignar', async () => {
      const o2 = await deliveryOrder(A, branchA, itemA, 1); // 115.50
      const d = (await api(cajeroA, 'POST', `/api/delivery/orders/${o2.id}/assign`, { driver_user_id: r2.id })).body.delivery;
      // "Entregado a repartidor" desde la caja = recogido.
      assert.equal((await api(cajeroA, 'POST', `/api/delivery/deliveries/${d.id}/status`, { status: 'recogido' })).status, 200);
      await api(r2, 'POST', `/api/delivery/driver/deliveries/${d.id}/status`, { status: 'en_camino' });
      const noReason = await api(r2, 'POST', `/api/delivery/driver/deliveries/${d.id}/status`, { status: 'fallido' });
      assert.equal(noReason.body.code, 'REASON_REQUIRED');
      const failed = await api(r2, 'POST', `/api/delivery/driver/deliveries/${d.id}/status`, { status: 'fallido', reason: 'No contesta' });
      assert.equal(failed.body.delivery.status, 'fallido');
      const o = await order(A, o2.id);
      assert.equal(o.status, 'enviada');
      assert.equal(o.dispatched_at, null);
      // Se reasigna y esta vez el repartidor cobra exacto.
      const again = await api(cajeroA, 'POST', `/api/delivery/orders/${o2.id}/assign`, { driver_user_id: r1.id });
      assert.equal(again.status, 201);
      for (const status of ['recogido', 'en_camino', 'entregado']) {
        const res = await api(r1, 'POST', `/api/delivery/driver/deliveries/${again.body.delivery.id}/status`, { status });
        assert.equal(res.status, 200, JSON.stringify(res.body));
      }
      const board = await api(cajeroA, 'GET', `/api/delivery/board?branch_id=${branchA.id}`);
      const row = board.body.orders.find((x) => x.id === o2.id);
      assert.equal(row.stage, 'entregado');
      assert.deepEqual(row.history.map((h) => [h.status, h.fail_reason]), [['fallido', 'No contesta']]);
      assert.equal(num(board.body.drivers.find((x) => x.id === r1.id).cash_pending), 366.5);
    });

    test('corte del repartidor: efectivo contra entregas y entra al turno de caja', async () => {
      const pending = await api(cajeroA, 'GET', `/api/delivery/driver-cuts?branch_id=${branchA.id}`);
      const p1 = pending.body.pending.find((x) => x.driver_user_id === r1.id);
      // 231 + 20 de propina + 115.50 = 366.50
      assert.equal(p1.expected_cash, 366.5);
      assert.equal(p1.deliveries_count, 2);
      assert.equal(pending.body.pending.find((x) => x.driver_user_id === r2.id).expected_cash, 0);

      const noSession = await api(cajeroA, 'POST', '/api/delivery/driver-cuts', {
        branch_id: branchA.id, driver_user_id: r1.id, cash_session_id: branchA.id, counted_cash: 366.5,
      });
      assert.equal(noSession.body.code, 'CASH_SESSION_REQUIRED');
      const session = (await api(cajeroA, 'POST', '/api/pos/cash-sessions/open', { branch_id: branchA.id, opening_cash: 500 })).body.session;
      const cut = await api(cajeroA, 'POST', '/api/delivery/driver-cuts', {
        branch_id: branchA.id, driver_user_id: r1.id, cash_session_id: session.id, counted_cash: '366.40', notes: 'Faltan 10 centavos',
      });
      assert.equal(cut.status, 201, JSON.stringify(cut.body));
      assert.deepEqual([num(cut.body.cut.expected_cash), num(cut.body.cut.counted_cash), num(cut.body.cut.difference)], [366.5, 366.4, -0.1]);
      assert.equal(cut.body.cut.deliveries_count, 2);
      const again = await api(cajeroA, 'POST', '/api/delivery/driver-cuts', {
        branch_id: branchA.id, driver_user_id: r1.id, cash_session_id: session.id, counted_cash: 0,
      });
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'NOTHING_TO_SETTLE');
      // El efectivo del repartidor ya cuenta en el turno: 500 + 346.50 + 20 de propina.
      const s = await api(cajeroA, 'GET', `/api/pos/cash-sessions/${session.id}`);
      assert.equal(s.body.cut.expected_cash, 866.5);
      assert.equal(s.body.cut.total_tips, 20);
      assert.equal(num((await api(r1, 'GET', '/api/delivery/driver/deliveries')).body.cash_pending), 0);
      const history = await api(cajeroA, 'GET', `/api/delivery/driver-cuts?branch_id=${branchA.id}`);
      assert.deepEqual(history.body.cuts.map((c) => [c.driver_name, num(c.difference)]), [[r1.name, -0.1]]);
    });

    test('seguimiento del cliente: estado del reparto y ubicacion aproximada en camino', async () => {
      const hostA = `alfa.${PLATFORM_DOMAIN}`;
      await api(A, 'PUT', `/api/branches/${branchA.id}/hours`, { hours: ALL_DAY });
      await api(A, 'PATCH', '/api/online/settings', { enabled: true });
      const created = await ctx.request('POST', '/api/portal/orders', {
        host: hostA,
        body: {
          branch_id: branchA.id, order_type: 'domicilio', items: [{ menu_item_id: itemA.id, quantity: 1 }],
          customer: { name: 'Invitado', phone: '6569998888' }, address: { address: 'Calle Dos 45, Juarez' },
          payment: { method: 'efectivo', pay_with: 200 },
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const token = created.body.order.token;
      const id = created.body.order.id;
      const notAccepted = await api(cajeroA, 'POST', `/api/delivery/orders/${id}/assign`, { driver_user_id: r1.id });
      assert.equal(notAccepted.body.code, 'ONLINE_ORDER_PENDING');
      await api(cajeroA, 'POST', `/api/pos/online-orders/${id}/accept`, {});
      const d = (await api(cajeroA, 'POST', `/api/delivery/orders/${id}/assign`, { driver_user_id: r1.id })).body.delivery;
      const track = async () => (await ctx.request('GET', `/api/portal/track/${token}`, { host: hostA })).body.order;
      assert.equal((await track()).delivery.status, 'asignado');

      assert.equal((await api(r1, 'POST', '/api/delivery/driver/location', { latitude: 'x', longitude: 1 })).status, 400);
      assert.equal((await api(r1, 'POST', '/api/delivery/driver/duty', { on_duty: true })).status, 200);
      assert.equal((await api(r1, 'POST', '/api/delivery/driver/location', { latitude: 31.738456, longitude: -106.487712, accuracy: 8 })).status, 200);
      await api(r1, 'POST', `/api/delivery/driver/deliveries/${d.id}/status`, { status: 'recogido' });
      let t = await track();
      assert.equal(t.delivery.location, null, 'antes de salir no se muestra la ubicacion');
      await api(r1, 'POST', `/api/delivery/driver/deliveries/${d.id}/status`, { status: 'en_camino' });
      t = await track();
      assert.equal(t.status, 'en_camino');
      assert.equal(t.delivery.status, 'en_camino');
      assert.equal(t.delivery.driver_name, 'repartidor', 'solo el nombre de pila');
      assert.deepEqual([t.delivery.location.latitude, t.delivery.location.longitude], [31.738, -106.488]);
      // El mapa de la caja ve al repartidor en turno.
      const map = await api(cajeroA, 'GET', `/api/delivery/map?branch_id=${branchA.id}`);
      assert.deepEqual(map.body.drivers.map((x) => [x.kind, x.id]), [['propio', r1.id]]);

      await api(r1, 'POST', `/api/delivery/driver/deliveries/${d.id}/status`, { status: 'entregado', received: 200 });
      t = await track();
      assert.equal(t.status, 'entregado');
      assert.equal(t.delivery.location, null);
    });
  });

  // -------------------------------------------------------------------------
  describe('flota de la plataforma', () => {
    test('la flota solo con permiso del Panel; el restaurante no se la habilita solo', async () => {
      const o = await deliveryOrder(A, branchA, itemA, 1);
      const req = await api(A, 'POST', `/api/delivery/orders/${o.id}/request`, {});
      assert.equal(req.status, 403);
      assert.equal(req.body.code, 'HOROM_NOT_ENABLED');
      const mode = await api(A, 'PUT', '/api/delivery/settings', { mode: 'horom' });
      assert.equal(mode.status, 403);
      assert.equal(mode.body.code, 'HOROM_NOT_ENABLED');
      assert.equal((await api(cajeroA, 'PUT', '/api/delivery/settings', { mode: 'propio' })).status, 403, 'solo admin');
      // Ni por SQL con el contexto del restaurante (trigger + CHECK).
      await assert.rejects(ctx.withTenant(A.id, (db) => db.query('UPDATE delivery_settings SET horom_enabled = true')), /NeuronPOS/);
      await assert.rejects(ctx.withTenant(A.id, (db) => db.query("UPDATE delivery_settings SET mode = 'horom'")), /check constraint/);
      await assert.rejects(ctx.withTenant(A.id, (db) => db.query(
        `INSERT INTO delivery_requests (restaurant_id, branch_id, order_id, restaurant_name, order_folio, pickup_name,
                                        customer_name, dropoff_address, order_subtotal, order_total, commission_type, commission_value)
         VALUES ($1, $2, $3, 'x', 1, 'x', 'x', 'x', 100, 100, 'fixed', 0)`,
        [A.id, branchA.id, o.id],
      )), /servicio de repartidores/);

      // B: el Panel la habilita con 10 % y el restaurante elige el modo.
      const en = await panel('PUT', `/restaurants/${B.id}/delivery`, { horom_enabled: true, horom_fee_type: 'percent', horom_fee_value: 10 });
      assert.equal(en.status, 200, JSON.stringify(en.body));
      assert.equal(en.body.delivery.mode, 'propio');
      const set = await api(B, 'PUT', '/api/delivery/settings', { mode: 'horom' });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      assert.equal(set.body.settings.mode, 'horom');
      const view = await api(B, 'GET', '/api/delivery/settings');
      assert.deepEqual([view.body.settings.horom_fee_type, num(view.body.settings.horom_fee_value)], ['percent', 10]);
      await assert.rejects(ctx.withTenant(B.id, (db) => db.query('UPDATE delivery_settings SET horom_fee_value = 0')), /NeuronPOS/);
      // D: el Panel elige el modo directamente (y con eso la habilita), comision fija.
      const dd = await panel('PUT', `/restaurants/${D.id}/delivery`, { mode: 'horom', horom_fee_type: 'fixed', horom_fee_value: 25 });
      assert.deepEqual([dd.body.delivery.mode, dd.body.delivery.horom_enabled], ['horom', true]);
      // En modo flota no se asignan repartidores propios.
      const ob = await deliveryOrder(B, branchB, itemB, 1);
      const own = await api(B, 'POST', `/api/delivery/orders/${ob.id}/assign`, { driver_user_id: rB.id });
      assert.equal(own.body.code, 'MODE_HOROM');
      await api(B, 'POST', `/api/pos/orders/${ob.id}/cancel`, { reason: 'prueba' });
    });

    test('el Panel da de alta repartidores de la flota con login propio', async () => {
      assert.equal((await panel('PUT', '/fleet/settings', { driver_pay_per_delivery: 40 })).status, 200);
      const bad = await panel('POST', '/fleet/drivers', { name: 'X', phone: '1', email: 'x@flota.test', password: 'corta' });
      assert.equal(bad.body.code, 'WEAK_PASSWORD');
      const c1 = await panel('POST', '/fleet/drivers', {
        name: 'Juan Perez', phone: '6561110000', email: 'juan@flota.test', password: 'flota-segura-1', vehicle: 'Moto',
      });
      assert.equal(c1.status, 201, JSON.stringify(c1.body));
      assert.equal(c1.body.driver.password_hash, undefined);
      f1 = c1.body.driver;
      f2 = (await panel('POST', '/fleet/drivers', {
        name: 'Rosa Diaz', phone: '6562220000', email: 'rosa@flota.test', password: 'flota-segura-2', pay_per_delivery: 45.5,
      })).body.driver;
      const wrong = await ctx.request('POST', '/api/fleet/auth/login', { body: { email: 'juan@flota.test', password: 'nop' } });
      assert.equal(wrong.status, 401);
      f1Token = (await ctx.request('POST', '/api/fleet/auth/login', { body: { email: 'juan@flota.test', password: 'flota-segura-1' } })).body.token;
      f2Token = (await ctx.request('POST', '/api/fleet/auth/login', { body: { email: 'rosa@flota.test', password: 'flota-segura-2' } })).body.token;
      assert.ok(f1Token && f2Token);
      // Audiencias separadas: el token de la flota no sirve en el restaurante ni en el Panel, ni al reves.
      assert.equal((await ctx.request('GET', '/api/delivery/settings', { token: f1Token, slug: 'beta' })).status, 401);
      assert.equal((await ctx.request('GET', '/api/platform/fleet/drivers', { token: f1Token })).status, 401);
      assert.equal((await fleet(B.token, 'GET', '/requests')).status, 401);
      assert.equal((await fleet(owner, 'GET', '/requests')).status, 401);
      assert.equal((await fleet(rB.token, 'GET', '/requests')).status, 401);
    });

    test('solicitudes: copia minima, el repartidor ve solo lo suyo y el restaurante solo lo propio', async () => {
      const ob = await deliveryOrder(B, branchB, itemB, 2); // 231.00 -> comision 10 % = 23.10
      const res = await api(B, 'POST', `/api/delivery/orders/${ob.id}/request`, { notes: 'Tocar el timbre' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      reqB1 = res.body.request;
      assert.deepEqual([reqB1.status, num(reqB1.commission_amount), num(reqB1.cash_to_collect)], ['solicitado', 23.1, 231]);
      assert.deepEqual([reqB1.pickup_name, reqB1.pickup_address, reqB1.restaurant_name], [branchB.name, 'Av. Tecnologico 500', 'Restaurante BETA']);
      const dup = await api(B, 'POST', `/api/delivery/orders/${ob.id}/request`, {});
      assert.equal(dup.body.code, 'DELIVERY_EXISTS');
      const od = await deliveryOrder(D, branchD, itemD, 1); // 80.00 -> comision fija 25
      reqD1 = (await api(D, 'POST', `/api/delivery/orders/${od.id}/request`, {})).body.request;
      assert.equal(num(reqD1.commission_amount), 25);

      // Sin asignar, el repartidor no ve nada.
      assert.deepEqual((await fleet(f1Token, 'GET', '/requests')).body.requests, []);
      const board = await panel('GET', '/fleet/requests');
      assert.deepEqual(board.body.requests.map((r) => r.id).sort(), [reqB1.id, reqD1.id].sort());
      assert.equal((await panel('POST', `/fleet/requests/${reqB1.id}/assign`, { driver_id: f1.id })).status, 200);
      assert.equal((await panel('POST', `/fleet/requests/${reqD1.id}/assign`, { driver_id: f2.id })).status, 200);

      const mine = await fleet(f1Token, 'GET', '/requests');
      assert.deepEqual(mine.body.requests.map((r) => r.id), [reqB1.id]);
      assert.equal(mine.body.requests[0].customer_phone, '6561234567');
      assert.equal(mine.body.requests[0].commission_amount, undefined, 'el repartidor no ve la comision');
      const other = await fleet(f1Token, 'POST', `/requests/${reqD1.id}/status`, { status: 'recogido' });
      assert.equal(other.status, 404);
      // RLS en el contexto del repartidor: ninguna tabla de restaurantes.
      const seen = await ctx.pool.connect();
      try {
        await seen.query('BEGIN');
        await seen.query("SELECT set_config('app.fleet_driver_id', $1, true)", [f1.id]);
        const q = async (sql) => (await seen.query(sql)).rows[0].n;
        assert.equal(await q('SELECT count(*)::int AS n FROM delivery_requests'), 1);
        assert.equal(await q('SELECT count(*)::int AS n FROM orders'), 0);
        assert.equal(await q('SELECT count(*)::int AS n FROM customers'), 0);
        assert.equal(await q('SELECT count(*)::int AS n FROM fleet_drivers'), 1);
        assert.equal(await q('SELECT count(*)::int AS n FROM fleet_settlements'), 0);
        await assert.rejects(seen.query('UPDATE delivery_requests SET commission_amount = 0'), /NeuronPOS/);
      } finally {
        await seen.query('ROLLBACK');
        seen.release();
      }
      // El restaurante solo ve sus solicitudes (API y RLS) y no las cancela si no son suyas.
      const bBoard = await api(B, 'GET', `/api/delivery/board?branch_id=${branchB.id}`);
      const bRow = bBoard.body.orders.find((x) => x.id === ob.id);
      assert.deepEqual([bRow.delivery.kind, bRow.delivery.status, bRow.delivery.driver_name], ['horom', 'asignado', 'Juan Perez']);
      const nB = await ctx.withTenant(B.id, async (db) => (await db.query('SELECT count(*)::int AS n FROM delivery_requests')).rows[0].n);
      assert.equal(nB, 1);
      assert.equal((await api(B, 'POST', `/api/delivery/requests/${reqD1.id}/cancel`, {})).status, 404);
      assert.equal((await api(A, 'POST', `/api/delivery/requests/${reqB1.id}/cancel`, {})).status, 404);
      // Tampoco cambia el repartidor por SQL.
      await assert.rejects(ctx.withTenant(B.id, (db) => db.query('UPDATE delivery_requests SET driver_id = $1', [f2.id])), /NeuronPOS/);
    });

    test('ubicacion de la flota: el restaurante solo ve a quien lleva un pedido suyo', async () => {
      await fleet(f1Token, 'POST', '/duty', { on_duty: true });
      await fleet(f2Token, 'POST', '/duty', { on_duty: true });
      assert.equal((await fleet(f1Token, 'POST', '/location', { latitude: 31.7, longitude: -106.4 })).status, 200);
      assert.equal((await fleet(f2Token, 'POST', '/location', { latitude: 31.6, longitude: -106.3 })).status, 200);
      const mapB = await api(B, 'GET', `/api/delivery/map?branch_id=${branchB.id}`);
      assert.deepEqual(mapB.body.drivers.map((x) => [x.kind, x.id]), [['horom', f1.id]]);
      const mapA = await api(cajeroA, 'GET', `/api/delivery/map?branch_id=${branchA.id}`);
      assert.ok(mapA.body.drivers.every((x) => x.kind === 'propio'));
      const locsB = await ctx.withTenant(B.id, async (db) => (await db.query('SELECT driver_id FROM fleet_driver_locations')).rows);
      assert.deepEqual(locsB.map((r) => r.driver_id), [f1.id]);
      const locsA = await ctx.withTenant(A.id, async (db) => (await db.query('SELECT driver_id FROM fleet_driver_locations')).rows);
      assert.deepEqual(locsA, []);
      const panelMap = await panel('GET', '/fleet/map');
      assert.deepEqual(panelMap.body.drivers.map((x) => x.id).sort(), [f1.id, f2.id].sort());
    });

    test('estados de la flota se reflejan en la orden; al entregar cobra y la orden queda pagada', async () => {
      const skip = await fleet(f1Token, 'POST', `/requests/${reqB1.id}/status`, { status: 'entregado' });
      assert.equal(skip.body.code, 'INVALID_TRANSITION');
      await fleet(f1Token, 'POST', `/requests/${reqB1.id}/status`, { status: 'recogido' });
      // Ya recogido el restaurante no la cancela.
      assert.equal((await api(B, 'POST', `/api/delivery/requests/${reqB1.id}/cancel`, {})).body.code, 'INVALID_TRANSITION');
      await fleet(f1Token, 'POST', `/requests/${reqB1.id}/status`, { status: 'en_camino' });
      assert.ok((await order(B, reqB1.order_id)).dispatched_at);
      const done = await fleet(f1Token, 'POST', `/requests/${reqB1.id}/status`, { status: 'entregado' });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual([num(done.body.request.cash_collected), num(done.body.request.driver_pay)], [231, 40]);
      const o = await order(B, reqB1.order_id);
      assert.equal(o.status, 'pagada');
      assert.deepEqual(o.payments.map((p) => [p.method_kind, num(p.amount), p.cash_session_id]), [['efectivo', 231, null]]);
      // Ya entregada, B deja de ver la ubicacion de ese repartidor.
      const locs = await ctx.withTenant(B.id, async (db) => (await db.query('SELECT driver_id FROM fleet_driver_locations')).rows);
      assert.deepEqual(locs, []);

      // D: no se entrega -> sin comision.
      await fleet(f2Token, 'POST', `/requests/${reqD1.id}/status`, { status: 'recogido' });
      const fail = await fleet(f2Token, 'POST', `/requests/${reqD1.id}/status`, { status: 'fallido', reason: 'Domicilio cerrado' });
      assert.equal(fail.body.request.status, 'fallido');
      const od = await order(D, reqD1.order_id);
      assert.deepEqual([od.status, od.dispatched_at, od.payments.length], ['enviada', null, 0]);
    });

    test('ofertas automaticas: el primero que acepta se lo lleva', async () => {
      await panel('PUT', '/fleet/settings', { auto_offer: true, offer_seconds: 60 });
      const ob = await deliveryOrder(B, branchB, itemB, 1); // 115.50 -> 11.55
      // Pagado en caja antes de salir: el repartidor no cobra nada.
      const session = (await api(B, 'POST', '/api/pos/cash-sessions/open', { branch_id: branchB.id })).body.session;
      const methods = (await api(B, 'GET', '/api/pos/payment-methods')).body.payment_methods;
      const card = methods.find((m) => m.kind === 'tarjeta').id;
      const paid = await api(B, 'POST', `/api/pos/orders/${ob.id}/payments`, {
        cash_session_id: session.id, payments: [{ payment_method_id: card, amount: 115.5 }],
      });
      assert.equal(paid.body.order.status, 'pagada');
      const req = (await api(B, 'POST', `/api/delivery/orders/${ob.id}/request`, {})).body.request;
      assert.deepEqual([num(req.cash_to_collect), num(req.commission_amount)], [0, 11.55]);

      const o1f = (await fleet(f1Token, 'GET', '/offers')).body.offers;
      const o2f = (await fleet(f2Token, 'GET', '/offers')).body.offers;
      assert.equal(o1f.length, 1);
      assert.equal(o2f.length, 1);
      assert.equal(o1f[0].summary.restaurant_name, 'Restaurante BETA');
      assert.equal(o1f[0].summary.customer_phone, undefined, 'la oferta no lleva datos del cliente');
      // Un repartidor no acepta la oferta de otro.
      assert.equal((await fleet(f1Token, 'POST', `/offers/${o2f[0].id}/accept`)).status, 404);
      const win = await fleet(f2Token, 'POST', `/offers/${o2f[0].id}/accept`);
      assert.equal(win.status, 200, JSON.stringify(win.body));
      assert.equal(win.body.request.status, 'asignado');
      const late = await fleet(f1Token, 'POST', `/offers/${o1f[0].id}/accept`);
      assert.equal(late.status, 409);
      for (const status of ['recogido', 'en_camino', 'entregado']) {
        const r = await fleet(f2Token, 'POST', `/requests/${req.id}/status`, { status });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      const r = (await panel('GET', '/fleet/requests?status=entregado')).body.requests.find((x) => x.id === req.id);
      assert.deepEqual([num(r.cash_collected), num(r.driver_pay)], [0, 45.5]);
      await panel('PUT', '/fleet/settings', { auto_offer: false });
    });

    test('liquidacion: efectivo menos comisiones; lo que no cabe se factura', async () => {
      const ledger = (await panel('GET', '/fleet/ledger')).body.restaurants;
      const b = ledger.find((x) => x.id === B.id);
      // Efectivo 231.00; comisiones 23.10 + 11.55 = 34.65 -> neto 196.35.
      assert.deepEqual([b.cash_pending, b.commission_pending, b.payout_now], [231, 34.65, 196.35]);
      const d = ledger.find((x) => x.id === D.id);
      assert.deepEqual([d.cash_pending, d.commission_pending], [0, 0], 'la entrega fallida no cobra comision');

      const s = await panel('POST', '/fleet/settlements', { restaurant_id: B.id, method: 'transferencia', reference: 'SPEI-1' });
      assert.equal(s.status, 201, JSON.stringify(s.body));
      assert.deepEqual([num(s.body.settlement.cash_amount), num(s.body.settlement.commission_amount), num(s.body.settlement.net_amount)],
        [231, 34.65, 196.35]);
      assert.equal(s.body.settlement.deliveries_count, 2);
      assert.equal((await panel('POST', '/fleet/settlements', { restaurant_id: B.id })).body.code, 'NOTHING_TO_SETTLE');
      // El restaurante ve su liquidacion; otro restaurante no.
      const mine = await api(B, 'GET', '/api/delivery/horom/ledger');
      assert.deepEqual(mine.body.settlements.map((x) => num(x.net_amount)), [196.35]);
      assert.equal(mine.body.summary.cash_pending, 0);
      assert.deepEqual((await api(D, 'GET', '/api/delivery/horom/ledger')).body.settlements, []);
    });

    test('corte de efectivo del repartidor de la flota y reporte de pagos', async () => {
      const cash = await panel('GET', `/fleet/drivers/${f1.id}/cash`);
      assert.equal(cash.body.expected_cash, 231);
      const cut = await panel('POST', `/fleet/drivers/${f1.id}/cuts`, { counted_cash: 231 });
      assert.equal(cut.status, 201);
      assert.deepEqual([num(cut.body.cut.expected_cash), num(cut.body.cut.difference)], [231, 0]);
      assert.equal((await panel('POST', `/fleet/drivers/${f2.id}/cuts`, { counted_cash: 0 })).body.code, 'NOTHING_TO_SETTLE');
      const me = await fleet(f1Token, 'GET', '/me');
      assert.equal(num(me.body.cash_pending), 0);

      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
      const report = await panel('GET', `/fleet/report?from=${today}&to=${today}`);
      assert.equal(report.status, 200, JSON.stringify(report.body));
      const byName = Object.fromEntries(report.body.drivers.map((x) => [x.name, x]));
      assert.deepEqual([byName['Juan Perez'].deliveries, num(byName['Juan Perez'].driver_pay)], [1, 40]);
      assert.deepEqual([byName['Rosa Diaz'].deliveries, num(byName['Rosa Diaz'].driver_pay), byName['Rosa Diaz'].failed], [1, 45.5, 1]);
      assert.deepEqual(report.body.totals, { deliveries: 2, driver_pay: 85.5, cash_collected: 231, commission: 34.65 });
    });

    test('comisiones en la factura mensual: una linea, una sola vez', async () => {
      const finish = async (who, branch, item, qty, driverToken, driverId) => {
        const o = await deliveryOrder(who, branch, item, qty);
        const r = (await api(who, 'POST', `/api/delivery/orders/${o.id}/request`, {})).body.request;
        await panel('POST', `/fleet/requests/${r.id}/assign`, { driver_id: driverId });
        for (const status of ['recogido', 'en_camino', 'entregado']) await fleet(driverToken, 'POST', `/requests/${r.id}/status`, { status });
        return r;
      };
      // D (comision fija de 25): las comisiones se facturan antes de liquidar el efectivo.
      const r1d = await finish(D, branchD, itemD, 1, f1Token, f1.id);
      const r2d = await finish(D, branchD, itemD, 3, f2Token, f2.id);
      // Comision corregida por el Panel antes de facturar.
      const fix = await panel('PATCH', `/fleet/requests/${r2d.id}`, { commission_amount: 30.4 });
      assert.equal(num(fix.body.request.commission_amount), 30.4);

      const restaurant = await ctx.withPlatform(async (db) => (await db.query('SELECT * FROM restaurants WHERE id = $1', [D.id])).rows[0]);
      const gen = (now) => ctx.withPlatform((db) => subs.generateInvoice(db, restaurant, { now }));
      const items = async (invoiceId) => ctx.withPlatform(async (db) => (await db.query(
        'SELECT module_code, name, amount_mxn FROM subscription_invoice_items WHERE invoice_id = $1 ORDER BY sort_order', [invoiceId],
      )).rows);

      const first = await gen(new Date());
      assert.equal(first.created, true);
      const lines = await items(first.id);
      const horom = lines.find((l) => l.module_code === 'domicilios_horom');
      assert.equal(horom.name, 'Domicilios Horom (2 entregas)');
      assert.equal(num(horom.amount_mxn), 55.4);
      // Otra vez: misma factura, ninguna linea nueva.
      const again = await gen(new Date());
      assert.deepEqual([again.id, again.created], [first.id, false]);
      assert.deepEqual(await items(first.id), lines);
      // Ya facturadas: no se pueden corregir ni entran a una liquidacion.
      assert.equal((await panel('PATCH', `/fleet/requests/${r1d.id}`, { commission_amount: 1 })).body.code, 'COMMISSION_BILLED');
      const ledgerD = (await panel('GET', `/fleet/ledger/${D.id}`)).body.ledger;
      assert.equal(ledgerD.commission_pending, 0);
      assert.equal(ledgerD.cash_pending, 320, 'el efectivo (80 + 240) sigue pendiente de liquidar');
      // La liquidacion de D entrega el efectivo completo (las comisiones ya se facturaron).
      const s = await panel('POST', '/fleet/settlements', { restaurant_id: D.id });
      assert.deepEqual([num(s.body.settlement.cash_amount), num(s.body.settlement.commission_amount)], [320, 0]);

      // Una entrega nueva va a la factura del siguiente periodo.
      await finish(D, branchD, itemD, 1, f1Token, f1.id);
      const next = await gen(new Date(Date.now() + 35 * DAY));
      assert.equal(next.created, true);
      const nextLines = await items(next.id);
      assert.deepEqual(nextLines.filter((l) => l.module_code === 'domicilios_horom').map((l) => [l.name, num(l.amount_mxn)]),
        [['Domicilios Horom (1 entrega)', 25]]);
      assert.deepEqual(await items(first.id), lines);
      // El restaurante ve la linea en su factura (y solo la suya).
      const invD = await api(D, 'GET', '/api/subscription');
      assert.equal(invD.status, 200);
      const nB = await ctx.withTenant(B.id, async (db) => (await db.query(
        "SELECT count(*)::int AS n FROM subscription_invoice_items WHERE module_code = 'domicilios_horom'",
      )).rows[0].n);
      assert.equal(nB, 0);
    });

    test('el Panel deshabilita la flota: el restaurante regresa a repartidores propios', async () => {
      const bad = await panel('PUT', `/restaurants/${D.id}/delivery`, { mode: 'horom', horom_enabled: false });
      assert.equal(bad.status, 400);
      const off = await panel('PUT', `/restaurants/${D.id}/delivery`, { horom_enabled: false });
      assert.deepEqual([off.body.delivery.mode, off.body.delivery.horom_enabled], ['propio', false]);
      const o = await deliveryOrder(D, branchD, itemD, 1);
      assert.equal((await api(D, 'POST', `/api/delivery/orders/${o.id}/request`, {})).body.code, 'HOROM_NOT_ENABLED');
      assert.equal((await api(D, 'PUT', '/api/delivery/settings', { mode: 'horom' })).body.code, 'HOROM_NOT_ENABLED');
    });
  });
});
