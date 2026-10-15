// Restaurante de Nayo conectado a su propio POS (Horom) contra Postgres y un
// POS externo simulado. Cubre: el menu se copia con sus ids, precios,
// extras y disponibilidad (y lo que desaparece alla queda inactivo aqui);
// el pedido de Nayo se reenvia con los ids de alla, solo una vez, y queda
// aceptado; listo/cancelado alla se refleja aqui; un POS cerrado rechaza el
// pedido; la conexion es solo de la plataforma (RLS).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SKIP_DB, ownerToken, setupDb, nayoShopper } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const CENTRO = { latitude: 31.7389, longitude: -106.4870 };
const CERCA = { latitude: 31.7569, longitude: -106.4870 };
const HOROM_BRANCH = '52132a6d-9e53-490f-ad45-62bbfd674e0d';

/** POS externo simulado: menu publico + entrada de pedidos de Nayo. */
function fakeHorom() {
  const state = {
    categories: [{ id: 'cat-rollos', name: 'Rollos', description: null, display_order: 1 }],
    items: [
      { id: 'item-california', name: 'California', description: 'Pepino y aguacate', category_id: 'cat-rollos', price: 120, is_available: true, active_override: null, display_image_url: '/uploads/california.jpg' },
      { id: 'item-tempura', name: 'Tempura', description: null, category_id: 'cat-rollos', price: 140, is_available: true, active_override: null, display_image_url: null },
    ],
    modifiers: {
      'item-california': [{
        modifier_group_id: 'g-salsa', modifier_group_name: 'Salsa', is_required: true, min_selections: 0, max_selections: null,
        selection_type: 'single', modifiers: [{ id: 'm-anguila', name: 'Anguila', price_adjustment: 0 }, { id: 'm-spicy', name: 'Spicy', price_adjustment: 10 }],
      }],
      'item-tempura': [],
    },
    orders: new Map(),
    received: [],
    closed: false,
    keys: [],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/web/menu/categories') return send(200, state.categories);
      if (url.pathname === '/api/web/menu/items') return send(200, state.items);
      const mods = url.pathname.match(/^\/api\/web\/menu\/items\/([^/]+)\/modifiers$/);
      if (mods) return send(200, state.modifiers[mods[1]] || []);
      if (url.pathname === '/api/integrations/nayo/orders' && req.method === 'POST') {
        state.keys.push(req.headers['x-integration-key']);
        if (state.closed) return send(409, { error: 'La tienda está cerrada actualmente', code: 'STORE_CLOSED' });
        const b = JSON.parse(body);
        state.received.push(b);
        const existing = state.orders.get(b.nayo_order_id);
        if (existing) return send(200, existing);
        const o = { order_id: `horom-${state.orders.size + 1}`, order_number: String(1000 + state.orders.size), ready: false, cancelled: false };
        state.orders.set(b.nayo_order_id, o);
        return send(201, o);
      }
      const st = url.pathname.match(/^\/api\/integrations\/nayo\/orders\/([^/]+)$/);
      if (st) {
        const o = state.orders.get(st[1]);
        return o ? send(200, o) : send(404, { error: 'No existe' });
      }
      return send(404, { error: 'ruta' });
    });
  });
  return { state, server };
}

