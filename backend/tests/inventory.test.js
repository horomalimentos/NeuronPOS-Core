// Inventario: catalogos, unidades, conteos, mermas, recetas con descuento
// al cobrar, compras (solicitud -> aprobacion -> recepcion), sugerencias,
// reporte de consumo, roles y aislamiento entre restaurantes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('inventario', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branch; let cocina; let mesero; let cajero;
  let almacen; let lala; let tortilla; let carne; let queso; let refresco;
  let taco; let extras; let conQueso; let session; let methods;
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });
  const stockOf = async (id) => (await api(A, 'GET', `/api/inventory/stock?branch_id=${branch.id}`)).body.products.find((p) => p.id === id);

  async function addUser(role) {
    const email = `${role}@alfa.test`;
    await api(A, 'POST', '/api/users', { email, name: role, role, password: 'clave-segura-9', branch_ids: [branch.id] });
    return (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email, password: 'clave-segura-9' } })).body;
  }

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'inventario'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    cocina = await addUser('cocina');
    mesero = await addUser('mesero');
    cajero = await addUser('cajero');
    methods = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods;
  });
  after(() => ctx?.close());

  test('sin el modulo responde 402; mesero no entra', async () => {
    const res = await api(B, 'GET', '/api/inventory/products');
    assert.equal(res.status, 402);
    assert.equal(res.body.code, 'MODULE_NOT_ENABLED');
    assert.equal((await api(mesero, 'GET', '/api/inventory/products')).status, 403);
  });

  test('areas, proveedores e insumos con unidades', async () => {
    almacen = (await api(A, 'POST', '/api/inventory/areas', { name: 'Almacén' })).body.area;
    assert.equal((await api(A, 'POST', '/api/inventory/areas', { name: 'almacén' })).body.code, 'DUPLICATE_NAME');
    lala = (await api(A, 'POST', '/api/inventory/suppliers', { name: 'Lala', phone: '6561234567' })).body.supplier;
    assert.equal((await api(cocina, 'POST', '/api/inventory/suppliers', { name: 'X' })).status, 403);

    const t = await api(A, 'POST', '/api/inventory/products', {
      name: 'Tortilla', base_unit: 'pieza', area_id: almacen.id, unit_cost: 0.5, min_stock: 100, daily_use: 200,
      units: [{ name: 'paquete', factor: 50, is_purchase: true }],
    });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    tortilla = t.body.product;
    assert.deepEqual(tortilla.units.map((u) => [u.name, Number(u.factor), u.is_purchase]), [['paquete', 50, true]]);
    carne = (await api(A, 'POST', '/api/inventory/products', { name: 'Carne', base_unit: 'kg', unit_cost: 200, area_id: almacen.id, requires_photo: true })).body.product;
    queso = (await api(A, 'POST', '/api/inventory/products', { name: 'Queso', base_unit: 'kg', unit_cost: 150, supplier_id: lala.id, count_days: [1, 4] })).body.product;
    refresco = (await api(A, 'POST', '/api/inventory/products', { name: 'Refresco', base_unit: 'pieza', unit_cost: 12 })).body.product;
    assert.deepEqual(queso.count_days, [1, 4]);

    const bad = await api(A, 'POST', '/api/inventory/products', { name: 'Y', base_unit: 'kg', units: [{ name: 'kg', factor: 1 }] });
    assert.equal(bad.status, 400);
    const edit = await api(A, 'PATCH', `/api/inventory/products/${queso.id}`, { units: [{ name: 'bloque', factor: 2.5 }] });
    assert.equal(edit.body.product.units[0].name, 'bloque');
    queso = edit.body.product;
  });

  test('conteo: captura en otra unidad, foto obligatoria, pausa y completa', async () => {
    const open = await api(cocina, 'POST', '/api/inventory/counts', { branch_id: branch.id, area_id: almacen.id });
    assert.equal(open.status, 201, JSON.stringify(open.body));
    const count = open.body.count;
    assert.deepEqual(open.body.products.map((p) => p.name).sort(), ['Carne', 'Tortilla']);
    const dup = await api(cocina, 'POST', '/api/inventory/counts', { branch_id: branch.id, area_id: almacen.id });
    assert.equal(dup.body.code, 'COUNT_ALREADY_OPEN');

    const t = await api(cocina, 'PUT', `/api/inventory/counts/${count.id}/items/${tortilla.id}`, { quantity: 4, unit: 'paquete' });
    assert.equal(Number(t.body.item.quantity), 200);
    await api(cocina, 'PUT', `/api/inventory/counts/${count.id}/items/${carne.id}`, { quantity: 10 });
    assert.equal((await api(cocina, 'POST', `/api/inventory/counts/${count.id}/pause`)).body.count.status, 'pausado');
    const noPhoto = await api(cocina, 'POST', `/api/inventory/counts/${count.id}/complete`);
    assert.equal(noPhoto.body.code, 'PHOTO_REQUIRED');
    await api(cocina, 'PUT', `/api/inventory/counts/${count.id}/items/${carne.id}`, { quantity: 10, photo_url: '/api/uploads/x/carne.jpg' });
    const done = await api(cocina, 'POST', `/api/inventory/counts/${count.id}/complete`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.count.status, 'completado');
    assert.equal((await stockOf(tortilla.id)).quantity, 200);
    assert.equal((await stockOf(carne.id)).quantity, 10);
    assert.equal((await stockOf(carne.id)).value, 2000);
    const again = await api(cocina, 'PUT', `/api/inventory/counts/${count.id}/items/${carne.id}`, { quantity: 1 });
    assert.equal(again.body.code, 'COUNT_CLOSED');
  });

  test('mermas (personal) y ajustes (solo admin/gerente) quedan en el kardex', async () => {
    const m = await api(cocina, 'POST', '/api/inventory/movements', { branch_id: branch.id, product_id: carne.id, kind: 'merma', quantity: 0.5, reason: 'Se echó a perder' });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    assert.equal(m.body.balance, 9.5);
    assert.equal((await api(cocina, 'POST', '/api/inventory/movements', { branch_id: branch.id, product_id: carne.id, kind: 'ajuste', quantity: 1, reason: 'x' })).status, 403);
    const adj = await api(A, 'POST', '/api/inventory/movements', { branch_id: branch.id, product_id: queso.id, kind: 'ajuste', quantity: 2, unit: 'bloque', reason: 'Inicial' });
    assert.equal(adj.body.balance, 5);
    const k = await api(A, 'GET', `/api/inventory/movements?branch_id=${branch.id}&product_id=${carne.id}`);
    assert.deepEqual(k.body.movements.map((x) => [x.kind, Number(x.quantity), Number(x.balance)]), [['merma', -0.5, 9.5], ['conteo', 10, 10]]);
  });

  test('receta con modificador general y especifico; se descuenta al cobrar una sola vez', async () => {
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    extras = (await api(A, 'POST', '/api/pos/modifier-groups', {
      name: 'Extras', min_selections: 0, max_selections: 1, modifiers: [{ name: 'Con queso', price_delta: 10 }],
    })).body.group;
    conQueso = extras.modifiers[0];
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 40, modifier_group_ids: [extras.id] })).body.item;
    const otro = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Quesadilla', price: 50, modifier_group_ids: [extras.id] })).body.item;

    const r = await api(A, 'PUT', `/api/inventory/recipes/${taco.id}`, {
      items: [{ product_id: tortilla.id, quantity: 2 }, { product_id: carne.id, quantity: 100 / 1000 }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.item.cost, 21); // 2 x 0.5 + 0.1 x 200
    assert.equal(r.body.item.cost_pct, 52.5);
    // Queso: general 0.02 kg; para el taco 0.03 kg (sustituye a la general).
    await api(A, 'PUT', `/api/inventory/modifier-recipes/${conQueso.id}`, { items: [{ product_id: queso.id, quantity: 0.02 }] });
    const spec = await api(A, 'PUT', `/api/inventory/modifier-recipes/${conQueso.id}`, { menu_item_id: taco.id, items: [{ product_id: queso.id, quantity: 0.03 }] });
    assert.equal(spec.body.modifiers[0].cost, 4.5);
    await api(A, 'PUT', `/api/inventory/recipes/${otro.id}`, { items: [{ product_id: tortilla.id, quantity: 1 }] });

    session = (await api(cajero, 'POST', '/api/pos/cash-sessions/open', { branch_id: branch.id })).body.session;
    const o = (await api(cajero, 'POST', '/api/pos/orders', {
      branch_id: branch.id, order_type: 'para_llevar',
      items: [
        { menu_item_id: taco.id, quantity: 3, modifier_ids: [conQueso.id] },
        { menu_item_id: otro.id, quantity: 1, modifier_ids: [conQueso.id] },
      ],
    })).body.order;
    const cash = methods.find((m) => m.kind === 'efectivo').id;
    const pay = await api(cajero, 'POST', `/api/pos/orders/${o.id}/payments`, {
      cash_session_id: session.id, payments: [{ payment_method_id: cash, amount: Number(o.total) }],
    });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    // Tortilla 200 - 6 - 1; carne 9.5 - 0.3; queso 5 - 0.09 - 0.02.
    assert.equal((await stockOf(tortilla.id)).quantity, 193);
    assert.equal((await stockOf(carne.id)).quantity, 9.2);
    assert.equal((await stockOf(queso.id)).quantity, 4.89);
    const ventas = (await api(A, 'GET', `/api/inventory/movements?branch_id=${branch.id}&kind=venta`)).body.movements;
    assert.equal(ventas.length, 3);
    assert.ok(ventas.every((v) => v.order_id === o.id));
  });

  test('sin descuento automatico no toca la existencia', async () => {
    await api(A, 'PATCH', '/api/inventory/settings', { deduct_on_sale: false });
    const o = (await api(cajero, 'POST', '/api/pos/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id }],
    })).body.order;
    await api(cajero, 'POST', `/api/pos/orders/${o.id}/payments`, {
      cash_session_id: session.id, payments: [{ payment_method_id: methods.find((m) => m.kind === 'tarjeta').id, amount: Number(o.total) }],
    });
    assert.equal((await stockOf(tortilla.id)).quantity, 193);
    await api(A, 'PATCH', '/api/inventory/settings', { deduct_on_sale: true });
  });

  test('sugerencia de compra, solicitud, aprobacion y recepcion con precio', async () => {
    // Tortilla: objetivo max(100, 200 x 3 dias) = 600; hay 193 -> faltan 407 = 9 paquetes.
    const sug = await api(cocina, 'GET', `/api/inventory/purchase-suggestions?branch_id=${branch.id}`);
    assert.equal(sug.status, 200);
    const item = sug.body.suppliers.flatMap((s) => s.items).find((i) => i.product_id === tortilla.id);
    assert.deepEqual([item.unit, item.quantity, item.unit_price], ['paquete', 9, 25]);

    const req = await api(cocina, 'POST', '/api/inventory/purchase-orders', {
      branch_id: branch.id, supplier_id: lala.id, approve: true,
      items: [{ product_id: tortilla.id, quantity: 9, unit: 'paquete', unit_price: 25 }, { product_id: refresco.id, quantity: 24 }],
    });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    const po = req.body.order;
    assert.equal(po.status, 'solicitada', 'el personal no puede crearla aprobada');
    assert.equal(po.folio, 1);
    assert.equal(Number(po.total), 225);
    assert.equal((await api(cocina, 'POST', `/api/inventory/purchase-orders/${po.id}/approve`)).status, 403);
    assert.equal((await api(A, 'POST', `/api/inventory/purchase-orders/${po.id}/approve`)).body.order.status, 'aprobada');
    assert.equal((await api(cocina, 'PATCH', `/api/inventory/purchase-orders/${po.id}`, { notes: 'x' })).body.code, 'PO_CLOSED');

    const rec = await api(A, 'POST', `/api/inventory/purchase-orders/${po.id}/receive`, {
      receipt_url: '/api/uploads/x/ticket.jpg',
      items: [{ product_id: tortilla.id, received_quantity: 8, unit_price: 30 }, { product_id: refresco.id, unit_price: 11 }],
    });
    assert.equal(rec.status, 200, JSON.stringify(rec.body));
    assert.equal(rec.body.order.status, 'recibida');
    assert.equal(Number(rec.body.order.total), 504); // 8 x 30 + 24 x 11
    assert.equal((await stockOf(tortilla.id)).quantity, 593);
    assert.equal(Number((await stockOf(tortilla.id)).unit_cost), 0.6);
    assert.equal((await stockOf(refresco.id)).quantity, 24);
    const prices = await api(A, 'GET', `/api/inventory/products/${tortilla.id}/prices`);
    assert.deepEqual(prices.body.prices.map((p) => [p.unit_name, Number(p.unit_price), p.supplier_name, p.folio]), [['paquete', 30, 'Lala', 1]]);
    assert.equal((await api(A, 'POST', `/api/inventory/purchase-orders/${po.id}/receive`)).body.code, 'PO_CLOSED');
  });

  test('reporte de consumo y costo de recetas', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: branch.timezone }).format(new Date());
    const u = await api(A, 'GET', `/api/inventory/usage?branch_id=${branch.id}&from=${day}&to=${day}`);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    const c = u.body.products.find((p) => p.name === 'Carne');
    assert.deepEqual([c.sold, c.waste, c.count_diff], [0.3, 0.5, 10]);
    assert.equal(c.waste_cost, 100);
    const recipes = await api(A, 'GET', '/api/inventory/recipes');
    assert.equal(recipes.body.items.find((i) => i.name === 'Taco').ingredients, 2);
  });

  test('otro restaurante no ve ni usa los insumos', async () => {
    await api(owner, 'PUT', `/api/platform/restaurants/${B.id}/modules/inventario`, { enabled: true });
    const list = await api(B, 'GET', '/api/inventory/products');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.products.length, 0);
    const bBranch = (await api(B, 'GET', '/api/branches')).body.branches[0];
    const m = await api(B, 'POST', '/api/inventory/movements', { branch_id: bBranch.id, product_id: carne.id, kind: 'merma', quantity: 1, reason: 'x' });
    assert.equal(m.status, 404);
    assert.equal((await api(B, 'GET', `/api/inventory/recipes/${taco.id}`)).status, 404);
  });
});
