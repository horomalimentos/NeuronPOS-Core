// Fase 2 de punta a punta contra Postgres: sitio web (landing), horarios,
// portal de clientes y pedidos en linea que llegan al POS.
//
// Cubre: aislamiento de clientes, pedidos y contenido entre restaurantes;
// tokens de cliente que no sirven en otro restaurante ni en rutas del
// personal (y al reves); modulos landing/portal/domicilios (402); precios
// manipulados por el cliente (se ignoran); pedidos con la sucursal cerrada;
// y el flujo pedido web -> aceptar -> cocina -> cobrar en caja.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { localParts } from '../services/hours.js';
import { PLATFORM_DOMAIN, SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));

describe('sitio web y pedidos en linea', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let C;
  let branchA; let branchB;
  let taco; let agua; let salsa; let itemB;
  let cajero; let cocina;
  let custA; let custA2; let custB;

  const hostA = `alfa.${PLATFORM_DOMAIN}`;
  const hostB = `beta.${PLATFORM_DOMAIN}`;
  const hostC = `gamma.${PLATFORM_DOMAIN}`;
  const staff = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  // Portal: el restaurante siempre por Host, como en produccion.
  const portal = (host, method, path, body, token) => ctx.request(method, `/api/portal${path}`, { host, body, token });
  const tacoLine = (extra = {}) => ({ menu_item_id: taco.id, quantity: 2, modifier_ids: [salsa.modifiers[1].id], ...extra });
  const pickup = (extra = {}) => ({
    branch_id: branchA.id, order_type: 'para_llevar', items: [tacoLine()],
    customer: { name: 'Invitada', phone: '656 123 4567' }, payment: { method: 'efectivo' }, ...extra,
  });

  async function addUser(role, email) {
    const password = 'clave-segura-9';
    const res = await staff(A, 'POST', '/api/users', { email, name: role, role, password, branch_ids: [branchA.id] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const login = await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email, password } });
    return { token: login.body.token };
  }

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'landing', 'portal', 'domicilios'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos', 'portal'] });
    C = await createRestaurant(ctx, owner, 'gamma', { modules: ['pos'] });
    branchA = (await staff(A, 'GET', '/api/branches')).body.branches[0];
    branchB = (await staff(B, 'GET', '/api/branches')).body.branches[0];
    await staff(A, 'PATCH', `/api/branches/${branchA.id}`, { address: 'Av. Juarez 100, Centro', phone: '6561112233' });
    cajero = await addUser('cajero', 'cajero@alfa.test');
    cocina = await addUser('cocina', 'cocina@alfa.test');

    const cat = (await staff(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    salsa = (await staff(A, 'POST', '/api/pos/modifier-groups', {
      name: 'Salsa', min_selections: 1, max_selections: 1, modifiers: [{ name: 'Verde' }, { name: 'Roja', price_delta: 5 }],
    })).body.group;
    taco = (await staff(A, 'POST', '/api/pos/items', {
      category_id: cat.id, name: 'Taco de asada', description: 'Tortilla de maiz', price: 100, modifier_group_ids: [salsa.id],
    })).body.item;
    agua = (await staff(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Agua', price: 30 })).body.item;
    const catB = (await staff(B, 'POST', '/api/pos/categories', { name: 'Bebidas' })).body.category;
    itemB = (await staff(B, 'POST', '/api/pos/items', { category_id: catB.id, name: 'Refresco', price: 25 })).body.item;

    for (const [who, branch] of [[A, branchA], [B, branchB]]) {
      const h = await staff(who, 'PUT', `/api/branches/${branch.id}/hours`, { hours: ALL_DAY });
      assert.equal(h.status, 200, JSON.stringify(h.body));
      const s = await staff(who, 'PATCH', '/api/online/settings', { enabled: true });
      assert.equal(s.status, 200, JSON.stringify(s.body));
    }
    await staff(A, 'PATCH', '/api/online/settings', { min_order: 50, prep_time_minutes: 25 });
    await staff(A, 'PUT', `/api/online/branches/${branchA.id}`, { delivery_fee: 40 });
  });
  after(() => ctx?.close());

  // -------------------------------------------------------------------------
  describe('sitio web (modulo landing)', () => {
    test('sin el modulo landing la pagina publica y su administracion responden 402', async () => {
      for (const host of [hostB, hostC]) {
        const res = await ctx.request('GET', '/api/public/landing', { host });
        assert.equal(res.status, 402, host);
        assert.equal(res.body.code, 'MODULE_NOT_ENABLED');
      }
      const admin = await staff(B, 'GET', '/api/website');
      assert.equal(admin.status, 402);
      const site = await ctx.request('GET', '/api/public/site', { host: hostC });
      assert.equal(site.status, 200);
      assert.deepEqual(site.body.modules, ['pos']);
      assert.equal(site.body.ordering, false);
      assert.equal(site.body.seo.title, 'Restaurante GAMMA');
    });

    test('landing: menu de muestra, sucursales con horario y boton de pedir', async () => {
      const res = await ctx.request('GET', '/api/public/landing', { host: hostA });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.restaurant.name, 'Restaurante ALFA');
      assert.equal(res.body.ordering, true);
      assert.deepEqual(res.body.menu.map((c) => c.name), ['Tacos']);
      assert.deepEqual(res.body.menu[0].items.map((i) => [i.name, Number(i.price)]), [['Agua', 30], ['Taco de asada', 100]]);
      const b = res.body.branches[0];
      assert.equal(b.open_now, true);
      assert.equal(b.hours.length, 7);
      assert.match(b.maps_url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Av\.%20Juarez/);
      assert.equal(b.delivery_fee, undefined, 'la landing no expone configuracion interna');
    });

    test('el admin edita el contenido, la galeria y el SEO', async () => {
      const bad = await staff(A, 'PATCH', '/api/website/content', { social_instagram: 'javascript:alert(1)' });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'INVALID_URL');
      assert.equal((await staff(A, 'PATCH', '/api/website/content', { color: 'rojo' })).status, 400);

      const ok = await staff(A, 'PATCH', '/api/website/content', {
        hero_title: 'Los mejores tacos', hero_image_url: 'https://cdn.example.com/hero.jpg',
        social_instagram: 'https://instagram.com/alfa', seo_title: 'Alfa Tacos | Juarez', seo_description: 'Tacos al carbon',
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.content.hero_title, 'Los mejores tacos');
      const cleared = await staff(A, 'PATCH', '/api/website/content', { hero_image_url: '' });
      assert.equal(cleared.body.content.hero_image_url, undefined);
      assert.equal(cleared.body.content.hero_title, 'Los mejores tacos');

      const img = await staff(A, 'POST', '/api/website/gallery', { image_url: 'https://cdn.example.com/1.jpg', caption: 'Terraza' });
      assert.equal(img.status, 201);
      const landing = await ctx.request('GET', '/api/public/landing', { host: hostA });
      assert.equal(landing.body.content.hero_title, 'Los mejores tacos');
      assert.deepEqual(landing.body.gallery.map((g) => g.caption), ['Terraza']);
      const site = await ctx.request('GET', '/api/public/site', { host: hostA });
      assert.deepEqual(site.body.seo, { title: 'Alfa Tacos | Juarez', description: 'Tacos al carbon' });

      // Otro restaurante no toca la galeria de A; un cajero no edita el sitio.
      await ctx.request('PUT', `/api/platform/restaurants/${B.id}/modules/landing`, { token: owner, body: { enabled: true } });
      assert.equal((await staff(B, 'DELETE', `/api/website/gallery/${img.body.image.id}`)).status, 404);
      assert.equal((await staff(B, 'GET', '/api/website')).body.gallery.length, 0);
      assert.equal((await staff(cajero, 'PATCH', '/api/website/content', { hero_title: 'x' })).status, 403);
      await ctx.request('PUT', `/api/platform/restaurants/${B.id}/modules/landing`, { token: owner, body: { enabled: false } });
    });

    test('horarios: validacion y aislamiento', async () => {
      const bad = await staff(A, 'PUT', `/api/branches/${branchA.id}/hours`, { hours: [{ weekday: 1, opens_at: '9am', closes_at: '10:00' }] });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'INVALID_HOURS');
      assert.equal((await staff(B, 'PUT', `/api/branches/${branchA.id}/hours`, { hours: [] })).status, 404);
      assert.equal((await staff(B, 'GET', `/api/branches/${branchA.id}/hours`)).status, 404);
      const mine = await staff(A, 'GET', `/api/branches/${branchA.id}/hours`);
      assert.equal(mine.body.hours.length, 7);
      assert.equal(mine.body.status.open, true);
    });
  });

  // -------------------------------------------------------------------------
  describe('portal: modulos y cuentas de clientes', () => {
    test('sin el modulo portal todo el portal responde 402', async () => {
      for (const [m, p] of [['GET', '/config'], ['GET', '/menu'], ['POST', '/auth/register'], ['POST', '/orders'], ['GET', '/track/abcdefghijklmnop1234']]) {
        const res = await portal(hostC, m, p, m === 'POST' ? {} : undefined);
        assert.equal(res.status, 402, `${m} ${p}`);
        assert.equal(res.body.code, 'MODULE_NOT_ENABLED');
      }
      assert.equal((await staff(C, 'GET', '/api/online/settings')).status, 402);
      assert.equal((await ctx.request('GET', '/api/portal/config')).status, 404, 'sin restaurante');
    });

    test('config y menu publicos por sucursal', async () => {
      const cfg = await portal(hostA, 'GET', '/config');
      assert.equal(cfg.status, 200);
      assert.equal(cfg.body.ordering_available, true);
      assert.equal(cfg.body.settings.allow_delivery, true);
      assert.equal(Number(cfg.body.branches[0].delivery_fee), 40);
      assert.deepEqual(cfg.body.payment_options[0].methods.map((m) => m.code), ['efectivo', 'tarjeta']);
      // B no tiene el modulo domicilios: no ofrece envio.
      assert.equal((await portal(hostB, 'GET', '/config')).body.settings.allow_delivery, false);

      await staff(A, 'PUT', `/api/pos/items/${agua.id}/availability`, { branch_id: branchA.id, available: false });
      const menu = await portal(hostA, 'GET', `/menu?branch_id=${branchA.id}`);
      assert.equal(menu.status, 200);
      assert.equal(menu.body.items.find((i) => i.id === agua.id).available, false);
      assert.equal(menu.body.items[0].unavailable_branch_ids, undefined);
      assert.deepEqual(menu.body.modifier_groups.map((g) => g.name), ['Salsa']);
      assert.equal((await portal(hostB, 'GET', `/menu?branch_id=${branchA.id}`)).body.code, 'BRANCH_NOT_FOUND');
      assert.deepEqual((await portal(hostB, 'GET', '/menu')).body.items.map((i) => i.name), ['Refresco']);
    });

    test('registro y login por restaurante; el mismo correo son cuentas distintas', async () => {
      const reg = await portal(hostA, 'POST', '/auth/register', { name: 'Ana', email: 'ana@correo.mx', phone: '6561234567', password: 'clave-ana-1' });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
      custA = { token: reg.body.token, id: reg.body.customer.id };
      assert.equal(reg.body.customer.password_hash, undefined);
      const dup = await portal(hostA, 'POST', '/auth/register', { name: 'Ana 2', email: 'ANA@correo.mx', phone: '6561234567', password: 'otra-clave-1' });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.code, 'EMAIL_TAKEN');
      assert.equal((await portal(hostA, 'POST', '/auth/register', { name: 'X', email: 'x@correo.mx', phone: '12', password: 'clave-larga-1' })).body.code, 'INVALID_PHONE');
      assert.equal((await portal(hostA, 'POST', '/auth/register', { name: 'X', email: 'x@correo.mx', phone: '6560000000', password: 'corta' })).body.code, 'WEAK_PASSWORD');

      const regB = await portal(hostB, 'POST', '/auth/register', { name: 'Ana en B', email: 'ana@correo.mx', phone: '6561234567', password: 'clave-de-b-1' });
      assert.equal(regB.status, 201);
      custB = { token: regB.body.token, id: regB.body.customer.id };
      assert.notEqual(custB.id, custA.id);
      const reg2 = await portal(hostA, 'POST', '/auth/register', { name: 'Beto', email: 'beto@correo.mx', phone: '6567654321', password: 'clave-beto-1' });
      custA2 = { token: reg2.body.token, id: reg2.body.customer.id };

      assert.equal((await portal(hostA, 'POST', '/auth/login', { email: 'ana@correo.mx', password: 'clave-ana-1' })).status, 200);
      assert.equal((await portal(hostB, 'POST', '/auth/login', { email: 'ana@correo.mx', password: 'clave-ana-1' })).status, 401, 'la clave de A no sirve en B');
      assert.equal((await portal(hostC, 'POST', '/auth/login', { email: 'ana@correo.mx', password: 'clave-ana-1' })).status, 402);
    });

    test('tokens: cliente en otro restaurante, cliente en rutas del personal y al reves', async () => {
      const cross = await portal(hostB, 'GET', '/me', undefined, custA.token);
      assert.equal(cross.status, 403);
      assert.equal(cross.body.code, 'TENANT_MISMATCH');
      assert.equal((await portal(hostA, 'GET', '/me', undefined, custA.token)).body.customer.name, 'Ana');

      // Token de cliente en rutas del personal y de la plataforma.
      for (const path of ['/api/me', '/api/pos/menu', '/api/branches', '/api/website', '/api/online/settings']) {
        const r = await ctx.request('GET', path, { host: hostA, token: custA.token });
        assert.equal(r.status, 401, path);
      }
      assert.equal((await ctx.request('GET', '/api/platform/restaurants', { token: custA.token })).status, 401);
      // Token del personal y de la plataforma en el portal de clientes.
      for (const token of [A.token, owner]) {
        const r = await portal(hostA, 'GET', '/me', undefined, token);
        assert.equal(r.status, 401);
        assert.equal(r.body.code, 'INVALID_TOKEN');
      }
    });

    test('perfil y direcciones: cada cliente solo ve y edita las suyas', async () => {
      const addr = await portal(hostA, 'POST', '/me/addresses', { label: 'Casa', address: 'Calle Uno 123', reference: 'Porton negro' }, custA.token);
      assert.equal(addr.status, 201);
      custA.address = addr.body.address;
      assert.equal((await portal(hostA, 'PATCH', `/me/addresses/${custA.address.id}`, { label: 'Hack' }, custA2.token)).status, 404);
      assert.equal((await portal(hostA, 'DELETE', `/me/addresses/${custA.address.id}`, undefined, custA2.token)).status, 404);
      assert.deepEqual((await portal(hostA, 'GET', '/me', undefined, custA2.token)).body.addresses, []);
      const me = await portal(hostA, 'PATCH', '/me', { phone: '656 999 8888' }, custA.token);
      assert.equal(me.body.customer.phone, '656 999 8888');
      const wrong = await portal(hostA, 'PATCH', '/me', { password: 'nueva-clave-1', current_password: 'mal' }, custA.token);
      assert.equal(wrong.body.code, 'INVALID_CREDENTIALS');
    });

    test('RLS: clientes y direcciones nunca se cruzan', async () => {
      const none = await ctx.pool.query('SELECT count(*)::int AS n FROM customers');
      assert.equal(none.rows[0].n, 0, 'sin contexto no se ve nada');
      const ids = await ctx.withTenant(B.id, async (db) => (await db.query('SELECT id FROM customers')).rows.map((r) => r.id));
      assert.deepEqual(ids, [custB.id]);
      await assert.rejects(
        ctx.withTenant(B.id, (db) => db.query(
          "INSERT INTO customer_addresses (restaurant_id, customer_id, address) VALUES ($1, $2, 'x')", [A.id, custA.id],
        )),
        /row-level security/,
      );
      const cnt = await ctx.withTenant(B.id, async (db) => (await db.query('SELECT count(*)::int AS n FROM site_gallery')).rows[0].n);
      assert.equal(cnt, 0);
    });
  });

  // -------------------------------------------------------------------------
  describe('pedidos en linea', () => {
    let session;

    test('precios manipulados por el cliente se ignoran (cotizacion y pedido)', async () => {
      const tampered = pickup({
        items: [tacoLine({ price: 1, unit_price: 1, line_total: 1, modifiers: [{ id: salsa.modifiers[1].id, price_delta: -100 }] })],
        subtotal: 1, total: 1, delivery_fee: 0, tax_amount: 0,
      });
      const quote = await portal(hostA, 'POST', '/quote', tampered);
      assert.equal(quote.status, 200, JSON.stringify(quote.body));
      assert.equal(quote.body.subtotal, 210); // 2 x (100 + 5)
      assert.equal(quote.body.total, 210);
      assert.equal(quote.body.tax_amount, 28.97);

      const dom = await portal(hostA, 'POST', '/quote', {
        ...tampered, order_type: 'domicilio', address: { address: 'Calle 2' },
      });
      assert.equal(dom.body.delivery_fee, 40);
      assert.equal(dom.body.total, 250);
    });

    test('validaciones del menu: modificadores, disponibilidad, otro restaurante y minimo', async () => {
      const noMods = await portal(hostA, 'POST', '/orders', pickup({ items: [{ menu_item_id: taco.id }] }));
      assert.equal(noMods.body.code, 'MODIFIERS_REQUIRED');
      const two = await portal(hostA, 'POST', '/orders', pickup({ items: [tacoLine({ modifier_ids: salsa.modifiers.map((m) => m.id) })] }));
      assert.equal(two.body.code, 'MODIFIERS_EXCEEDED');
      const unavailable = await portal(hostA, 'POST', '/orders', pickup({ items: [{ menu_item_id: agua.id, quantity: 3 }] }));
      assert.equal(unavailable.body.code, 'ITEM_UNAVAILABLE');
      await staff(A, 'PUT', `/api/pos/items/${agua.id}/availability`, { branch_id: branchA.id, available: true });
      const fromB = await portal(hostA, 'POST', '/orders', pickup({ items: [{ menu_item_id: itemB.id }] }));
      assert.equal(fromB.body.code, 'ITEM_NOT_FOUND');
      const otherBranch = await portal(hostA, 'POST', '/orders', pickup({ branch_id: branchB.id }));
      assert.equal(otherBranch.body.code, 'BRANCH_NOT_FOUND');
      const min = await portal(hostA, 'POST', '/orders', pickup({ items: [{ menu_item_id: agua.id }] }));
      assert.equal(min.status, 400);
      assert.equal(min.body.code, 'BELOW_MIN_ORDER');
      const guest = await portal(hostA, 'POST', '/orders', pickup({ customer: { name: 'Sin telefono' } }));
      assert.equal(guest.body.code, 'CUSTOMER_REQUIRED');
    });

    test('domicilio requiere el modulo domicilios (402) y direccion', async () => {
      const res = await portal(hostB, 'POST', '/orders', {
        branch_id: branchB.id, order_type: 'domicilio', items: [{ menu_item_id: itemB.id }],
        customer: { name: 'Ana', phone: '6561234567' }, address: { address: 'Calle 1' },
      });
      assert.equal(res.status, 402);
      assert.equal(res.body.code, 'MODULE_NOT_ENABLED');
      const noAddr = await portal(hostA, 'POST', '/orders', pickup({ order_type: 'domicilio' }));
      assert.equal(noAddr.body.code, 'ADDRESS_REQUIRED');
      const foreign = await portal(hostA, 'POST', '/orders', pickup({ order_type: 'domicilio', address_id: custA.address.id }), custA2.token);
      assert.equal(foreign.status, 404, 'no puede usar la direccion de otro cliente');
    });

    test('con la sucursal cerrada o los pedidos apagados no se aceptan pedidos', async () => {
      const today = localParts(new Date(), branchA.timezone).date;
      await staff(A, 'PUT', `/api/branches/${branchA.id}/hours`, { hours: ALL_DAY, closures: [{ closed_on: today, reason: 'Inventario' }] });
      const closed = await portal(hostA, 'POST', '/orders', pickup());
      assert.equal(closed.status, 409);
      assert.equal(closed.body.code, 'BRANCH_CLOSED');
      const cfg = await portal(hostA, 'GET', '/config');
      assert.equal(cfg.body.branches[0].open_now, false);
      assert.equal(cfg.body.branches[0].closed_today, true);

      await staff(A, 'PUT', `/api/branches/${branchA.id}/hours`, { hours: [], closures: [] });
      assert.equal((await portal(hostA, 'POST', '/orders', pickup())).body.code, 'BRANCH_CLOSED', 'sin horario = cerrado');
      await staff(A, 'PUT', `/api/branches/${branchA.id}/hours`, { hours: ALL_DAY });

      await staff(A, 'PATCH', '/api/online/settings', { enabled: false });
      const off = await portal(hostA, 'POST', '/orders', pickup());
      assert.equal(off.status, 409);
      assert.equal(off.body.code, 'ONLINE_ORDERS_DISABLED');
      assert.equal((await ctx.request('GET', '/api/public/site', { host: hostA })).body.ordering, false);
      await staff(A, 'PATCH', '/api/online/settings', { enabled: true });

      await staff(A, 'PUT', `/api/online/branches/${branchA.id}`, { online_enabled: false });
      assert.equal((await portal(hostA, 'POST', '/orders', pickup())).body.code, 'BRANCH_NOT_ACCEPTING');
      await staff(A, 'PUT', `/api/online/branches/${branchA.id}`, { online_enabled: true });
    });

    test('flujo completo: pedido de invitado -> aceptar -> cocina -> lista -> cobrar en caja', async () => {
      const created = await portal(hostA, 'POST', '/orders', pickup({ notes: 'Sin cebolla' }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const o = created.body.order;
      assert.equal(o.status, 'recibido');
      assert.equal(Number(o.total), 210);
      assert.match(o.token, /^[A-Za-z0-9_-]{24}$/);
      assert.equal(created.body.payment.action, 'none');

      // En el POS: no esta en "activas" ni en cocina hasta aceptarlo.
      const active = await staff(cajero, 'GET', `/api/pos/orders?branch_id=${branchA.id}`);
      assert.ok(!active.body.orders.some((x) => x.id === o.id));
      const online = await staff(cajero, 'GET', `/api/pos/online-orders?branch_id=${branchA.id}&status=pendientes`);
      assert.equal(online.body.pending_count, 1);
      assert.equal(online.body.orders[0].id, o.id);
      assert.equal(online.body.orders[0].items[0].modifiers[0].name, 'Roja');
      assert.equal((await staff(cocina, 'GET', `/api/pos/kitchen?branch_id=${branchA.id}`)).body.orders.length, 0);

      const open = await staff(cajero, 'POST', '/api/pos/cash-sessions/open', { branch_id: branchA.id, opening_cash: 100 });
      session = open.body.session;
      const efectivo = (await staff(cajero, 'GET', '/api/pos/payment-methods')).body.payment_methods.find((m) => m.kind === 'efectivo');
      const early = await staff(cajero, 'POST', `/api/pos/orders/${o.id}/payments`, {
        cash_session_id: session.id, payments: [{ payment_method_id: efectivo.id, amount: 210 }],
      });
      assert.equal(early.body.code, 'ONLINE_ORDER_PENDING');
      assert.equal((await staff(cajero, 'POST', `/api/pos/orders/${o.id}/send`)).body.code, 'ONLINE_ORDER_PENDING');

      assert.equal((await staff(cocina, 'POST', `/api/pos/online-orders/${o.id}/accept`)).status, 403, 'cocina no acepta pedidos');
      const accepted = await staff(cajero, 'POST', `/api/pos/online-orders/${o.id}/accept`);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.equal(accepted.body.order.status, 'enviada');
      assert.equal(accepted.body.order.source, 'web');
      assert.equal((await staff(cajero, 'POST', `/api/pos/online-orders/${o.id}/accept`)).body.code, 'ALREADY_ACCEPTED');

      let track = await portal(hostA, 'GET', `/track/${o.token}`);
      assert.equal(track.body.order.status, 'preparando');
      assert.ok(track.body.order.estimated_ready_at);
      const minutes = (new Date(track.body.order.estimated_ready_at) - new Date(track.body.order.accepted_at)) / 60000;
      assert.equal(Math.round(minutes), 25);

      const kds = await staff(cocina, 'GET', `/api/pos/kitchen?branch_id=${branchA.id}`);
      assert.deepEqual(kds.body.orders.map((x) => x.id), [o.id]);
      assert.equal(kds.body.orders[0].notes, 'Sin cebolla');
      await staff(cocina, 'POST', `/api/pos/orders/${o.id}/ready`);
      track = await portal(hostA, 'GET', `/track/${o.token}`);
      assert.equal(track.body.order.status, 'listo');
      assert.equal(track.body.order.status_label, 'Listo para recoger');

      const paid = await staff(cajero, 'POST', `/api/pos/orders/${o.id}/payments`, {
        cash_session_id: session.id, payments: [{ payment_method_id: efectivo.id, amount: 210, received: 300 }],
      });
      assert.equal(paid.status, 201, JSON.stringify(paid.body));
      assert.equal(paid.body.change, 90);
      track = await portal(hostA, 'GET', `/track/${o.token}`);
      assert.equal(track.body.order.status, 'entregado');
      assert.equal(track.body.order.paid, true);

      const cut = await staff(cajero, 'GET', `/api/pos/cash-sessions/${session.id}`);
      assert.equal(cut.body.cut.total_sales, 210);
    });

    test('cliente con cuenta: domicilio con direccion guardada, rechazo con motivo e historial', async () => {
      const created = await portal(hostA, 'POST', '/orders', {
        branch_id: branchA.id, order_type: 'domicilio', items: [tacoLine({ quantity: 1 }), { menu_item_id: agua.id }],
        address_id: custA.address.id, payment: { method: 'efectivo', pay_with: 500 },
      }, custA.token);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const o = created.body.order;
      assert.equal(o.customer_name, 'Ana');
      assert.equal(o.customer_address, 'Calle Uno 123');
      assert.equal(o.delivery_reference, 'Porton negro');
      assert.equal(Number(o.delivery_fee), 40);
      assert.equal(Number(o.total), 175); // 105 + 30 + 40
      assert.equal(Number(o.pay_with), 500);

      const short = await portal(hostA, 'POST', '/quote', {
        branch_id: branchA.id, order_type: 'para_llevar', items: [tacoLine()], payment: { method: 'efectivo', pay_with: 100 },
      }, custA.token);
      assert.equal(short.body.code, 'INVALID_PAYMENT');

      assert.equal((await staff(cajero, 'POST', `/api/pos/online-orders/${o.id}/reject`, {})).body.code, 'MISSING_FIELD');
      const rejected = await staff(cajero, 'POST', `/api/pos/online-orders/${o.id}/reject`, { reason: 'Sin repartidores por la lluvia' });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.order.status, 'cancelada');
      assert.equal(rejected.body.order.online_status, 'rechazada');

      const mine = await portal(hostA, 'GET', `/orders/${o.id}`, undefined, custA.token);
      assert.equal(mine.body.order.status, 'rechazado');
      assert.equal(mine.body.order.cancel_reason, 'Sin repartidores por la lluvia');
      const history = await portal(hostA, 'GET', '/orders', undefined, custA.token);
      assert.deepEqual(history.body.orders.map((x) => x.id), [o.id]);
      // Otro cliente del mismo restaurante no lo ve.
      assert.equal((await portal(hostA, 'GET', `/orders/${o.id}`, undefined, custA2.token)).status, 404);
      assert.deepEqual((await portal(hostA, 'GET', '/orders', undefined, custA2.token)).body.orders, []);
    });

    test('domicilio: en camino y entregado al cobrar; el cliente cancela solo antes de aceptar', async () => {
      const created = await portal(hostA, 'POST', '/orders', pickup({
        order_type: 'domicilio', address: { address: 'Calle Dos 45', reference: 'Casa azul' }, save_address: true,
      }), custA2.token);
      const o = created.body.order;
      assert.equal((await portal(hostA, 'GET', '/me', undefined, custA2.token)).body.addresses[0].address, 'Calle Dos 45');
      assert.equal((await staff(cajero, 'POST', `/api/pos/online-orders/${o.id}/dispatch`)).body.code, 'ONLINE_ORDER_PENDING');
      await staff(cajero, 'POST', `/api/pos/online-orders/${o.id}/accept`, { prep_time_minutes: 40 });
      assert.equal((await portal(hostA, 'POST', `/track/${o.token}/cancel`)).body.code, 'CANNOT_CANCEL');
      await staff(cocina, 'POST', `/api/pos/orders/${o.id}/ready`);
      assert.equal((await portal(hostA, 'GET', `/track/${o.token}`)).body.order.status, 'listo');
      await staff(cajero, 'POST', `/api/pos/online-orders/${o.id}/dispatch`);
      assert.equal((await portal(hostA, 'GET', `/track/${o.token}`)).body.order.status, 'en_camino');
      const tarjeta = (await staff(cajero, 'GET', '/api/pos/payment-methods')).body.payment_methods.find((m) => m.kind === 'tarjeta');
      const paid = await staff(cajero, 'POST', `/api/pos/orders/${o.id}/payments`, {
        cash_session_id: session.id, payments: [{ payment_method_id: tarjeta.id, amount: 250 }],
      });
      assert.equal(paid.status, 201, JSON.stringify(paid.body));
      assert.equal((await portal(hostA, 'GET', `/track/${o.token}`)).body.order.status, 'entregado');

      const other = (await portal(hostA, 'POST', '/orders', pickup())).body.order;
      const cancelled = await portal(hostA, 'POST', `/track/${other.token}/cancel`);
      assert.equal(cancelled.body.order.status, 'cancelado');
      const list = await staff(cajero, 'GET', `/api/pos/online-orders?branch_id=${branchA.id}&status=pendientes`);
      assert.equal(list.body.pending_count, 0);
    });

    test('aceptacion automatica: el pedido entra directo a cocina', async () => {
      await staff(A, 'PATCH', '/api/online/settings', { auto_accept: true });
      const o = (await portal(hostA, 'POST', '/orders', pickup())).body.order;
      assert.equal(o.status, 'preparando');
      const kds = await staff(cocina, 'GET', `/api/pos/kitchen?branch_id=${branchA.id}`);
      assert.ok(kds.body.orders.some((x) => x.id === o.id));
      await staff(A, 'PATCH', '/api/online/settings', { auto_accept: false });
      await staff(A, 'POST', `/api/pos/orders/${o.id}/cancel`, { reason: 'prueba' });
    });

    test('aislamiento: B no ve, acepta ni rastrea pedidos de A', async () => {
      const o = (await portal(hostA, 'POST', '/orders', pickup())).body.order;
      const listB = await staff(B, 'GET', `/api/pos/online-orders?branch_id=${branchA.id}&status=todas`);
      assert.deepEqual(listB.body.orders, []);
      assert.equal((await staff(B, 'POST', `/api/pos/online-orders/${o.id}/accept`)).status, 404);
      assert.equal((await staff(B, 'POST', `/api/pos/online-orders/${o.id}/reject`, { reason: 'x' })).status, 404);
      assert.equal((await portal(hostB, 'GET', `/track/${o.token}`)).status, 404);
      assert.equal((await portal(hostB, 'GET', `/orders/${o.id}`, undefined, custA.token)).status, 403);
      assert.equal((await portal(hostB, 'GET', `/orders/${o.id}`, undefined, custB.token)).status, 404);
      assert.equal((await portal(hostA, 'GET', '/track/no-existe-este-token-123')).status, 404);

      const webB = await ctx.withTenant(B.id, async (db) => (await db.query("SELECT count(*)::int AS n FROM orders WHERE source = 'web'")).rows[0].n);
      assert.equal(webB, 0);
      const webA = await ctx.withTenant(A.id, async (db) => (await db.query("SELECT count(*)::int AS n FROM orders WHERE source = 'web'")).rows[0].n);
      assert.ok(webA >= 5);
      await staff(A, 'POST', `/api/pos/online-orders/${o.id}/reject`, { reason: 'prueba' });
    });

    test('borrar un restaurante borra sus clientes, sitio y pedidos', async () => {
      const res = await ctx.request('DELETE', `/api/platform/restaurants/${A.id}?confirm=alfa`, { token: owner });
      assert.equal(res.status, 204, JSON.stringify(res.body));
      const n = await ctx.withPlatform(async (db) => (await db.query(
        `SELECT (SELECT count(*) FROM customers WHERE restaurant_id = $1) + (SELECT count(*) FROM site_gallery WHERE restaurant_id = $1)
              + (SELECT count(*) FROM orders WHERE restaurant_id = $1) AS n`, [A.id],
      )).rows[0].n);
      assert.equal(Number(n), 0);
    });
  });
});
