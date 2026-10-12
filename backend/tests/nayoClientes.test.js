// Nayo: cuentas de cliente. Para pedir hay que registrarse o entrar; la
// cuenta es de la plataforma y su token no abre otras rutas.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, setupDb } from './helpers.js';

describe('Nayo: cuentas de cliente', { skip: SKIP_DB }, () => {
  let ctx;
  const pub = (method, path, body, token) => ctx.request(method, `/api/marketplace${path}`, { body, token });
  const mails = [];
  before(async () => {
    ctx = await setupDb();
    (await import('../services/mailer.js')).setMailTransport((m) => { mails.push(m); });
  });
  after(async () => { (await import('../services/mailer.js')).setMailTransport(null); await ctx?.close(); });

  test('registro, entrada y la cuenta no sirve en otras rutas', async () => {
    const acct = { name: 'Maria', email: 'Maria@Cliente.test', phone: '656 123 4567', password: 'clave-cliente-1' };
    assert.equal((await pub('POST', '/account/register', { ...acct, phone: '123' })).body.code, 'INVALID_PHONE');
    assert.equal((await pub('POST', '/account/register', { ...acct, password: 'corta' })).body.code, 'WEAK_PASSWORD');
    const reg = await pub('POST', '/account/register', acct);
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.customer.email, 'maria@cliente.test');
    assert.equal((await pub('POST', '/account/register', acct)).body.code, 'EMAIL_TAKEN');
    assert.equal((await pub('POST', '/account/login', { email: 'maria@cliente.test', password: 'otra-clave-1' })).status, 401);
    const login = await pub('POST', '/account/login', { email: 'MARIA@cliente.test', password: 'clave-cliente-1' });
    assert.equal(login.status, 200);
    const me = await pub('GET', '/account', undefined, login.body.token);
    assert.equal(me.body.customer.name, 'Maria');
    assert.deepEqual(me.body.orders, []);
    // El token de cliente de Nayo no abre el admin de un restaurante ni la app del repartidor.
    assert.equal((await ctx.request('GET', '/api/me', { token: login.body.token })).status, 401);
    assert.equal((await ctx.request('GET', '/api/fleet/me', { token: login.body.token })).status, 401);
  });

  test('bienvenida de Nayo y olvide mi contrasena', async () => {
    const welcome = mails.find((m) => m.subject === 'Bienvenido a Nayo');
    assert.ok(welcome, 'manda bienvenida al registrarse');
    assert.equal(welcome.from, 'Nayo <no-reply@elnayo.com>');
    assert.equal(welcome.to, 'maria@cliente.test');

    // No revela si el correo existe.
    assert.equal((await pub('POST', '/account/forgot', { email: 'nadie@cliente.test' })).status, 200);
    assert.equal((await pub('POST', '/account/forgot', { email: 'maria@cliente.test' })).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const reset = mails.find((m) => m.subject === 'Cambia tu contraseña de Nayo');
    assert.ok(reset);
    const token = reset.text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    assert.match(reset.text, /https:\/\/elnayo\.com\/restablecer#token=/);
    // Pedir otra al momento no manda otro correo.
    await pub('POST', '/account/forgot', { email: 'maria@cliente.test' });
    assert.equal(mails.filter((m) => m.subject === 'Cambia tu contraseña de Nayo').length, 1);

    const old = (await pub('POST', '/account/login', { email: 'maria@cliente.test', password: 'clave-cliente-1' })).body.token;
    await new Promise((r) => setTimeout(r, 1100)); // iat en segundos: el cambio debe ser despues
    assert.equal((await pub('POST', '/account/reset', { token, password: 'corta' })).body.code, 'WEAK_PASSWORD');
    const done = await pub('POST', '/account/reset', { token, password: 'nueva-clave-22' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await pub('GET', '/account', undefined, done.body.token)).status, 200);
    // La liga sirve una vez y la sesion anterior se cierra.
    assert.equal((await pub('POST', '/account/reset', { token, password: 'otra-clave-33' })).body.code, 'INVALID_RESET_TOKEN');
    assert.equal((await pub('GET', '/account', undefined, old)).body.code, 'SESSION_REVOKED');
    assert.equal((await pub('POST', '/account/login', { email: 'maria@cliente.test', password: 'nueva-clave-22' })).status, 200);
  });
});
