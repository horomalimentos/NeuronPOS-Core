// Vales y codigos promocionales: en caja y en el checkout del portal, con
// minimo, usos maximos, producto gratis y canal; el uso cuenta al pagar.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));

describe('vales y codigos', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branchA; let agua; let taco; let session; let cash;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const order = async (items) => (await api(A, 'POST', '/api/pos/orders', { branch_id: branchA.id, order_type: 'para_llevar', items })).body.order;
  const apply = (o, code) => api(A, 'PUT', `/api/pos/orders/${o.id}/voucher`, { code });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal', 'promociones'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos', 'promociones'] });
    branchA = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Menu' })).body.category;
    agua = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Agua', price: 50 })).body.item;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    cash = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods.find((m) => m.kind === 'efectivo').id;
    session = (await api(A, 'POST', '/api/pos/cash-sessions/open', { branch_id: branchA.id, terminal: 'Caja 1', opening_cash: 0 })).body.session.id;
    await api(A, 'PUT', `/api/branches/${branchA.id}/hours`, { hours: ALL_DAY });
    await api(A, 'PATCH', '/api/online/settings', { enabled: true });
  });
  after(() => ctx?.close());

  test('alta de vales con validaciones', async () => {
    const v = await api(A, 'POST', '/api/pos/vouchers', { code: 'bienvenida', kind: 'monto', amount: 50, min_amount: 100, max_uses: 1 });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    assert.equal(v.body.voucher.code, 'BIENVENIDA');
    assert.equal((await api(A, 'POST', '/api/pos/vouchers', { code: 'BIENVENIDA', kind: 'monto', amount: 10 })).body.code, 'VOUCHER_EXISTS');
    assert.equal((await api(A, 'POST', '/api/pos/vouchers', { code: 'X1', kind: 'monto', amount: 10 })).status, 400, 'codigo corto');
    assert.equal((await api(A, 'POST', '/api/pos/vouchers', { code: 'SINPROD', kind: 'producto' })).body.code, 'INVALID_VOUCHER');
    assert.equal((await api(A, 'POST', '/api/pos/vouchers', { code: 'AGUAGRATIS', kind: 'producto', menu_item_id: agua.id })).status, 201);
    assert.equal((await api(A, 'POST', '/api/pos/vouchers', { code: 'WEB10', kind: 'porcentaje', percent: 10, applies_pos: false })).status, 201);
  });

  test('en caja: minimo, un solo uso y producto gratis', async () => {
    const chica = await order([{ menu_item_id: agua.id, quantity: 1 }]);
    assert.equal((await apply(chica, 'bienvenida')).body.code, 'VOUCHER_NOT_APPLICABLE', 'abajo del minimo');
    const o = await order([{ menu_item_id: agua.id, quantity: 2 }]);
    const ok = await apply(o, ' bienvenida ');
    assert.equal(Number(ok.body.order.voucher_discount), 50, JSON.stringify(ok.body));
    assert.equal(ok.body.order.voucher_code, 'BIENVENIDA');
    assert.equal(Number(ok.body.order.total), 50);
    assert.equal((await api(A, 'POST', `/api/pos/orders/${o.id}/payments`, { cash_session_id: session, payments: [{ payment_method_id: cash, amount: 50 }] })).body.order.status, 'pagada');
    const otra = await order([{ menu_item_id: taco.id, quantity: 1 }]);
    const used = await apply(otra, 'BIENVENIDA');
    assert.match(used.body.error, /ya se uso/);
    const list = (await api(A, 'GET', '/api/pos/vouchers')).body.vouchers;
    assert.equal(list.find((v) => v.code === 'BIENVENIDA').uses, 1);

    assert.match((await apply(otra, 'AGUAGRATIS')).body.error, /producto del vale/);
    await api(A, 'POST', `/api/pos/orders/${otra.id}/items`, { items: [{ menu_item_id: agua.id, quantity: 1 }] });
    const gratis = await apply(otra, 'AGUAGRATIS');
    assert.equal(Number(gratis.body.order.voucher_discount), 50);
    assert.equal(Number(gratis.body.order.total), 100);
    assert.match((await apply(otra, 'WEB10')).body.error, /pedidos en linea/);
    // Quitar el producto quita el vale.
    const aguaLine = gratis.body.order.items.find((i) => i.menu_item_id === agua.id);
    const sinAgua = await api(A, 'DELETE', `/api/pos/orders/${otra.id}/items/${aguaLine.id}`);
    assert.equal(Number(sinAgua.body.order.voucher_discount), 0);
    assert.equal(sinAgua.body.order.voucher_id, null);
    await api(A, 'POST', `/api/pos/orders/${otra.id}/cancel`, { reason: 'prueba' });
  });

  test('en el portal: el codigo se cotiza y se guarda en el pedido', async () => {
    const body = {
      branch_id: branchA.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 2 }],
      customer: { name: 'Clienta', phone: '656 123 4567' }, payment: { provider: 'contra_entrega', method: 'efectivo' },
    };
    const bad = await ctx.request('POST', '/api/portal/quote', { slug: 'alfa', body: { ...body, voucher_code: 'NOEXISTE' } });
    assert.equal(bad.body.code, 'VOUCHER_NOT_FOUND');
    const q = await ctx.request('POST', '/api/portal/quote', { slug: 'alfa', body: { ...body, voucher_code: 'web10' } });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.body.voucher, { code: 'WEB10', amount: 20 });
    assert.equal(Number(q.body.total), 180);
    const created = await ctx.request('POST', '/api/portal/orders', { slug: 'alfa', body: { ...body, voucher_code: 'web10' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(Number(created.body.order.total), 180);
  });

  test('B no usa los vales de A', async () => {
    const branchB = (await api(B, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(B, 'POST', '/api/pos/categories', { name: 'X' })).body.category;
    const it = (await api(B, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Y', price: 200 })).body.item;
    const o = (await api(B, 'POST', '/api/pos/orders', { branch_id: branchB.id, order_type: 'para_llevar', items: [{ menu_item_id: it.id, quantity: 1 }] })).body.order;
    assert.equal((await api(B, 'PUT', `/api/pos/orders/${o.id}/voucher`, { code: 'AGUAGRATIS' })).body.code, 'VOUCHER_NOT_FOUND');
    assert.equal((await api(B, 'GET', '/api/pos/vouchers')).body.vouchers.length, 0);
  });
});
