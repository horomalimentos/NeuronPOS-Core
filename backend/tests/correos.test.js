// Correos y recuperar contrasena: liga de un solo uso (hash en BD, vence,
// la nueva invalida la anterior), misma respuesta si el correo no existe,
// sesiones viejas cerradas al cambiar la contrasena, personal, bienvenida,
// confirmacion y rechazo de pedidos y aviso a administradores.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_DOMAIN, SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

describe('correos y recuperar contrasena', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let branch; let taco; let anaToken; let cajero;
  const outbox = [];
  const host = `alfa.${PLATFORM_DOMAIN}`;
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });
  const portal = (method, p, body, token) => ctx.request(method, `/api/portal${p}`, { host, body, token });
  const mailTo = async (to, subject) => {
    for (let i = 0; i < 40; i += 1) {
      const m = outbox.filter((x) => x.to === to && (!subject || subject.test(x.subject))).at(-1);
      if (m) return m;
      await sleep(25);
    }
    return null;
  };
  const tokenOf = (m) => m.text.match(/#token=([A-Za-z0-9_-]+)/)[1];

  before(async () => {
    ctx = await setupDb();
    const mailer = await import('../services/mailer.js');
    mailer.setMailTransport(async (m) => { outbox.push(m); });
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal'] });
    await api(owner, 'PATCH', `/api/platform/restaurants/${A.id}`, { contact_email: 'contacto@alfa.test' });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    await api(A, 'PUT', `/api/branches/${branch.id}/hours`, { hours: ALL_DAY });
    await api(A, 'PATCH', '/api/online/settings', { enabled: true });
    await api(A, 'POST', '/api/users', { email: 'cajero@alfa.test', name: 'Caja', role: 'cajero', password: 'clave-segura-9', branch_ids: [branch.id] });
    cajero = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'cajero@alfa.test', password: 'clave-segura-9' } })).body;
  });
  after(async () => {
    (await import('../services/mailer.js')).setMailTransport(null);
    await ctx?.close();
  });

  test('bienvenida al registrarse, con el nombre del restaurante y Reply-To', async () => {
    const r = await portal('POST', '/auth/register', { name: 'Ana <b>', email: 'ana@correo.mx', phone: '6561234567', password: 'clave-ana-12' });
    assert.equal(r.status, 201);
    anaToken = r.body.token;
    const m = await mailTo('ana@correo.mx', /Bienvenido/);
    assert.ok(m, 'manda bienvenida');
    assert.equal(m.from.name, 'Restaurante ALFA');
    assert.equal(m.replyTo, 'contacto@alfa.test');
    assert.ok(!m.html.includes('<b>'), 'el HTML escapa el nombre');
  });

  test('olvide mi contrasena: misma respuesta, liga de un uso y cierra sesiones', async () => {
    const none = await portal('POST', '/auth/forgot', { email: 'nadie@correo.mx' });
    assert.equal(none.status, 200);
    assert.deepEqual(none.body, { ok: true });
    const r = await portal('POST', '/auth/forgot', { email: 'ANA@correo.mx' });
    assert.deepEqual(r.body, { ok: true });
    const m = await mailTo('ana@correo.mx', /contraseña/);
    assert.match(m.text, /alfa\.neuronpos\.test\/cuenta\/restablecer#token=/);
    const token = tokenOf(m);
    // Solo el hash queda en la base.
    const row = await ctx.withTenant(A.id, async (db) => (await db.query("SELECT reset_token_hash FROM customers WHERE email = 'ana@correo.mx'")).rows[0]);
    assert.ok(row.reset_token_hash && !row.reset_token_hash.toString().includes(token));

    // Pedirla otra vez de inmediato no manda otro correo.
    const before = outbox.length;
    await portal('POST', '/auth/forgot', { email: 'ana@correo.mx' });
    await sleep(100);
    assert.equal(outbox.length, before);

    await sleep(1100); // el token viejo debe ser de un segundo anterior
    assert.equal((await portal('POST', '/auth/reset', { token, password: 'corta' })).body.code, 'WEAK_PASSWORD');
    const ok = await portal('POST', '/auth/reset', { token, password: 'nueva-clave-99' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.token);
    // La sesion anterior ya no sirve; la nueva si.
    assert.equal((await portal('GET', '/me', undefined, anaToken)).body.code, 'SESSION_REVOKED');
    assert.equal((await portal('GET', '/me', undefined, ok.body.token)).status, 200);
    // La liga no sirve dos veces.
    assert.equal((await portal('POST', '/auth/reset', { token, password: 'otra-clave-99' })).body.code, 'INVALID_RESET_TOKEN');
    assert.equal((await portal('POST', '/auth/login', { email: 'ana@correo.mx', password: 'nueva-clave-99' })).status, 200);
    anaToken = ok.body.token;
  });

  test('una liga vencida no sirve', async () => {
    const expire = (sql) => ctx.withTenant(A.id, (db) => db.query(`UPDATE customers SET reset_expires_at = now() - interval '${sql}' WHERE email = 'ana@correo.mx'`));
    await expire('2 hours');
    await portal('POST', '/auth/forgot', { email: 'ana@correo.mx' });
    const token = tokenOf(await mailTo('ana@correo.mx', /contraseña/));
    await expire('1 minute');
    assert.equal((await portal('POST', '/auth/reset', { token, password: 'nueva-clave-77' })).body.code, 'INVALID_RESET_TOKEN');
    assert.equal((await portal('POST', '/auth/reset', { token: 'x', password: 'nueva-clave-77' })).body.code, 'INVALID_RESET_TOKEN');
  });

  test('personal: olvide mi contrasena por restaurante', async () => {
    const r = await ctx.request('POST', '/api/auth/forgot', { slug: 'alfa', body: { email: 'cajero@alfa.test' } });
    assert.deepEqual(r.body, { ok: true });
    const m = await mailTo('cajero@alfa.test', /personal/);
    assert.match(m.text, /\/admin\/restablecer#token=/);
    await sleep(1100);
    const ok = await ctx.request('POST', '/api/auth/reset', { slug: 'alfa', body: { token: tokenOf(m), password: 'cajero-nueva-1' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await api(cajero, 'GET', '/api/me')).body.code, 'SESSION_REVOKED');
    const login = await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'cajero@alfa.test', password: 'cajero-nueva-1' } });
    assert.equal(login.status, 200);
    cajero = login.body;
    // Otro restaurante no acepta el correo de este.
    await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    const n = outbox.length;
    await ctx.request('POST', '/api/auth/forgot', { slug: 'beta', body: { email: 'cajero@alfa.test' } });
    await sleep(100);
    assert.equal(outbox.length, n);
  });

  test('pedido: confirmacion al cliente, aviso a admins (si lo activan) y rechazo', async () => {
    const order = (items) => portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items, payment: { method: 'efectivo' },
    }, anaToken);
    const r = await order([{ menu_item_id: taco.id, quantity: 1 }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const m = await mailTo('ana@correo.mx', /Recibimos tu pedido/);
    assert.match(m.text, /\/pedido\/[A-Za-z0-9_-]+/);
    await sleep(100);
    assert.ok(!outbox.some((x) => x.to === 'admin@alfa.test' && /Pedido en línea/.test(x.subject)), 'apagado por defecto');

    await api(A, 'PATCH', '/api/online/settings', { order_email_alerts: true });
    const r2 = await order([{ menu_item_id: taco.id, quantity: 2 }]);
    const alert = await mailTo('admin@alfa.test', /Pedido en línea/);
    assert.ok(alert, JSON.stringify(outbox.map((x) => [x.to, x.subject])));
    assert.match(alert.subject, /\$200\.00/);

    const rej = await api(cajero, 'POST', `/api/pos/online-orders/${r2.body.order.id}/reject`, { reason: 'Sin gas' });
    assert.equal(rej.status, 200, JSON.stringify(rej.body));
    const rm = await mailTo('ana@correo.mx', /no pudo aceptarse/);
    assert.match(rm.text, /Sin gas/);
  });
});
