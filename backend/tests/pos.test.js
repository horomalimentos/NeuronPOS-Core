// POS de punta a punta contra Postgres: aislamiento de menu, mesas, ordenes y
// caja entre restaurantes; requireModule en las rutas del POS; totales,
// descuentos por rol, pagos divididos y corte de caja.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('punto de venta', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let C;
  let branchA; let branchB;
  let catA; let tacoA; let aguaA; let salsasA; let extrasA; let mesa1; let mesa2;
  let methodsA; let cajero; let mesero; let cocina;

  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const byKind = (kind) => methodsA.find((m) => m.kind === kind).id;

  async function addUser(role, email) {
    const password = 'clave-segura-9';
    const res = await api(A, 'POST', '/api/users', { email, name: role, role, password, branch_ids: [branchA.id] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const login = await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email, password } });
    return { token: login.body.token };
  }

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    C = await createRestaurant(ctx, owner, 'gamma');
    branchA = (await api(A, 'GET', '/api/branches')).body.branches[0];
    branchB = (await api(B, 'GET', '/api/branches')).body.branches[0];
    cajero = await addUser('cajero', 'cajero@alfa.test');
    mesero = await addUser('mesero', 'mesero@alfa.test');
    cocina = await addUser('cocina', 'cocina@alfa.test');
  });
  after(() => ctx?.close());

  describe('requireModule y valores iniciales', () => {
    test('sin el modulo POS todas las rutas responden 402', async () => {
      for (const [m, p] of [
        ['GET', '/api/pos/menu'], ['GET', `/api/pos/tables?branch_id=${branchA.id}`],
        ['POST', '/api/pos/orders'], ['GET', '/api/pos/payment-methods'],
        ['POST', '/api/pos/cash-sessions/open'], ['GET', '/api/pos/kitchen'], ['POST', '/api/pos/categories'],
      ]) {
        const res = await api(C, m, p, m === 'GET' ? undefined : {});
        assert.equal(res.status, 402, `${m} ${p}`);
        assert.equal(res.body.code, 'MODULE_NOT_ENABLED');
      }
      assert.equal((await ctx.request('GET', '/api/pos/menu')).status, 401, 'sin sesion');
    });

    test('restaurante suspendido: 402 aunque tenga el modulo', async () => {
      await ctx.request('POST', `/api/platform/restaurants/${B.id}/suspend`, { token: owner });
      const res = await api(B, 'GET', '/api/pos/menu');
      assert.equal(res.status, 402);
      assert.equal(res.body.code, 'RESTAURANT_SUSPENDED');
      await ctx.request('POST', `/api/platform/restaurants/${B.id}/reactivate`, { token: owner });
      assert.equal((await api(B, 'GET', '/api/pos/menu')).status, 200);
    });

    test('cada restaurante nuevo trae efectivo, tarjeta, transferencia y Clip en linea', async () => {
      const res = await api(A, 'GET', '/api/pos/payment-methods');
      assert.equal(res.status, 200);
      methodsA = res.body.payment_methods;
      assert.deepEqual(methodsA.map((m) => [m.name, m.kind]), [
        ['Efectivo', 'efectivo'], ['Tarjeta', 'tarjeta'], ['Transferencia', 'transferencia'],
        ['Clip en línea', 'en_linea'],
      ]);
      const s = await api(A, 'GET', '/api/pos/settings');
      assert.equal(Number(s.body.settings.tax_rate_pct), 16);
      assert.equal(s.body.settings.prices_include_tax, true);
    });
  });

  describe('menu y mesas', () => {
    test('admin crea categorias, grupos de modificadores y productos', async () => {
      catA = (await api(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
      salsasA = (await api(A, 'POST', '/api/pos/modifier-groups', {
        name: 'Salsa', min_selections: 1, max_selections: 1,
        modifiers: [{ name: 'Verde' }, { name: 'Roja' }],
      })).body.group;
      extrasA = (await api(A, 'POST', '/api/pos/modifier-groups', {
        name: 'Extras', min_selections: 0, max_selections: 2,
        modifiers: [{ name: 'Queso', price_delta: 15 }, { name: 'Aguacate', price_delta: 20 }, { name: 'Sin cebolla', price_delta: 0 }],
      })).body.group;
      assert.equal(extrasA.modifiers.length, 3);
      const t = await api(A, 'POST', '/api/pos/items', {
        category_id: catA.id, name: 'Taco de asada', price: 100, image_url: 'https://cdn.example.com/taco.jpg',
        modifier_group_ids: [salsasA.id, extrasA.id],
      });
      assert.equal(t.status, 201, JSON.stringify(t.body));
      tacoA = t.body.item;
      assert.deepEqual(tacoA.modifier_group_ids, [salsasA.id, extrasA.id]);
      aguaA = (await api(A, 'POST', '/api/pos/items', { category_id: catA.id, name: 'Agua', price: 50 })).body.item;

      const menu = await api(A, 'GET', `/api/pos/menu?branch_id=${branchA.id}`);
      assert.deepEqual(menu.body.items.map((i) => i.name).sort(), ['Agua', 'Taco de asada']);
      assert.equal(menu.body.modifier_groups.length, 2);
    });

    test('editar las opciones de un grupo conserva, actualiza y borra', async () => {
      const [queso, aguacate] = extrasA.modifiers;
      const res = await api(A, 'PATCH', `/api/pos/modifier-groups/${extrasA.id}`, {
        modifiers: [{ id: queso.id, name: 'Queso', price_delta: 15 }, { id: aguacate.id, name: 'Aguacate', price_delta: 20 }],
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.group.modifiers.map((m) => m.name), ['Queso', 'Aguacate']);
      extrasA = res.body.group;
    });

    test('solo admin/gerente editan el menu', async () => {
      const res = await api(cajero, 'POST', '/api/pos/categories', { name: 'X' });
      assert.equal(res.status, 403);
      assert.equal((await api(mesero, 'GET', '/api/pos/menu')).status, 200);
    });

    test('disponibilidad por sucursal (agotado)', async () => {
      const off = await api(cajero, 'PUT', `/api/pos/items/${aguaA.id}/availability`, { branch_id: branchA.id, available: false });
      assert.equal(off.status, 200);
      const menu = await api(A, 'GET', `/api/pos/menu?branch_id=${branchA.id}`);
      assert.equal(menu.body.items.find((i) => i.id === aguaA.id).available, false);
      await api(A, 'PUT', `/api/pos/items/${aguaA.id}/availability`, { branch_id: branchA.id, available: true });
    });

    test('zonas y mesas por sucursal', async () => {
      const zone = (await api(A, 'POST', '/api/pos/zones', { branch_id: branchA.id, name: 'Terraza' })).body.zone;
      mesa1 = (await api(A, 'POST', '/api/pos/tables', { branch_id: branchA.id, zone_id: zone.id, name: 'M1', capacity: 4 })).body.table;
      mesa2 = (await api(A, 'POST', '/api/pos/tables', { branch_id: branchA.id, name: 'M2' })).body.table;
      const dup = await api(A, 'POST', '/api/pos/tables', { branch_id: branchA.id, name: 'M1' });
      assert.equal(dup.status, 409);
      const list = await api(A, 'GET', `/api/pos/tables?branch_id=${branchA.id}`);
      assert.deepEqual(list.body.tables.map((t) => [t.name, t.status]), [['M1', 'libre'], ['M2', 'libre']]);
    });
  });

  describe('aislamiento entre restaurantes', () => {
    test('B no ve el menu, las mesas ni los metodos de pago de A', async () => {
      const menu = await api(B, 'GET', '/api/pos/menu?all=1');
      assert.deepEqual(menu.body.items, []);
      assert.deepEqual(menu.body.categories, []);
      assert.deepEqual(menu.body.modifier_groups, []);
      const tables = await api(B, 'GET', `/api/pos/tables?branch_id=${branchA.id}`);
      assert.deepEqual(tables.body.tables, []);
      const methods = await api(B, 'GET', '/api/pos/payment-methods');
      assert.ok(methods.body.payment_methods.every((m) => !methodsA.some((a) => a.id === m.id)));
    });

    test('B no puede editar ni borrar el menu de A', async () => {
      assert.equal((await api(B, 'PATCH', `/api/pos/items/${tacoA.id}`, { price: 1 })).status, 404);
      assert.equal((await api(B, 'DELETE', `/api/pos/items/${tacoA.id}`)).status, 404);
      assert.equal((await api(B, 'PATCH', `/api/pos/categories/${catA.id}`, { name: 'x' })).status, 404);
      assert.equal((await api(B, 'DELETE', `/api/pos/modifier-groups/${salsasA.id}`)).status, 404);
      assert.equal((await api(B, 'PATCH', `/api/pos/tables/${mesa1.id}`, { name: 'x' })).status, 404);
      const still = await api(A, 'GET', '/api/pos/menu');
      assert.equal(Number(still.body.items.find((i) => i.id === tacoA.id).price), 100);
    });

    test('B no puede usar productos, grupos, mesas ni sucursales de A', async () => {
      const catB = (await api(B, 'POST', '/api/pos/categories', { name: 'Bebidas' })).body.category;
      const cross = await api(B, 'POST', '/api/pos/items', {
        category_id: catB.id, name: 'Intruso', price: 1, modifier_group_ids: [salsasA.id],
      });
      assert.equal(cross.status, 400);
      assert.equal(cross.body.code, 'GROUP_NOT_FOUND');
      const crossCat = await api(B, 'POST', '/api/pos/items', { category_id: catA.id, name: 'Intruso', price: 1 });
      assert.equal(crossCat.status, 400);

      const withA = await api(B, 'POST', '/api/pos/orders', {
        branch_id: branchB.id, order_type: 'para_llevar', items: [{ menu_item_id: aguaA.id }],
      });
      assert.equal(withA.status, 400);
      assert.equal(withA.body.code, 'ITEM_NOT_FOUND');
      const tableA = await api(B, 'POST', '/api/pos/orders', { branch_id: branchB.id, order_type: 'comedor', table_id: mesa1.id });
      assert.equal(tableA.body.code, 'TABLE_NOT_FOUND');
      const branch = await api(B, 'POST', '/api/pos/orders', { branch_id: branchA.id, order_type: 'para_llevar' });
      assert.equal(branch.body.code, 'BRANCH_NOT_FOUND');
      const zone = await api(B, 'POST', '/api/pos/zones', { branch_id: branchA.id, name: 'x' });
      assert.equal(zone.body.code, 'BRANCH_NOT_FOUND');
    });

    test('B no ve, edita, cobra ni cancela las ordenes de A', async () => {
      const o = (await api(A, 'POST', '/api/pos/orders', {
        branch_id: branchA.id, order_type: 'para_llevar', items: [{ menu_item_id: aguaA.id }],
      })).body.order;
      assert.equal((await api(B, 'GET', `/api/pos/orders/${o.id}`)).status, 404);
      assert.equal((await api(B, 'POST', `/api/pos/orders/${o.id}/items`, { items: [{ menu_item_id: aguaA.id }] })).status, 404);
      assert.equal((await api(B, 'POST', `/api/pos/orders/${o.id}/cancel`, { reason: 'x' })).status, 404);
      assert.equal((await api(B, 'PUT', `/api/pos/orders/${o.id}/discount`, { type: 'percent', value: 100 })).status, 404);
      const list = await api(B, 'GET', `/api/pos/orders?branch_id=${branchA.id}&status=todas`);
      assert.deepEqual(list.body.orders, []);
      const sessionB = (await api(B, 'POST', '/api/pos/cash-sessions/open', { branch_id: branchB.id })).body.session;
      const pay = await api(B, 'POST', `/api/pos/orders/${o.id}/payments`, { cash_session_id: sessionB.id, payments: [] });
      assert.equal(pay.status, 404);
      assert.equal((await api(B, 'GET', `/api/pos/kitchen?branch_id=${branchA.id}`)).body.orders.length, 0);
      assert.equal((await api(A, 'GET', `/api/pos/cash-sessions/${sessionB.id}`)).status, 404);
      await api(A, 'POST', `/api/pos/orders/${o.id}/cancel`, { reason: 'prueba' });
    });

    test('RLS: sin contexto no se ve nada y no se cruzan filas', async () => {
      for (const t of ['menu_items', 'orders', 'order_items', 'payment_methods', 'cash_sessions', 'restaurant_tables']) {
        const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM ${t}`);
        assert.equal(rows[0].n, 0, t);
      }
      const ids = await ctx.withTenant(B.id, async (db) =>
        (await db.query('SELECT restaurant_id FROM menu_categories UNION SELECT restaurant_id FROM cash_sessions UNION SELECT restaurant_id FROM payment_methods')).rows.map((r) => r.restaurant_id));
      assert.deepEqual(ids, [B.id]);
      await assert.rejects(
        ctx.withTenant(B.id, (db) => db.query(
          "INSERT INTO menu_categories (restaurant_id, name) VALUES ($1, 'intrusa')", [A.id],
        )),
        /row-level security/,
      );
      const upd = await ctx.withTenant(B.id, (db) => db.query('UPDATE menu_items SET price = 1 WHERE restaurant_id = $1', [A.id]));
      assert.equal(upd.rowCount, 0);
    });
  });

  describe('ordenes, descuentos, pagos y caja', () => {
    let order; let session;

    test('modificadores obligatorios y maximos', async () => {
      const missing = await api(A, 'POST', '/api/pos/orders', {
        branch_id: branchA.id, order_type: 'para_llevar', items: [{ menu_item_id: tacoA.id }],
      });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.code, 'MODIFIERS_REQUIRED');
      const [queso, aguacate] = extrasA.modifiers;
      const tooMany = await api(A, 'POST', '/api/pos/orders', {
        branch_id: branchA.id, order_type: 'para_llevar',
        items: [{ menu_item_id: tacoA.id, modifier_ids: [salsasA.modifiers[0].id, salsasA.modifiers[1].id, queso.id, aguacate.id] }],
      });
      assert.equal(tooMany.body.code, 'MODIFIERS_EXCEEDED');
      const wrong = await api(A, 'POST', '/api/pos/orders', {
        branch_id: branchA.id, order_type: 'para_llevar', items: [{ menu_item_id: aguaA.id, modifier_ids: [queso.id] }],
      });
      assert.equal(wrong.body.code, 'MODIFIER_NOT_ALLOWED');
      const dom = await api(A, 'POST', '/api/pos/orders', { branch_id: branchA.id, order_type: 'domicilio' });
      assert.equal(dom.body.code, 'CUSTOMER_REQUIRED');
    });

    test('orden de comedor: totales con modificadores e IVA incluido, mesa ocupada', async () => {
      const [queso] = extrasA.modifiers;
      const res = await api(mesero, 'POST', '/api/pos/orders', {
        branch_id: branchA.id, order_type: 'comedor', table_id: mesa1.id, guests: 2,
        items: [
          { menu_item_id: tacoA.id, quantity: 2, modifier_ids: [salsasA.modifiers[0].id, queso.id], notes: 'bien dorado' },
          { menu_item_id: aguaA.id },
        ],
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      order = res.body.order;
      assert.equal(order.status, 'abierta');
      assert.equal(order.table_name, 'M1');
      assert.equal(Number(order.subtotal), 280); // 2 x (100 + 15) + 50
      assert.equal(Number(order.tax_amount), 38.62);
      assert.equal(Number(order.total), 280);
      assert.deepEqual(order.items[0].modifiers.map((m) => m.name).sort(), ['Queso', 'Verde']);
      assert.equal(order.items[0].notes, 'bien dorado');

      const busy = await api(A, 'POST', '/api/pos/orders', { branch_id: branchA.id, order_type: 'comedor', table_id: mesa1.id });
      assert.equal(busy.status, 409);
      assert.equal(busy.body.code, 'TABLE_OCCUPIED');
      const tables = await api(A, 'GET', `/api/pos/tables?branch_id=${branchA.id}`);
      assert.equal(tables.body.tables.find((t) => t.id === mesa1.id).status, 'ocupada');
      assert.equal(tables.body.tables.find((t) => t.id === mesa1.id).order_id, order.id);
    });

    test('folio consecutivo por sucursal', async () => {
      const o = (await api(A, 'POST', '/api/pos/orders', { branch_id: branchA.id, order_type: 'para_llevar' })).body.order;
      assert.equal(o.folio, order.folio + 1);
      const ob = (await api(B, 'POST', '/api/pos/orders', { branch_id: branchB.id, order_type: 'para_llevar' })).body.order;
      assert.equal(ob.folio, 1);
      await api(A, 'POST', `/api/pos/orders/${o.id}/cancel`, { reason: 'prueba' });
    });

    test('enviar a cocina, KDS y marcar lista', async () => {
      const sent = await api(mesero, 'POST', `/api/pos/orders/${order.id}/send`);
      assert.equal(sent.body.order.status, 'enviada');
      assert.ok(sent.body.order.items.every((i) => i.sent_at));
      assert.equal((await api(mesero, 'POST', `/api/pos/orders/${order.id}/send`)).body.code, 'NOTHING_TO_SEND');

      const kds = await api(cocina, 'GET', `/api/pos/kitchen?branch_id=${branchA.id}`);
      assert.deepEqual(kds.body.orders.map((o) => o.id), [order.id]);
      assert.equal(kds.body.orders[0].items.length, 2);

      assert.equal((await api(mesero, 'POST', `/api/pos/orders/${order.id}/ready`)).status, 403);
      const ready = await api(cocina, 'POST', `/api/pos/orders/${order.id}/ready`);
      assert.equal(ready.body.order.status, 'lista');
      assert.equal((await api(cocina, 'GET', `/api/pos/kitchen?branch_id=${branchA.id}`)).body.orders.length, 0);

      // Un articulo nuevo enviado despues vuelve a aparecer en cocina.
      await api(mesero, 'POST', `/api/pos/orders/${order.id}/items`, { items: [{ menu_item_id: aguaA.id, quantity: 2 }] });
      const again = await api(mesero, 'POST', `/api/pos/orders/${order.id}/send`);
      assert.equal(again.body.order.status, 'enviada');
      const kds2 = await api(cocina, 'GET', `/api/pos/kitchen?branch_id=${branchA.id}`);
      assert.deepEqual(kds2.body.orders[0].items.map((i) => i.is_new), [false, false, true]);
      assert.equal(Number(again.body.order.total), 380);
    });

    test('quitar articulos: libre si no se envio; enviado solo gerente con motivo', async () => {
      const added = await api(mesero, 'POST', `/api/pos/orders/${order.id}/items`, { items: [{ menu_item_id: aguaA.id }] });
      const fresh = added.body.order.items.at(-1);
      assert.equal(Number(added.body.order.total), 430);
      const del = await api(mesero, 'DELETE', `/api/pos/orders/${order.id}/items/${fresh.id}`);
      assert.equal(Number(del.body.order.total), 380);

      const sentItem = del.body.order.items.at(-1);
      assert.equal((await api(mesero, 'DELETE', `/api/pos/orders/${order.id}/items/${sentItem.id}`)).status, 403);
      assert.equal((await api(A, 'DELETE', `/api/pos/orders/${order.id}/items/${sentItem.id}`)).body.code, 'REASON_REQUIRED');
      const voided = await api(A, 'DELETE', `/api/pos/orders/${order.id}/items/${sentItem.id}`, { reason: 'se equivoco' });
      assert.equal(voided.status, 200);
      assert.equal(Number(voided.body.order.total), 280);
      assert.ok(voided.body.order.items.at(-1).voided_at);
    });

    test('descuentos segun el rol', async () => {
      const m = await api(mesero, 'PUT', `/api/pos/orders/${order.id}/discount`, { type: 'percent', value: 5 });
      assert.equal(m.status, 403);
      const c0 = await api(cajero, 'PUT', `/api/pos/orders/${order.id}/discount`, { type: 'percent', value: 5 });
      assert.equal(c0.status, 403);
      assert.equal(c0.body.code, 'DISCOUNT_NOT_ALLOWED');

      await api(A, 'PATCH', '/api/pos/settings', { cashier_max_discount_pct: 10 });
      const c15 = await api(cajero, 'PUT', `/api/pos/orders/${order.id}/discount`, { type: 'amount', value: 42 }); // 15 %
      assert.equal(c15.status, 403);
      const c10 = await api(cajero, 'PUT', `/api/pos/orders/${order.id}/discount`, { type: 'percent', value: 10, reason: 'cliente frecuente' });
      assert.equal(c10.status, 200);
      assert.equal(Number(c10.body.order.discount_amount), 28);
      assert.equal(Number(c10.body.order.total), 252);
      assert.equal(Number(c10.body.order.tax_amount), 34.76);

      const admin = await api(A, 'PUT', `/api/pos/orders/${order.id}/discount`, { type: 'percent', value: 50 });
      assert.equal(Number(admin.body.order.total), 140);
      const removed = await api(A, 'DELETE', `/api/pos/orders/${order.id}/discount`);
      assert.equal(Number(removed.body.order.total), 280);
      await api(cajero, 'PUT', `/api/pos/orders/${order.id}/discount`, { type: 'amount', value: 20 });
    });

    test('IVA encima del precio para ordenes nuevas', async () => {
      await api(A, 'PATCH', '/api/pos/settings', { prices_include_tax: false });
      const o = (await api(A, 'POST', '/api/pos/orders', {
        branch_id: branchA.id, order_type: 'domicilio', customer_name: 'Ana', customer_phone: '555', customer_address: 'Calle 1',
        items: [{ menu_item_id: aguaA.id, quantity: 2 }],
      })).body.order;
      assert.equal(Number(o.subtotal), 100);
      assert.equal(Number(o.tax_amount), 16);
      assert.equal(Number(o.total), 116);
      assert.equal(o.customer_address, 'Calle 1');
      await api(A, 'POST', `/api/pos/orders/${o.id}/cancel`, { reason: 'prueba' });
      await api(A, 'PATCH', '/api/pos/settings', { prices_include_tax: true });
    });

    test('cobrar requiere caja abierta de la sucursal', async () => {
      assert.equal((await api(mesero, 'POST', '/api/pos/cash-sessions/open', { branch_id: branchA.id })).status, 403);
      const res = await api(cajero, 'POST', `/api/pos/orders/${order.id}/payments`, {
        cash_session_id: '00000000-0000-4000-8000-000000000000', payments: [{ payment_method_id: byKind('efectivo'), amount: 10 }],
      });
      assert.equal(res.body.code, 'CASH_SESSION_REQUIRED');

      const open = await api(cajero, 'POST', '/api/pos/cash-sessions/open', { branch_id: branchA.id, terminal: 'Caja 1', opening_cash: 500 });
      assert.equal(open.status, 201, JSON.stringify(open.body));
      session = open.body.session;
      const dup = await api(A, 'POST', '/api/pos/cash-sessions/open', { branch_id: branchA.id, terminal: 'caja 1' });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.code, 'CASH_SESSION_ALREADY_OPEN');
    });

    test('pagos divididos con propina y cambio; la mesa se libera', async () => {
      // Total 260 (280 - 20 de descuento).
      const over = await api(cajero, 'POST', `/api/pos/orders/${order.id}/payments`, {
        cash_session_id: session.id, payments: [{ payment_method_id: byKind('tarjeta'), amount: 300 }],
      });
      assert.equal(over.body.code, 'OVERPAYMENT');
      const mesPay = await api(mesero, 'POST', `/api/pos/orders/${order.id}/payments`, { cash_session_id: session.id, payments: [] });
      assert.equal(mesPay.status, 403);

      const part = await api(cajero, 'POST', `/api/pos/orders/${order.id}/payments`, {
        cash_session_id: session.id, payments: [{ payment_method_id: byKind('tarjeta'), amount: 100, tip: 15, reference: '1234' }],
      });
      assert.equal(part.status, 201, JSON.stringify(part.body));
      assert.equal(part.body.remaining, 160);
      assert.equal(part.body.order.status, 'enviada');

      const cancel = await api(A, 'POST', `/api/pos/orders/${order.id}/cancel`, { reason: 'x' });
      assert.equal(cancel.body.code, 'ORDER_HAS_PAYMENTS');
      const below = await api(A, 'PUT', `/api/pos/orders/${order.id}/discount`, { type: 'percent', value: 100 });
      assert.equal(below.body.code, 'TOTAL_BELOW_PAID');

      const rest = await api(cajero, 'POST', `/api/pos/orders/${order.id}/payments`, {
        cash_session_id: session.id,
        payments: [
          { payment_method_id: byKind('efectivo'), amount: 110, tip: 10, received: 200 },
          { payment_method_id: byKind('transferencia'), amount: 50 },
        ],
      });
      assert.equal(rest.status, 201, JSON.stringify(rest.body));
      assert.equal(rest.body.change, 80);
      assert.equal(rest.body.remaining, 0);
      const paid = rest.body.order;
      assert.equal(paid.status, 'pagada');
      assert.equal(Number(paid.paid_amount), 260);
      assert.equal(Number(paid.tip_amount), 25);
      assert.equal(paid.payments.length, 3);
      assert.equal(Number(paid.payments.find((p) => p.method_kind === 'efectivo').change_given), 80);

      const again = await api(cajero, 'POST', `/api/pos/orders/${order.id}/payments`, {
        cash_session_id: session.id, payments: [{ payment_method_id: byKind('efectivo'), amount: 1 }],
      });
      assert.equal(again.body.code, 'ORDER_CLOSED');
      const tables = await api(A, 'GET', `/api/pos/tables?branch_id=${branchA.id}`);
      assert.equal(tables.body.tables.find((t) => t.id === mesa1.id).status, 'libre');
    });

    test('cancelar exige motivo; mesero no cancela lo que ya fue a cocina', async () => {
      const o = (await api(mesero, 'POST', '/api/pos/orders', {
        branch_id: branchA.id, order_type: 'comedor', table_id: mesa2.id, items: [{ menu_item_id: aguaA.id }],
      })).body.order;
      await api(mesero, 'POST', `/api/pos/orders/${o.id}/send`);
      assert.equal((await api(A, 'POST', `/api/pos/orders/${o.id}/cancel`, {})).body.code, 'MISSING_FIELD');
      assert.equal((await api(mesero, 'POST', `/api/pos/orders/${o.id}/cancel`, { reason: 'se fue' })).status, 403);
      const ok = await api(cajero, 'POST', `/api/pos/orders/${o.id}/cancel`, { reason: 'el cliente se fue' });
      assert.equal(ok.body.order.status, 'cancelada');
      assert.equal(ok.body.order.cancel_reason, 'el cliente se fue');
      assert.equal((await api(cocina, 'GET', `/api/pos/kitchen?branch_id=${branchA.id}`)).body.orders.length, 0);
    });

    test('movimientos de caja y corte: esperado contra contado por metodo', async () => {
      await api(cajero, 'POST', `/api/pos/cash-sessions/${session.id}/movements`, { kind: 'entrada', amount: 100, reason: 'Cambio extra' });
      await api(cajero, 'POST', `/api/pos/cash-sessions/${session.id}/movements`, { kind: 'salida', amount: 45.5, reason: 'Hielo' });
      const bad = await api(cajero, 'POST', `/api/pos/cash-sessions/${session.id}/movements`, { kind: 'salida', amount: 10 });
      assert.equal(bad.status, 400);

      const live = await api(cajero, 'GET', `/api/pos/cash-sessions/${session.id}`);
      assert.equal(live.status, 200);
      const cut = live.body.cut;
      assert.equal(cut.total_sales, 260);
      assert.equal(cut.total_tips, 25);
      assert.equal(cut.expected_cash, 674.5); // 500 + 110 + 10 + 100 - 45.5
      assert.equal(cut.orders_count, 1);
      const exp = Object.fromEntries(cut.methods.map((m) => [m.kind, m.expected]));
      assert.deepEqual(exp, { efectivo: 674.5, tarjeta: 115, transferencia: 50 });
      assert.equal(live.body.movements.length, 2);

      const missing = await api(cajero, 'POST', `/api/pos/cash-sessions/${session.id}/close`, {
        counts: [{ payment_method_id: byKind('efectivo'), counted: 670 }],
      });
      assert.equal(missing.body.code, 'MISSING_COUNTS');

      const closed = await api(cajero, 'POST', `/api/pos/cash-sessions/${session.id}/close`, {
        counts: [
          { payment_method_id: byKind('efectivo'), counted: 670 },
          { payment_method_id: byKind('tarjeta'), counted: 115 },
          { payment_method_id: byKind('transferencia'), counted: 50 },
        ],
        notes: 'faltaron 4.50',
      });
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      assert.equal(closed.body.session.status, 'cerrada');
      assert.equal(Number(closed.body.session.expected_cash), 674.5);
      assert.equal(Number(closed.body.session.counted_cash), 670);
      assert.equal(Number(closed.body.session.difference), -4.5);
      assert.equal(Number(closed.body.session.total_sales), 260);
      assert.equal(closed.body.cut.total_difference, -4.5);

      const history = await api(A, 'GET', `/api/pos/cash-sessions?branch_id=${branchA.id}`);
      assert.deepEqual(history.body.sessions.map((s) => s.status), ['cerrada']);
      const detail = await api(A, 'GET', `/api/pos/cash-sessions/${session.id}`);
      assert.equal(detail.body.cut.counted_cash, 670);
      assert.equal((await api(cajero, 'POST', `/api/pos/cash-sessions/${session.id}/movements`, { kind: 'entrada', amount: 1, reason: 'x' })).body.code, 'CASH_SESSION_CLOSED');

      const nopay = await api(cajero, 'POST', `/api/pos/orders/${order.id}/payments`, { cash_session_id: session.id, payments: [] });
      assert.equal(nopay.status, 400);
    });

    test('productos y metodos ya usados se desactivan en lugar de borrarse', async () => {
      const del = await api(A, 'DELETE', `/api/pos/items/${aguaA.id}`);
      assert.equal(del.status, 200);
      assert.equal(del.body.archived, true);
      const pm = await api(A, 'DELETE', `/api/pos/payment-methods/${byKind('transferencia')}`);
      assert.equal(pm.body.archived, true);
      const menu = await api(A, 'GET', '/api/pos/menu');
      assert.ok(!menu.body.items.some((i) => i.id === aguaA.id));
      const notEmpty = await api(A, 'DELETE', `/api/pos/categories/${catA.id}`);
      assert.equal(notEmpty.body.code, 'CATEGORY_NOT_EMPTY');
    });

    test('borrar un restaurante con ventas borra todo su POS', async () => {
      const res = await ctx.request('DELETE', `/api/platform/restaurants/${A.id}?confirm=alfa`, { token: owner });
      assert.equal(res.status, 204, JSON.stringify(res.body));
      const n = await ctx.withPlatform(async (db) =>
        (await db.query('SELECT count(*)::int AS n FROM orders WHERE restaurant_id = $1', [A.id])).rows[0].n);
      assert.equal(n, 0);
    });
  });
});
