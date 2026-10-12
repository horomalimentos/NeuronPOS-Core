// Impuesto y ticket por sucursal (8 % en la frontera): las ordenes de caja y
// del portal usan la tasa de su sucursal; vacio vuelve a la del restaurante.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));

describe('impuesto por sucursal', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let juarez; let centro; let taco;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal'] });
    juarez = (await api(A, 'GET', '/api/branches')).body.branches[0];
    centro = (await api(A, 'POST', '/api/branches', { name: 'CDMX' })).body.branch;
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Menu' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    await api(A, 'PATCH', '/api/pos/settings', { tax_rate_pct: 16, prices_include_tax: false });
  });
  after(() => ctx?.close());

  test('la sucursal guarda su impuesto y su ticket', async () => {
    assert.equal((await api(A, 'PATCH', `/api/branches/${juarez.id}`, { tax_rate_pct: 120 })).status, 400);
    const r = await api(A, 'PATCH', `/api/branches/${juarez.id}`, { tax_rate_pct: 8, ticket_header: 'Tacos Alfa SA de CV\nRFC TAL010101AAA' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Number(r.body.branch.tax_rate_pct), 8);
    assert.match(r.body.branch.ticket_header, /RFC/);
    assert.equal(centro.tax_rate_pct, null);
  });

  test('las ordenes usan la tasa de su sucursal', async () => {
    const mk = async (branch) => (await api(A, 'POST', '/api/pos/orders', { branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }] })).body.order;
    const a = await mk(juarez);
    assert.deepEqual([Number(a.tax_rate_pct), Number(a.tax_amount), Number(a.total)], [8, 8, 108]);
    const b = await mk(centro);
    assert.deepEqual([Number(b.tax_rate_pct), Number(b.total)], [16, 116]);

    await api(A, 'PUT', `/api/branches/${juarez.id}/hours`, { hours: ALL_DAY });
    await api(A, 'PATCH', '/api/online/settings', { enabled: true });
    const q = await ctx.request('POST', '/api/portal/quote', { slug: 'alfa', body: {
      branch_id: juarez.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }],
      customer: { name: 'Ana', phone: '656 123 4567' }, payment: { provider: 'contra_entrega', method: 'efectivo' },
    } });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(Number(q.body.total), 108);

    // Vacio: vuelve a la del restaurante (las ordenes ya creadas conservan su tasa).
    assert.equal((await api(A, 'PATCH', `/api/branches/${juarez.id}`, { tax_rate_pct: '' })).body.branch.tax_rate_pct, null);
    assert.equal(Number((await mk(juarez)).total), 116);
    assert.equal(Number((await api(A, 'GET', `/api/pos/orders/${a.id}`)).body.order.total), 108);
  });
});
