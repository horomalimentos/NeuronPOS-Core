// Nayo: cuentas de cliente. Para pedir hay que registrarse o entrar; la
// cuenta es de la plataforma y su token no abre otras rutas.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, setupDb } from './helpers.js';

describe('Nayo: cuentas de cliente', { skip: SKIP_DB }, () => {
  let ctx;
  const pub = (method, path, body, token) => ctx.request(method, `/api/marketplace${path}`, { body, token });
  before(async () => { ctx = await setupDb(); });
  after(() => ctx?.close());

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
});