describe('Nayo: restaurante conectado a su propio POS', { skip: SKIP_DB }, () => {
  let ctx; let owner; let R; let branchId; let shopper; let horom; let pos;
  const api = (token, method, path, body) => ctx.request(method, path, { token, body });

  before(async () => {
    ctx = await setupDb();
    pos = await import('../services/externalPos.js');
    horom = fakeHorom();
    horom.server.listen(0);
    await new Promise((r) => horom.server.once('listening', r));
    process.env.EXTERNAL_POS_KEY_HOROM = 'clave-compartida';

    owner = await ownerToken(ctx);
    shopper = await nayoShopper(ctx, { name: 'Maria Lopez', email: 'maria@cliente.test', phone: '6561234567', password: 'clave-cliente-1' });
    const r = await ctx.request('POST', '/api/marketplace/restaurants', {
      body: {
        name: 'Horom', phone: '6561112222', address: 'Zapata', location: CENTRO,
        admin: { name: 'Alex', email: 'alex@horom.test', password: 'clave-segura-1' },
      },
    });
    const login = await ctx.request('POST', '/api/auth/login', { slug: r.body.restaurant.slug, body: { email: 'alex@horom.test', password: 'clave-segura-1' } });
    R = { id: r.body.restaurant.id, token: login.body.token };
    branchId = (await api(R.token, 'GET', '/api/marketplace/listings')).body.listings[0].branch_id;
    await api(R.token, 'PUT', `/api/branches/${branchId}/hours`, { hours: ALL_DAY });
    await ctx.withPlatform((db) => db.query(
      `INSERT INTO external_pos_links (restaurant_id, branch_id, provider, base_url, public_url, external_branch_id)
       VALUES ($1, $2, 'horom', $3, 'https://horomsushi.test', $4)`,
      [R.id, branchId, `http://127.0.0.1:${horom.server.address().port}`, HOROM_BRANCH],
    ));
    // Publicar pide menu: primero se copia del POS.
    await pos.syncExternalMenus();
    const pubd = await api(R.token, 'PUT', `/api/marketplace/listings/${branchId}`, { published: true, min_order: 0, cuisine: 'Sushi' });
    assert.equal(pubd.status, 200, JSON.stringify(pubd.body));
    const ok = await ctx.request('POST', `/api/platform/marketplace/listings/${branchId}/approval`, { token: owner, body: { status: 'aprobado' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const d = await ctx.request('POST', '/api/marketplace/drivers', {
      body: { name: 'Juan', email: 'juan@moto.test', password: 'clave-segura-7', phone: '6560000000', vehicle: 'Moto', base: CERCA, radius_km: 4 },
    });
    await ctx.request('POST', `/api/platform/marketplace/drivers/${d.body.driver.id}/review`, { token: owner, body: { status: 'aprobado' } });
    await ctx.request('POST', '/api/fleet/duty', { token: d.body.token, body: { on_duty: true } });

  });
  after(async () => {
    await new Promise((r) => horom?.server.close(r));
    await ctx?.close();
  });

  const menu = async () => (await ctx.request('GET', `/api/marketplace/restaurants/${branchId}?lat=${CERCA.latitude}&lng=${CERCA.longitude}`)).body;
  const buy = (body) => ctx.request('POST', '/api/marketplace/orders', { token: shopper, body });
  const marketplaceOrder = async (id) => (await ctx.withPlatform((db) => db.query('SELECT * FROM marketplace_orders WHERE id = $1', [id]))).rows[0];

  test('la conexion solo la ve la plataforma', async () => {
    const rows = await ctx.withTenant(R.id, (db) => db.query('SELECT * FROM external_pos_links'));
    assert.equal(rows.rowCount, 0);
  });

  test('copia el menu con precios, extras y fotos', async () => {
    const [res] = await pos.syncExternalMenus();
    assert.deepEqual(res, { restaurant_id: R.id, categories: 1, items: 2, groups: 1 });
    const m = await menu();
    assert.deepEqual(m.items.map((i) => [i.name, Number(i.price)]).sort(), [['California', 120], ['Tempura', 140]]);
    const california = m.items.find((i) => i.name === 'California');
    assert.equal(california.image_url, 'https://horomsushi.test/uploads/california.jpg');
    const g = m.modifier_groups.find((x) => x.name === 'Salsa');
    assert.equal(g.min_selections, 1);
    assert.equal(g.max_selections, 1);
    assert.deepEqual(g.modifiers.map((x) => [x.name, Number(x.price_delta)]), [['Anguila', 0], ['Spicy', 10]]);
    // Idempotente: otra vuelta no duplica nada.
    await pos.syncExternalMenus();
    assert.equal((await menu()).items.length, 2);
  });

  test('lo agotado o quitado alla queda inactivo aqui', async () => {
    horom.state.items[1].is_available = false;
    await pos.syncExternalMenus();
    assert.deepEqual((await menu()).items.map((i) => i.name), ['California']);
    horom.state.items[1].is_available = true;
    await pos.syncExternalMenus();
    assert.equal((await menu()).items.length, 2);
  });

  test('el pedido de Nayo llega al POS con sus ids, una sola vez, y queda aceptado; listo alla = listo aqui', async () => {
    const m = await menu();
    const california = m.items.find((i) => i.name === 'California');
    const spicy = m.modifier_groups.find((x) => x.name === 'Salsa').modifiers.find((x) => x.name === 'Spicy');
    const res = await buy({
      branch_id: branchId,
      items: [{ menu_item_id: california.id, quantity: 2, modifier_ids: [spicy.id], notes: 'Sin ajonjoli' }],
      location: CERCA,
      customer: { name: 'Maria Lopez', phone: '656 123 4567' },
      address: { address: 'Calle Uno 123', reference: 'Porton azul' },
      pay_with: 500,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = (await ctx.withPlatform((db) => db.query('SELECT id FROM marketplace_orders ORDER BY created_at DESC LIMIT 1'))).rows[0].id;

    const out = await pos.forwardExternalOrders();
    assert.deepEqual(out, [{ id, sent: true }]);
    assert.equal(horom.state.keys.at(-1), 'clave-compartida');
    const sent = horom.state.received.at(-1);
    assert.equal(sent.branch_id, HOROM_BRANCH);
    assert.equal(sent.nayo_order_id, id);
    assert.equal(sent.payment_method, 'efectivo');
    assert.equal(sent.paid, false);
    assert.equal(sent.food_total, 260);
    assert.deepEqual(sent.items, [{ menu_item_id: 'item-california', quantity: 2, notes: 'Sin ajonjoli', modifiers: [{ modifier_id: 'm-spicy' }] }]);

    let mo = await marketplaceOrder(id);
    assert.equal(mo.status, 'aceptado');
    assert.equal(mo.external_order_id, 'horom-1');
    assert.equal(mo.external_order_number, '1000');
    // No se manda dos veces.
    assert.deepEqual(await pos.forwardExternalOrders(), []);

    assert.deepEqual(await pos.pollExternalOrders(), []);
    horom.state.orders.get(id).ready = true;
    assert.deepEqual(await pos.pollExternalOrders(), [{ id, status: 'listo' }]);
    mo = await marketplaceOrder(id);
    assert.equal(mo.status, 'listo');
  });

  test('si el POS esta cerrado, el pedido se rechaza', async () => {
    horom.state.closed = true;
    const m = await menu();
    const tempura = m.items.find((i) => i.name === 'Tempura');
    const res = await buy({
      branch_id: branchId, items: [{ menu_item_id: tempura.id, quantity: 1 }], location: CERCA,
      customer: { name: 'Maria Lopez', phone: '656 123 4567' }, address: { address: 'Calle Uno 123' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const [out] = await pos.forwardExternalOrders();
    assert.equal(out.rejected, true);
    const mo = await marketplaceOrder(out.id);
    assert.equal(mo.status, 'rechazado');
    assert.equal(mo.cancel_reason, 'El restaurante esta cerrado en este momento');
    horom.state.closed = false;
  });

  test('cancelado alla = cancelado aqui', async () => {
    const m = await menu();
    const tempura = m.items.find((i) => i.name === 'Tempura');
    await buy({
      branch_id: branchId, items: [{ menu_item_id: tempura.id, quantity: 1 }], location: CERCA,
      customer: { name: 'Maria Lopez', phone: '656 123 4567' }, address: { address: 'Calle Uno 123' },
    });
    const [out] = await pos.forwardExternalOrders();
    assert.equal(out.sent, true);
    horom.state.orders.get(out.id).cancelled = true;
    await pos.pollExternalOrders();
    assert.equal((await marketplaceOrder(out.id)).status, 'rechazado');
  });
});
