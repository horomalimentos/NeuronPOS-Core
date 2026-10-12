// Control de dispositivos: con el modulo, solo equipos autorizados abren caja,
// cobran y recargan; alta, aprobacion (con su caja), sucursal y baja.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const T1 = 'equipo-uno-0123456789abcdefghijklmnop';
const T2 = 'equipo-dos-0123456789abcdefghijklmnop';

describe('control de dispositivos', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branchA; let branchA2; let cajero; let taco; let cash; let device; let session;
  const api = (who, method, path, body, token) => ctx.request(method, path, { token: who.token ?? who, body, headers: token ? { 'x-device-token': token } : {} });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'dispositivos'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    branchA = (await api(A, 'GET', '/api/branches')).body.branches[0];
    branchA2 = (await api(A, 'POST', '/api/branches', { name: 'Centro' })).body.branch;
    await api(A, 'POST', '/api/users', { email: 'caja@alfa.test', name: 'Caja', role: 'cajero', password: 'clave-segura-9', branch_ids: [branchA.id, branchA2.id] });
    cajero = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'caja@alfa.test', password: 'clave-segura-9' } })).body.token;
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Menu' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    cash = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods.find((m) => m.kind === 'efectivo').id;
  });
  after(() => ctx?.close());

  test('sin el modulo no se pide equipo', async () => {
    const bBranch = (await api(B, 'GET', '/api/branches')).body.branches[0];
    assert.equal((await api(B, 'POST', '/api/pos/cash-sessions/open', { branch_id: bBranch.id, terminal: 'Caja 1' })).status, 201);
    assert.equal((await api(B, 'GET', '/api/devices/me')).body.code, 'MODULE_NOT_ENABLED');
  });

  test('alta, aprobacion y caja del equipo', async () => {
    const open = (token, branch = branchA.id) => api(cajero, 'POST', '/api/pos/cash-sessions/open', { branch_id: branch, terminal: 'Caja 9', opening_cash: 100 }, token);
    assert.equal((await open(null)).body.code, 'DEVICE_NOT_AUTHORIZED');
    assert.equal((await api(cajero, 'POST', '/api/devices/request', { name: 'Tablet', branch_id: branchA.id, terminal: 'Caja 1' })).body.code, 'DEVICE_TOKEN_REQUIRED');
    const req = await api(cajero, 'POST', '/api/devices/request', { name: 'Tablet barra', branch_id: branchA.id, terminal: 'Barra' }, T1);
    assert.equal(req.status, 201, JSON.stringify(req.body));
    device = req.body.device;
    assert.equal(device.status, 'pendiente');
    const mine = await api(cajero, 'GET', '/api/devices/me', undefined, T1);
    assert.equal(mine.body.device?.status, 'pendiente', JSON.stringify(mine.body));
    assert.match((await open(T1)).body.error, /espera la autorizacion/);

    assert.equal((await api(cajero, 'GET', '/api/devices')).status, 403);
    assert.equal((await api(cajero, 'POST', `/api/devices/${device.id}/approve`, {})).status, 403);
    const ok = await api(A, 'POST', `/api/devices/${device.id}/approve`, { terminal: 'Caja 2' });
    assert.equal(ok.body.device.status, 'activo');
    assert.equal(ok.body.device.terminal, 'Caja 2');

    assert.equal((await open(T1, branchA2.id)).body.code, 'DEVICE_WRONG_BRANCH');
    const opened = await open(T1);
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    session = opened.body.session;
    assert.equal(session.terminal, 'Caja 2', 'el turno es de la caja del equipo');
    assert.ok((await api(A, 'GET', '/api/devices')).body.devices[0].last_seen_at);
  });

  test('cobrar y movimientos solo desde el equipo', async () => {
    const o = (await api(cajero, 'POST', '/api/pos/orders', { branch_id: branchA.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }] })).body.order;
    const body = { cash_session_id: session.id, payments: [{ payment_method_id: cash, amount: 100 }] };
    assert.equal((await api(cajero, 'POST', `/api/pos/orders/${o.id}/payments`, body)).body.code, 'DEVICE_NOT_AUTHORIZED');
    assert.equal((await api(cajero, 'POST', `/api/pos/orders/${o.id}/payments`, body, T2)).body.code, 'DEVICE_NOT_AUTHORIZED');
    assert.equal((await api(cajero, 'POST', `/api/pos/orders/${o.id}/payments`, body, T1)).status, 201);
    assert.equal((await api(cajero, 'POST', `/api/pos/cash-sessions/${session.id}/movements`, { kind: 'salida', amount: 10, reason: 'Hielo' })).status, 403);
    assert.equal((await api(cajero, 'POST', `/api/pos/cash-sessions/${session.id}/movements`, { kind: 'salida', amount: 10, reason: 'Hielo' }, T1)).status, 201);
    // Tomar ordenes no pide equipo.
    assert.equal((await api(cajero, 'GET', `/api/pos/orders?branch_id=${branchA.id}`)).status, 200);
  });

  test('revocar', async () => {
    await api(A, 'POST', `/api/devices/${device.id}/revoke`);
    const close = await api(cajero, 'POST', `/api/pos/cash-sessions/${session.id}/close`, { counts: [] }, T1);
    assert.equal(close.body.code, 'DEVICE_NOT_AUTHORIZED');
    assert.equal((await api(cajero, 'POST', '/api/devices/request', { name: 'Otra vez', branch_id: branchA.id, terminal: 'Caja 1' }, T1)).body.code, 'DEVICE_REVOKED');
    assert.equal((await api(B, 'POST', `/api/devices/${device.id}/approve`)).body.code, 'MODULE_NOT_ENABLED');
  });
});
