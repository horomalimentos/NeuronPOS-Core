// NeuronPOS Delivery (fase 3) contra Postgres con Clip simulado: el
// repartidor y el dinero. Cubre: el repartidor ve los pedidos aceptados de
// su zona (sin datos del cliente), los toma (uno a la vez, gana el primero),
// recoge y entrega; efectivo -> adeudo de la parte de NeuronPOS del envio;
// con el adeudo en el tope ya no ve ni toma pedidos en efectivo; pedido con
// tarjeta: nace sin que el restaurante lo vea, Clip confirma (webhook) y
// llega al restaurante; al entregarlo se abona comida + su envio y eso cubre
// el adeudo; liga vencida cancela el pedido; pago de adeudo con Clip; el
// Panel registra pagos en efectivo y liquidaciones; el repartidor no puede
// escribir su cuenta.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClipMock } from './clipMock.js';
import { SKIP_DB, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const CENTRO = { latitude: 31.7389, longitude: -106.4870 };
const CERCA = { latitude: 31.7569, longitude: -106.4870 };
const OTRA_CIUDAD = { latitude: 32.5, longitude: -106.4870 };

describe('NeuronPOS Delivery: fase 3 (repartidor y dinero)', { skip: SKIP_DB }, () => {
  let ctx; let owner; let clip; let sign; let money; let R; let branchId; let taco;
  let juan; let pedro;
  const api = (token, method, path, body) => ctx.request(method, path, { token, body });
  const pub = (method, path, body) => ctx.request(method, `/api/marketplace${path}`, { body });
  const panel = (method, path, body) => api(owner, method, `/api/platform${path}`, body);
  const fleet = (d, method, path, body) => api(d.token, method, `/api/fleet${path}`, body);
  const orderBody = (extra = {}) => ({
    branch_id: branchId,
    items: [{ menu_item_id: taco.id, quantity: 4 }],
    location: CERCA,
    customer: { name: 'Maria Lopez', phone: '656 123 4567' },
    address: { address: 'Calle Uno 123, Centro' },
    ...extra,
  });
  const webhook = (checkoutId) => {
    const body = { payment_request_id: checkoutId, event_type: 'CHECKOUT_COMPLETED' };
    return ctx.request('POST', '/api/webhooks/clip/plataforma', {
      body, headers: { 'x-clip-signature': sign(JSON.stringify(body), 'plataforma-webhook-secret') },
    });
  };
  const restaurantOrders = async () => (await api(R.token, 'GET', '/api/marketplace/orders')).body.orders;
  const accept = async (token) => {
    const o = (await restaurantOrders()).find((x) => x.status === 'nuevo');
    assert.ok(o, `sin pedido nuevo para ${token}`);
    const r = await api(R.token, 'POST', `/api/marketplace/orders/${o.id}/accept`, { prep_minutes: 10 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return o.id;
  };
  const board = async (d) => (await fleet(d, 'GET', '/marketplace')).body;
  const step = (d, id, s) => fleet(d, 'POST', `/marketplace/orders/${id}/${s}`);
  const newDriver = async (name, email, base) => {
    const r = await pub('POST', '/drivers', { name, email, password: 'clave-segura-7', phone: '6560000000', vehicle: 'Moto', base, radius_km: 4 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await panel('POST', `/marketplace/drivers/${r.body.driver.id}/review`, { status: 'aprobado' });
    await api(r.body.token, 'POST', '/api/fleet/duty', { on_duty: true });
    return { id: r.body.driver.id, token: r.body.token };
  };

  before(async () => {
    ctx = await setupDb();
    const client = await import('../services/clip/client.js');
    ({ signClipBody: sign } = await import('../services/clip/status.js'));
    money = await import('../services/marketplaceMoney.js');
    clip = createClipMock();
    client.setClipTransport((req) => clip.transport(req));
    owner = await ownerToken(ctx);
    const r = await pub('POST', '/restaurants', {
      name: 'Tacos Pepa', phone: '6561112222', address: 'Av. Juarez 100', location: CENTRO,
      admin: { name: 'Pepa', email: 'pepa@tacos.test', password: 'clave-segura-1' },
    });
    const login = await ctx.request('POST', '/api/auth/login', { slug: r.body.restaurant.slug, body: { email: 'pepa@tacos.test', password: 'clave-segura-1' } });
    R = { id: r.body.restaurant.id, token: login.body.token };
    branchId = (await api(R.token, 'GET', '/api/marketplace/listings')).body.listings[0].branch_id;
    const cat = (await api(R.token, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(R.token, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco de asada', price: 25 })).body.item;
    await api(R.token, 'PUT', `/api/branches/${branchId}/hours`, { hours: ALL_DAY });
    await api(R.token, 'PUT', `/api/marketplace/listings/${branchId}`, { published: true });
    // Tope de adeudo bajo para probar el bloqueo: $10.
    await panel('PUT', '/marketplace/settings', { driver_debt_limit: 10 });
    juan = await newDriver('Juan', 'juan@moto.test', CERCA);
    pedro = await newDriver('Pedro', 'pedro@moto.test', CERCA);
  });
  after(() => ctx?.close());

  let cashId;
  test('efectivo: el repartidor ve el pedido de su zona, lo toma, recoge y entrega; queda el adeudo del 20 %', async () => {
    assert.equal((await pub('GET', '/info')).body.card_payments, true);
    const o = (await pub('POST', '/orders', orderBody({ pay_with: 200 }))).body.order;
    assert.equal(Number(o.total), 135); // 100 de comida + 35 de envio
    // Hasta que el restaurante acepta no se ofrece.
    assert.equal((await board(juan)).available.length, 0);
    cashId = await accept(o.token);

    const b = await board(juan);
    assert.equal(b.balance, 0);
    assert.equal(b.available.length, 1);
    const offer = b.available[0];
    assert.equal(offer.restaurant_name, 'Tacos Pepa');
    assert.equal(Number(offer.collect), 135);
    assert.equal(Number(offer.driver_share), 28);
    assert.equal(offer.customer_phone, undefined); // sin datos del cliente hasta tomarlo

    // Fuera de zona no lo ve.
    const lejos = await newDriver('Lalo', 'lalo@moto.test', OTRA_CIUDAD);
    assert.equal((await board(lejos)).available.length, 0);
    assert.equal((await step(lejos, cashId, 'take')).body.code, 'OUT_OF_ZONE');

    const take = await step(juan, cashId, 'take');
    assert.equal(take.status, 200, JSON.stringify(take.body));
    assert.equal(take.body.job.customer_phone, '656 123 4567');
    assert.equal(take.body.job.change, 65);
    assert.equal((await step(pedro, cashId, 'take')).body.code, 'ORDER_TAKEN');
    assert.equal((await board(pedro)).available.length, 0);
    assert.equal((await step(juan, cashId, 'deliver')).body.code, 'INVALID_TRANSITION');

    // Soltarlo lo regresa; otra vez tomarlo.
    assert.equal((await fleet(juan, 'POST', `/marketplace/orders/${cashId}/release`)).status, 204);
    assert.equal((await board(pedro)).available.length, 1);
    await step(juan, cashId, 'take');

    const up = await step(juan, cashId, 'pickup');
    assert.equal(up.body.job.status, 'en_camino');
    assert.equal((await pub('GET', `/orders/${o.token}`)).body.order.status, 'en_camino');
    const del = await step(juan, cashId, 'deliver');
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.job.status, 'entregado');
    assert.equal((await step(juan, cashId, 'deliver')).body.code, 'INVALID_TRANSITION');

    const after1 = await board(juan);
    assert.equal(after1.balance, -7);
    assert.equal(after1.today.deliveries, 1);
    assert.equal(Number(after1.today.earned), 28);
    const ledger = (await fleet(juan, 'GET', '/marketplace/ledger')).body;
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].kind, 'comision_efectivo');
  });

  test('con el adeudo en el tope ya no ve ni toma pedidos en efectivo', async () => {
    const o = (await pub('POST', '/orders', orderBody())).body.order;
    const id = await accept(o.token);
    await step(juan, id, 'take');
    await step(juan, id, 'pickup');
    await step(juan, id, 'deliver');
    const b = await board(juan);
    assert.equal(b.balance, -14);
    assert.equal(b.cash_blocked, true);

    await pub('POST', '/orders', orderBody());
    const id3 = await accept();
    assert.equal((await board(juan)).available.length, 0);
    assert.equal((await board(pedro)).available.length, 1);
    assert.equal((await step(juan, id3, 'take')).body.code, 'DEBT_LIMIT');
    await step(pedro, id3, 'take');
    await step(pedro, id3, 'pickup');
    await step(pedro, id3, 'deliver');
  });

  let cardToken;
  test('tarjeta: Clip confirma y el pedido llega al restaurante; al entregar se abona comida + envio y cubre el adeudo', async () => {
    const res = await pub('POST', '/orders', orderBody({ payment_method: 'tarjeta', pay_with: 500 }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const o = res.body.order;
    cardToken = o.token;
    assert.equal(o.status, 'pago_pendiente');
    assert.equal(o.pay_with, null);
    assert.match(o.payment_url, /^https:\/\/pago\.clip\.test\//);
    const chk = clip.lastCreated();
    assert.equal(chk.auth.startsWith('Basic '), true);
    assert.equal(chk.body.amount, 135);
    assert.match(JSON.stringify(chk.body), /delivery\/pedido\//);

    // El restaurante todavia no lo ve.
    assert.equal((await restaurantOrders()).some((x) => x.status === 'nuevo' || x.status === 'pago_pendiente'), false);
    const track = (await pub('GET', `/orders/${o.token}`)).body.order;
    assert.equal(track.status, 'pago_pendiente');
    assert.equal(track.payment_url, o.payment_url);

    const checkoutId = o.payment_url.split('/').pop();
    clip.pay(checkoutId);
    const w = await webhook(checkoutId);
    assert.equal(w.status, 200);
    assert.equal((await pub('GET', `/orders/${o.token}`)).body.order.status, 'nuevo');
    const ev = (await ctx.withPlatform((db) => db.query('SELECT matched FROM clip_webhook_events WHERE checkout_id = $1', [checkoutId]))).rows[0];
    assert.equal(ev.matched, true);

    const id = await accept(o.token);
    const offer = (await board(juan)).available.find((x) => x.id === id);
    assert.ok(offer, 'el bloqueado por adeudo si ve pedidos con tarjeta');
    assert.equal(Number(offer.collect), 0);
    await step(juan, id, 'take');
    await step(juan, id, 'pickup');
    await step(juan, id, 'deliver');
    // -14 + (100 de comida + 28 de su envio) = 114 a favor.
    const b = await board(juan);
    assert.equal(b.balance, 114);
    assert.equal(b.cash_blocked, false);
  });

  test('una liga que vence cancela el pedido; pagado despues de cancelar queda para reembolso', async () => {
    const o = (await pub('POST', '/orders', orderBody({ payment_method: 'tarjeta' }))).body.order;
    const checkoutId = o.payment_url.split('/').pop();
    clip.expire(checkoutId);
    await money.reconcilePendingMarketplaceCheckouts();
    const t = (await pub('GET', `/orders/${o.token}`)).body.order;
    assert.equal(t.status, 'cancelado');
    const order = (await ctx.withPlatform((db) => db.query(
      'SELECT o.status, o.online_payment_status FROM orders o JOIN marketplace_orders m ON m.order_id = o.id WHERE m.public_token = $1', [o.token],
    ))).rows[0];
    assert.deepEqual(order, { status: 'cancelada', online_payment_status: 'cancelado' });

    // Un pedido pagado que el restaurante rechaza aparece en "por reembolsar".
    const p = (await pub('POST', '/orders', orderBody({ payment_method: 'tarjeta' }))).body.order;
    const pid = p.payment_url.split('/').pop();
    clip.pay(pid);
    await money.reconcilePendingMarketplaceCheckouts();
    const n = (await restaurantOrders()).find((x) => x.status === 'nuevo');
    await api(R.token, 'POST', `/api/marketplace/orders/${n.id}/reject`, { reason: 'Sin gas' });
    const refunds = (await panel('GET', '/marketplace/orders?status=reembolsar')).body.orders;
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].refund_needed, true);
    assert.equal(refunds[0].clip_reference, `tx_${pid}`);
  });

  test('pago de adeudo con Clip y movimientos del Panel', async () => {
    // Pedro debe 7.
    assert.equal((await board(pedro)).balance, -7);
    assert.equal((await fleet(juan, 'POST', '/marketplace/pay-debt', {})).body.code, 'NO_DEBT');
    assert.equal((await fleet(pedro, 'POST', '/marketplace/pay-debt', { amount: 50 })).body.code, 'INVALID_AMOUNT');
    const link = await fleet(pedro, 'POST', '/marketplace/pay-debt', {});
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.equal(link.body.amount, 7);
    const id = link.body.payment_url.split('/').pop();
    clip.pay(id);
    await webhook(id);
    await webhook(id); // dos veces: se aplica una
    assert.equal((await board(pedro)).balance, 0);

    // Panel: saldos, liquidacion a Juan (114 a favor), validaciones.
    const balances = (await panel('GET', '/marketplace/balances')).body;
    assert.equal(balances.debt_limit, 10);
    assert.equal(Number(balances.drivers.find((d) => d.id === juan.id).balance), 114);
    assert.equal((await panel('POST', `/marketplace/drivers/${juan.id}/ledger`, { kind: 'liquidacion', amount: 200 })).body.code, 'INVALID_AMOUNT');
    assert.equal((await panel('POST', `/marketplace/drivers/${juan.id}/ledger`, { kind: 'pago_efectivo', amount: 5 })).body.code, 'INVALID_AMOUNT');
    assert.equal((await panel('POST', `/marketplace/drivers/${juan.id}/ledger`, { kind: 'ajuste', amount: -4 })).status, 400);
    const liq = await panel('POST', `/marketplace/drivers/${juan.id}/ledger`, { kind: 'liquidacion', amount: 114, note: 'Transferencia' });
    assert.equal(liq.status, 201, JSON.stringify(liq.body));
    assert.equal(Number(liq.body.entry.amount), -114);
    await panel('POST', `/marketplace/drivers/${juan.id}/ledger`, { kind: 'ajuste', amount: -4, note: 'Bolsa termica' });
    await panel('POST', `/marketplace/drivers/${juan.id}/ledger`, { kind: 'pago_efectivo', amount: 4 });
    const l = (await panel('GET', `/marketplace/drivers/${juan.id}/ledger`)).body;
    assert.equal(Number(l.balance), 0);
    assert.equal(l.entries[0].created_by_name, 'Alex');

    // El repartidor no puede escribir su cuenta ni ver la de otro.
    await assert.rejects(
      ctx.withFleetDriver(juan.id, (db) => db.query(
        "INSERT INTO marketplace_driver_ledger (driver_id, kind, amount) VALUES ($1, 'ajuste', 1000)", [juan.id],
      )),
      /row-level security/,
    );
    const seen = (await ctx.withFleetDriver(juan.id, (db) => db.query('SELECT DISTINCT driver_id FROM marketplace_driver_ledger'))).rows;
    assert.deepEqual(seen.map((r) => r.driver_id), [juan.id]);
    assert.equal((await api(R.token, 'GET', '/api/platform/marketplace/balances')).status, 403);
    assert.ok(cardToken);
  });
});
