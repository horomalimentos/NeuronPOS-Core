// Reportes de ventas del POS y fotos subidas por el restaurante.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('reportes de ventas y fotos', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branch; let methods; let cajero;
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });
  const kind = (k) => methods.find((m) => m.kind === k).id;
  let today;

  before(async () => {
    process.env.UPLOADS_DIR = uploads;
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'reportes'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos', 'reportes'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    today = new Intl.DateTimeFormat('en-CA', { timeZone: branch.timezone }).format(new Date());
    methods = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods;
    await api(A, 'POST', '/api/users', { email: 'caja@alfa.test', name: 'Caja', role: 'cajero', password: 'clave-segura-9', branch_ids: [branch.id] });
    cajero = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'caja@alfa.test', password: 'clave-segura-9' } })).body;
  });
  after(() => { ctx?.close(); fs.rmSync(uploads, { recursive: true, force: true }); });

  test('resumen, metodos, productos, modificadores y personal del dia', async () => {
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    const extras = (await api(A, 'POST', '/api/pos/modifier-groups', {
      name: 'Extras', min_selections: 0, max_selections: 1, modifiers: [{ name: 'Queso', price_delta: 10 }],
    })).body.group;
    const taco = (await api(A, 'POST', '/api/pos/items', {
      category_id: cat.id, name: 'Taco', price: 50, modifier_group_ids: [extras.id],
    })).body.item;
    const agua = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Agua', price: 20 })).body.item;
    const session = (await api(cajero, 'POST', '/api/pos/cash-sessions/open', { branch_id: branch.id })).body.session;

    // Orden 1: 2 tacos con queso (120) pagada en efectivo con propina 10.
    const o1 = (await api(cajero, 'POST', '/api/pos/orders', {
      branch_id: branch.id, order_type: 'para_llevar',
      items: [{ menu_item_id: taco.id, quantity: 2, modifier_ids: [extras.modifiers[0].id] }],
    })).body.order;
    assert.equal(Number(o1.total), 120);
    const p1 = await api(cajero, 'POST', `/api/pos/orders/${o1.id}/payments`, {
      cash_session_id: session.id, payments: [{ payment_method_id: kind('efectivo'), amount: 120, tip: 10, received: 130 }],
    });
    assert.equal(p1.status, 201, JSON.stringify(p1.body));

    // Orden 2: agua (20) con tarjeta, abierta por el admin.
    const o2 = (await api(A, 'POST', '/api/pos/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: agua.id }],
    })).body.order;
    await api(cajero, 'POST', `/api/pos/orders/${o2.id}/payments`, {
      cash_session_id: session.id, payments: [{ payment_method_id: kind('tarjeta'), amount: 20 }],
    });

    // Orden 3: cancelada.
    const o3 = (await api(A, 'POST', '/api/pos/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: agua.id, quantity: 3 }],
    })).body.order;
    await api(A, 'POST', `/api/pos/orders/${o3.id}/cancel`, { reason: 'prueba' });

    const res = await api(A, 'GET', `/api/pos/reports/sales?from=${today}&to=${today}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = res.body;
    assert.equal(r.summary.orders, 2);
    assert.equal(r.summary.total, 140);
    assert.equal(r.summary.tips, 10);
    assert.equal(r.summary.average_ticket, 70);
    assert.equal(r.previous.orders, 0);
    assert.deepEqual(r.cancelled, { orders: 1, total: 60 });
    assert.deepEqual(r.by_day, [{ date: today, orders: 2, total: 140 }]);
    assert.deepEqual(r.by_payment_method.map((m) => [m.kind, m.amount, m.tips]), [['efectivo', 120, 10], ['tarjeta', 20, 0]]);
    assert.deepEqual(r.items.map((i) => [i.name, i.quantity, i.total, i.category]), [['Taco', 2, 120, 'Tacos'], ['Agua', 1, 20, 'Tacos']]);
    assert.deepEqual(r.categories, [{ category: 'Tacos', quantity: 3, total: 140 }]);
    assert.deepEqual(r.modifiers, [{ group_name: 'Extras', name: 'Queso', quantity: 2, total: 20 }]);
    assert.deepEqual(r.staff.map((s) => [s.name, s.orders, s.total]).sort(), [['Admin alfa', 1, 20], ['Caja', 1, 120]]);
    assert.equal(r.by_branch[0].branch_id, branch.id);
    assert.equal(r.by_order_type[0].order_type, 'para_llevar');

    // Filtrar por sucursal da lo mismo; otro rango, nada.
    const one = await api(A, 'GET', `/api/pos/reports/sales?from=${today}&to=${today}&branch_id=${branch.id}`);
    assert.equal(one.body.summary.total, 140);
    const old = await api(A, 'GET', '/api/pos/reports/sales?from=2020-01-01&to=2020-01-31');
    assert.equal(old.body.summary.orders, 0);
    assert.equal(old.body.previous_range.from, '2019-12-01');
  });

  test('sin el modulo de reportes responde 402', async () => {
    const C = await createRestaurant(ctx, owner, 'gamma', { modules: ['pos'] });
    const res = await api(C, 'GET', `/api/pos/reports/sales?from=${today}&to=${today}`);
    assert.equal(res.status, 402);
    assert.equal(res.body.code, 'MODULE_NOT_ENABLED');
  });

  test('solo admin/gerente; fechas validas; cada restaurante ve lo suyo', async () => {
    assert.equal((await api(cajero, 'GET', `/api/pos/reports/sales?from=${today}&to=${today}`)).status, 403);
    for (const q of ['', 'from=2026-01-01', 'from=2026-02-30&to=2026-03-01', 'from=2026-03-02&to=2026-03-01', 'from=2024-01-01&to=2026-01-01']) {
      const res = await api(A, 'GET', `/api/pos/reports/sales?${q}`);
      assert.equal(res.status, 400, q);
      assert.equal(res.body.code, 'INVALID_RANGE');
    }
    const b = await api(B, 'GET', `/api/pos/reports/sales?from=${today}&to=${today}`);
    assert.equal(b.body.summary.orders, 0);
    const cross = await api(B, 'GET', `/api/pos/reports/sales?from=${today}&to=${today}&branch_id=${branch.id}`);
    assert.equal(cross.body.summary.orders, 0, 'la sucursal de otro restaurante no trae nada');
  });

  test('subir una foto la guarda por restaurante y se sirve publica', async () => {
    const up = await ctx.request('POST', '/api/uploads/image', { token: A.token, raw: PNG, headers: { 'content-type': 'image/png' } });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.match(up.body.url, new RegExp(`^/api/uploads/${A.id}/[0-9a-f-]{36}\\.png$`));
    const get = await ctx.request('GET', up.body.url);
    assert.equal(get.status, 200);
    assert.equal(get.headers['content-type'], 'image/png');

    // La URL sirve como imagen de un producto.
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Bebidas' })).body.category;
    const item = await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Jamaica', price: 25, image_url: up.body.url });
    assert.equal(item.status, 201);
    assert.equal(item.body.item.image_url, up.body.url);
  });

  test('rechaza lo que no es imagen, lo muy pesado y a quien no es admin', async () => {
    const fake = await ctx.request('POST', '/api/uploads/image', { token: A.token, raw: Buffer.from('<svg onload=alert(1)>'), headers: { 'content-type': 'image/png' } });
    assert.equal(fake.body.code, 'INVALID_IMAGE');
    const empty = await ctx.request('POST', '/api/uploads/image', { token: A.token, body: { a: 1 } });
    assert.equal(empty.body.code, 'IMAGE_REQUIRED');
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const tooBig = await ctx.request('POST', '/api/uploads/image', { token: A.token, raw: big, headers: { 'content-type': 'image/png' } });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.code, 'IMAGE_TOO_LARGE');
    const caja = await ctx.request('POST', '/api/uploads/image', { token: cajero.token, raw: PNG, headers: { 'content-type': 'image/png' } });
    assert.equal(caja.status, 403);
    const anon = await ctx.request('POST', '/api/uploads/image', { slug: 'alfa', raw: PNG, headers: { 'content-type': 'image/png' } });
    assert.equal(anon.status, 401);
  });
});
