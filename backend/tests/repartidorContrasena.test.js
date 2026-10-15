// Nayo repartidor: "olvide mi contrasena" desde la app del repartidor.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, ownerToken, setupDb } from './helpers.js';

describe('Nayo repartidor: recuperar contraseña', { skip: SKIP_DB }, () => {
  let ctx;
  const mails = [];
  const fleet = (method, path, body, token) => ctx.request(method, `/api/fleet${path}`, { body, token });
  const subject = 'Cambia tu contraseña de repartidor Nayo';
  before(async () => {
    ctx = await setupDb();
    (await import('../services/mailer.js')).setMailTransport((m) => { mails.push(m); });
    const owner = await ownerToken(ctx);
    const r = await ctx.request('POST', '/api/platform/fleet/drivers', {
      token: owner, body: { name: 'Pepe', phone: '6561239999', email: 'pepe@flota.test', password: 'clave-pepe-1' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
  after(async () => { (await import('../services/mailer.js')).setMailTransport(null); await ctx?.close(); });

  test('manda la liga, cambia la contraseña una vez y cierra las sesiones viejas', async () => {
    // No revela si el correo existe.
    assert.equal((await fleet('POST', '/auth/forgot', { email: 'nadie@flota.test' })).status, 200);
    assert.equal((await fleet('POST', '/auth/forgot', { email: 'PEPE@flota.test' })).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const reset = mails.find((m) => m.subject === subject);
    assert.ok(reset);
    assert.equal(reset.to, 'pepe@flota.test');
    assert.match(reset.text, /https:\/\/elnayo\.com\/repartidor#reset=/);
    const token = reset.text.match(/#reset=([A-Za-z0-9_-]+)/)[1];
    // Pedir otra al momento no manda otro correo.
    await fleet('POST', '/auth/forgot', { email: 'pepe@flota.test' });
    assert.equal(mails.filter((m) => m.subject === subject).length, 1);

    const old = (await fleet('POST', '/auth/login', { email: 'pepe@flota.test', password: 'clave-pepe-1' })).body.token;
    assert.equal((await fleet('GET', '/me', undefined, old)).status, 200);
    await new Promise((r) => setTimeout(r, 1100)); // iat en segundos: el cambio debe ser despues
    assert.equal((await fleet('POST', '/auth/reset', { token, password: 'corta' })).body.code, 'WEAK_PASSWORD');
    assert.equal((await fleet('POST', '/auth/reset', { token: 'x', password: 'nueva-clave-22' })).body.code, 'INVALID_RESET_TOKEN');
    const done = await fleet('POST', '/auth/reset', { token, password: 'nueva-clave-22' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.driver.email, 'pepe@flota.test');
    assert.equal((await fleet('GET', '/me', undefined, done.body.token)).status, 200);
    assert.equal((await fleet('POST', '/auth/reset', { token, password: 'otra-clave-33' })).body.code, 'INVALID_RESET_TOKEN');
    assert.equal((await fleet('GET', '/me', undefined, old)).body.code, 'SESSION_REVOKED');
    assert.equal((await fleet('POST', '/auth/login', { email: 'pepe@flota.test', password: 'clave-pepe-1' })).status, 401);
    assert.equal((await fleet('POST', '/auth/login', { email: 'pepe@flota.test', password: 'nueva-clave-22' })).status, 200);
  });
});
