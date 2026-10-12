// Terminal Clip en caja (PinPad) con Clip simulado: el cobro se confirma
// consultando a Clip, se usa una sola vez y no se repite si ya se aprobo.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClipMock } from './clipMock.js';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('terminal Clip en caja', { skip: SKIP_DB }, () => {
  let ctx; let owner; let clip; let A; let B; let branchA; let agua; let session; let tarjeta; let efectivo;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const newOrder = async (qty = 2) => (await api(A, 'POST', '/api/pos/orders', {
    branch_id: branchA.id, order_type: 'para_llevar', items: [{ menu_item_id: agua.id, quantity: qty }],
  })).body.order;

  before(async () => {
    ctx = await setupDb();
    const client = await import('../services/clip/client.js');
    clip = createClipMock();
    client.setClipTransport((req) => clip.transport(req));
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'terminal_clip'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    branchA = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Bebidas' })).body.category;
    agua = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Agua', price: 50 })).body.item;
    const methods = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods;
    tarjeta = methods.find((m) => m.kind === 'tarjeta').id;
    efectivo = methods.find((m) => m.kind === 'efectivo').id;
    session = (await api(A, 'POST', '/api/pos/cash-sessions/open', { branch_id: branchA.id, terminal: 'Caja 1', opening_cash: 0 })).body.session;
  });
  after(() => ctx?.close());

  test('sin el modulo: 402; sin cuenta de Clip o sin terminal no cobra', async () => {
    assert.equal((await api(B, 'GET', '/api/pos/clip/terminal?branch_id=x&terminal=Caja%201')).status, 402);
    const o = await newOrder();
    const noCreds = await api(A, 'POST', '/api/pos/clip/cobros', { order_id: o.id, amount: 100, terminal: 'Caja 1' });
    assert.equal(noCreds.body.code, 'CLIP_NOT_CONFIGURED');
    assert.equal((await api(A, 'PUT', '/api/online/payments', { clip_api_key: 'alfa-key', clip_secret_key: 'alfa-secret' })).status, 200);
    const noTerm = await api(A, 'POST', '/api/pos/clip/cobros', { order_id: o.id, amount: 100, terminal: 'Caja 1' });
    assert.equal(noTerm.body.code, 'PINPAD_NOT_CONFIGURED');
    assert.equal((await api(A, 'PUT', '/api/pos/clip/terminal', { branch_id: branchA.id, terminal: 'Caja 1', serial_number: 'bad serial!' })).status, 400);
    const t = await api(A, 'PUT', '/api/pos/clip/terminal', { branch_id: branchA.id, terminal: 'Caja 1', serial_number: 'p8-1234567' });
    assert.equal(t.body.serial_number, 'P8-1234567');
    assert.equal((await api(A, 'GET', `/api/pos/clip/terminal?branch_id=${branchA.id}&terminal=caja%201`)).body.enabled, true);
  });

  test('cobro aprobado: se registra una vez como tarjeta y no se vuelve a cobrar', async () => {
    const o = await newOrder();
    assert.equal((await api(A, 'POST', '/api/pos/clip/cobros', { order_id: o.id, amount: 150, terminal: 'Caja 1' })).body.code, 'AMOUNT_TOO_HIGH');
    const c = (await api(A, 'POST', '/api/pos/clip/cobros', { order_id: o.id, amount: 100, terminal: 'Caja 1' })).body.cobro;
    assert.equal(c.status, 'PENDING');
    const sent = clip.calls.filter((x) => x.url.includes('/pinpad/') && x.method === 'POST').at(-1);
    assert.equal(sent.body.serial_number_pos, 'P8-1234567');
    assert.match(sent.body.webhook_url, new RegExp(`/api/webhooks/clip/pinpad/${A.id}$`));
    const ppId = [...clip.pinpads.keys()].at(-1);

    // Mientras no se apruebe no sirve para pagar.
    const early = await api(A, 'POST', `/api/pos/orders/${o.id}/payments`, {
      cash_session_id: session.id, payments: [{ payment_method_id: tarjeta, amount: 100, clip_cobro_id: c.id }],
    });
    assert.equal(early.body.code, 'PINPAD_NOT_APPROVED');

    clip.approvePinpad(ppId);
    // El webhook solo dispara la consulta a Clip.
    await ctx.request('POST', `/api/webhooks/clip/pinpad/${A.id}`, { body: { id: ppId, status: 'APPROVED' } });
    const done = (await api(A, 'GET', `/api/pos/clip/cobros/${c.id}`)).body.cobro;
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.card_last_digits, '4242');

    // Pedir otro cobro de la misma orden regresa el aprobado (no se cobra dos veces).
    const again = await api(A, 'POST', '/api/pos/clip/cobros', { order_id: o.id, amount: 100, terminal: 'Caja 1' });
    assert.equal(again.status, 409);
    assert.equal(again.body.cobro.id, c.id);

    assert.equal((await api(A, 'POST', `/api/pos/orders/${o.id}/payments`, {
      cash_session_id: session.id, payments: [{ payment_method_id: efectivo, amount: 100, clip_cobro_id: c.id }],
    })).body.code, 'PINPAD_METHOD');
    const paid = await api(A, 'POST', `/api/pos/orders/${o.id}/payments`, {
      cash_session_id: session.id, payments: [{ payment_method_id: tarjeta, amount: 100, clip_cobro_id: c.id }],
    });
    assert.equal(paid.body.order.status, 'pagada', JSON.stringify(paid.body));
    assert.match(paid.body.order.payments[0].reference, /4242/);
    const o2 = await newOrder();
    const reuse = await api(A, 'POST', `/api/pos/orders/${o2.id}/payments`, {
      cash_session_id: session.id, payments: [{ payment_method_id: tarjeta, amount: 100, clip_cobro_id: c.id }],
    });
    assert.equal(reuse.body.code, 'PINPAD_NOT_APPROVED', 'un cobro solo paga su orden y una vez');
  });

  test('rechazado, monto distinto, terminal apagada y cancelar', async () => {
    const o = await newOrder();
    const c1 = (await api(A, 'POST', '/api/pos/clip/cobros', { order_id: o.id, amount: 100, terminal: 'Caja 1' })).body.cobro;
    clip.rejectPinpad([...clip.pinpads.keys()].at(-1));
    assert.equal((await api(A, 'GET', `/api/pos/clip/cobros/${c1.id}`)).body.cobro.status, 'FAILED');

    const c2 = (await api(A, 'POST', '/api/pos/clip/cobros', { order_id: o.id, amount: 100, terminal: 'Caja 1' })).body.cobro;
    clip.approvePinpad([...clip.pinpads.keys()].at(-1), 1);
    const odd = (await api(A, 'GET', `/api/pos/clip/cobros/${c2.id}`)).body.cobro;
    assert.equal(odd.status, 'FAILED', 'Clip cobro otro monto');

    const c3 = (await api(A, 'POST', '/api/pos/clip/cobros', { order_id: o.id, amount: 100, terminal: 'Caja 1' })).body.cobro;
    assert.equal((await api(A, 'DELETE', `/api/pos/clip/cobros/${c3.id}`)).body.cobro.status, 'CANCELLED');
    const c4 = (await api(A, 'POST', '/api/pos/clip/cobros', { order_id: o.id, amount: 100, terminal: 'Caja 1' })).body.cobro;
    clip.takePinpad([...clip.pinpads.keys()].at(-1));
    assert.equal((await api(A, 'DELETE', `/api/pos/clip/cobros/${c4.id}`)).body.code, 'PINPAD_IN_PROGRESS');

    clip.pinpadOffline = true;
    const off = await api(A, 'POST', '/api/pos/clip/cobros', { order_id: o.id, amount: 100, terminal: 'Caja 1' });
    assert.equal(off.body.code, 'PINPAD_OFFLINE');
    clip.pinpadOffline = false;
    // B no ve los cobros de A.
    assert.equal((await api(B, 'GET', `/api/pos/clip/cobros/${c1.id}`)).status, 402);
  });
});
