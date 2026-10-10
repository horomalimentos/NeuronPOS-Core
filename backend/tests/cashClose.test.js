// Cierre de caja: si es la ultima caja abierta de la sucursal y quedan
// ordenes sin cobrar, avisa (OPEN_ORDERS) y pide confirmar.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('cierre de caja con ordenes abiertas', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let branch; let taco; let cash;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const open = async (terminal) => (await api(A, 'POST', '/api/pos/cash-sessions/open', { branch_id: branch.id, terminal, opening_cash: 0 })).body.session;
  const close = (s, extra = {}) => api(A, 'POST', `/api/pos/cash-sessions/${s.id}/close`, { counts: [{ payment_method_id: cash, counted: 0 }], ...extra });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'reportes'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Menu' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    cash = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods.find((m) => m.kind === 'efectivo').id;
  });
  after(() => ctx?.close());

  test('avisa solo al cerrar la ultima caja y permite confirmar', async () => {
    const c1 = await open('Caja 1');
    const c2 = await open('Barra');
    await api(A, 'POST', '/api/pos/orders', { branch_id: branch.id, order_type: 'para_llevar', customer_name: 'Ana', items: [{ menu_item_id: taco.id, quantity: 1 }] });
    assert.equal((await close(c1)).status, 200, 'queda otra caja abierta');
    const warn = await close(c2);
    assert.equal(warn.status, 409);
    assert.equal(warn.body.code, 'OPEN_ORDERS');
    assert.equal(warn.body.orders.length, 1);
    assert.equal(warn.body.orders[0].customer_name, 'Ana');
    const forced = await close(c2, { force: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.equal(forced.body.session.status, 'cerrada');
  });

  test('se guardan y salen en el corte y en reportes', async () => {
    const s = (await api(A, 'POST', '/api/pos/cash-sessions/open', { branch_id: branch.id, terminal: 'Caja 3', opening_cash: 500 })).body.session;
    assert.equal((await api(A, 'POST', `/api/pos/cash-sessions/${s.id}/movements`, { kind: 'salida', amount: 80, reason: 'Hielo', category: 'gasolina' })).status, 400);
    const m = await api(A, 'POST', `/api/pos/cash-sessions/${s.id}/movements`, { kind: 'salida', amount: 80, reason: 'Hielo', category: 'compras' });
    assert.equal(m.body.movement.category, 'compras');
    await api(A, 'POST', `/api/pos/cash-sessions/${s.id}/movements`, { kind: 'salida', amount: 20, reason: 'Algo' });
    const detail = (await api(A, 'GET', `/api/pos/cash-sessions/${s.id}`)).body;
    assert.deepEqual(detail.movements.map((x) => x.category), ['compras', 'otro']);
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const tmr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const rep = (await api(A, 'GET', `/api/pos/reports/sales?from=${yday}&to=${tmr}`)).body;
    assert.deepEqual(rep.cash_movements.map((x) => [x.category, Number(x.total)]), [['compras', 80], ['otro', 20]]);
  });
});
