// Caja sin internet: subir ventas cobradas sin conexion. Idempotente, respeta
// el precio cobrado, entra al turno correcto y no duplica nada.
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('caja sin internet', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let C; let branch; let taco; let extras; let cash; let card; let points; let session;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const sale = (extra = {}) => ({
    offline_id: randomUUID(),
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    branch_id: branch.id,
    cash_session_id: session.id,
    local_folio: 'L-1',
    tax_rate_pct: 16,
    prices_include_tax: true,
    items: [{ menu_item_id: taco.id, quantity: 2, unit_price: 100, modifiers: [{ id: extras.modifiers[0].id, price_delta: 15 }] }],
    payments: [{ payment_method_id: cash, amount: 230, received: 300 }],
    ...extra,
  });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'sin_internet'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos', 'sin_internet'] });
    C = await createRestaurant(ctx, owner, 'gama', { modules: ['pos'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Menu' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 120 })).body.item;
    extras = (await api(A, 'POST', '/api/pos/modifier-groups', {
      name: 'Extras', min_selections: 0, max_selections: 2, modifiers: [{ name: 'Queso', price_delta: 15 }],
    })).body.group;
    const methods = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods;
    cash = methods.find((m) => m.kind === 'efectivo' && m.currency === 'MXN').id;
    card = methods.find((m) => m.kind === 'tarjeta').id;
    points = methods.find((m) => m.kind === 'puntos')?.id;
    session = (await api(A, 'POST', '/api/pos/cash-sessions/open', { branch_id: branch.id, terminal: 'Caja 1', opening_cash: 0 })).body.session;
  });
  after(() => ctx?.close());

  test('sin el modulo responde 402', async () => {
    const r = await api(C, 'POST', '/api/pos/offline-orders', {});
    assert.equal(r.status, 402);
  });

  test('sube la venta con el precio cobrado y no la duplica', async () => {
    // El precio del menu cambio despues de vender sin internet: se respeta lo cobrado.
    const body = sale();
    const r = await api(A, 'POST', '/api/pos/offline-orders', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = r.body.order;
    assert.equal(o.status, 'pagada');
    assert.equal(Number(o.total), 230);
    assert.equal(Number(o.paid_amount), 230);
    assert.equal(o.order_type, 'para_llevar');
    assert.match(o.notes, /L-1/);
    assert.equal(new Date(o.created_at).toISOString(), body.created_at);
    assert.equal(new Date(o.paid_at).toISOString(), body.created_at);
    assert.equal(o.items[0].modifiers[0].name, 'Queso');
    assert.equal(Number(o.payments[0].change_given), 70);

    const again = await api(A, 'POST', '/api/pos/offline-orders', body);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.order.id, o.id);

    const detail = (await api(A, 'GET', `/api/pos/cash-sessions/${session.id}`)).body;
    assert.equal(detail.cut.orders_count, 1);
    const kitchen = (await api(A, 'GET', `/api/pos/kitchen?branch_id=${branch.id}`)).body;
    assert.equal(kitchen.orders.length, 0, 'no aparece en cocina');
  });

  test('producto inactivo hoy sigue subiendo; validaciones de pagos', async () => {
    await api(A, 'PATCH', `/api/pos/items/${taco.id}`, { active: false });
    const ok = await api(A, 'POST', '/api/pos/offline-orders', sale({ items: [{ menu_item_id: taco.id, quantity: 1, unit_price: 100 }], payments: [{ payment_method_id: card, amount: 100 }] }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    await api(A, 'PATCH', `/api/pos/items/${taco.id}`, { active: true });

    const short = await api(A, 'POST', '/api/pos/offline-orders', sale({ payments: [{ payment_method_id: cash, amount: 200 }] }));
    assert.equal(short.body.code, 'OFFLINE_NOT_PAID');
    if (points) {
      const p = await api(A, 'POST', '/api/pos/offline-orders', sale({ payments: [{ payment_method_id: points, amount: 230 }] }));
      assert.equal(p.body.code, 'OFFLINE_METHOD_NOT_ALLOWED');
    }
    const future = await api(A, 'POST', '/api/pos/offline-orders', sale({ created_at: new Date(Date.now() + 3600_000).toISOString() }));
    assert.equal(future.body.code, 'OFFLINE_BAD_DATE');
  });

  test('si el turno se cerro entra al abierto; sin turno abierto responde 409', async () => {
    const closed = await api(A, 'POST', `/api/pos/cash-sessions/${session.id}/close`, { counts: [{ payment_method_id: cash, counted: 0 }, { payment_method_id: card, counted: 0 }], force: true });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const none = await api(A, 'POST', '/api/pos/offline-orders', sale());
    assert.equal(none.status, 409);
    assert.equal(none.body.code, 'CASH_SESSION_CLOSED');

    const next = (await api(A, 'POST', '/api/pos/cash-sessions/open', { branch_id: branch.id, terminal: 'Barra', opening_cash: 0 })).body.session;
    const r = await api(A, 'POST', '/api/pos/offline-orders', sale());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const detail = (await api(A, 'GET', `/api/pos/cash-sessions/${next.id}`)).body;
    assert.equal(detail.cut.orders_count, 1);
    session = next;
  });

  test('otro restaurante no puede usar productos ni turnos ajenos', async () => {
    const bBranch = (await api(B, 'GET', '/api/branches')).body.branches[0];
    const bCash = (await api(B, 'GET', '/api/pos/payment-methods')).body.payment_methods.find((m) => m.kind === 'efectivo').id;
    await api(B, 'POST', '/api/pos/cash-sessions/open', { branch_id: bBranch.id, terminal: 'Caja 1', opening_cash: 0 });
    const r = await api(B, 'POST', '/api/pos/offline-orders', sale({
      branch_id: bBranch.id, payments: [{ payment_method_id: bCash, amount: 230 }],
    }));
    assert.equal(r.body.code, 'ITEM_NOT_FOUND');
  });
});
