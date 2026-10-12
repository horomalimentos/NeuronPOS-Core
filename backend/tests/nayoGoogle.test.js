// Nayo: "Continuar con Google". El id_token se firma aqui con una llave propia
// que reemplaza a las de Google; se verifica audiencia, emisor y correo.
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { SKIP_DB, setupDb } from './helpers.js';

const CLIENT_ID = 'nayo-test.apps.googleusercontent.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

const idToken = (claims, { aud = CLIENT_ID, iss = 'https://accounts.google.com', key = privateKey } = {}) => jwt.sign(
  { email_verified: true, ...claims }, key, { algorithm: 'RS256', keyid: 'k1', audience: aud, issuer: iss, expiresIn: 300 },
);

describe('Nayo: continuar con Google', { skip: SKIP_DB }, () => {
  let ctx;
  let env;
  const pub = (method, path, body, token) => ctx.request(method, `/api/marketplace${path}`, { body, token });
  const mails = [];
  before(async () => {
    ctx = await setupDb();
    ({ env } = await import('../config/env.js'));
    (await import('../services/googleSignIn.js')).setGoogleKeysForTest([jwk]);
    (await import('../services/mailer.js')).setMailTransport((m) => { mails.push(m); });
  });
  after(async () => {
    env.googleClientId = '';
    (await import('../services/googleSignIn.js')).setGoogleKeysForTest(null);
    (await import('../services/mailer.js')).setMailTransport(null);
    await ctx?.close();
  });

  test('sin GOOGLE_CLIENT_ID no hay boton ni entrada', async () => {
    env.googleClientId = '';
    assert.equal((await pub('GET', '/account/options')).body.google_client_id, null);
    assert.equal((await pub('POST', '/account/google', { credential: idToken({ sub: '1', email: 'a@gmail.test' }) })).body.code, 'GOOGLE_DISABLED');
  });

  test('crea la cuenta, vuelve a entrar y liga la que ya tenia correo', async () => {
    env.googleClientId = CLIENT_ID;
    assert.equal((await pub('GET', '/account/options')).body.google_client_id, CLIENT_ID);

    // Tokens que no valen.
    const bad = [
      idToken({ sub: 'g1', email: 'ana@gmail.test' }, { aud: 'otro.apps.googleusercontent.com' }),
      idToken({ sub: 'g1', email: 'ana@gmail.test' }, { iss: 'https://evil.test' }),
      idToken({ sub: 'g1', email: 'ana@gmail.test', email_verified: false }),
      idToken({ sub: 'g1', email: 'ana@gmail.test' }, { key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }),
      'no-es-un-token',
    ];
    for (const credential of bad) assert.equal((await pub('POST', '/account/google', { credential })).body.code, 'INVALID_GOOGLE_TOKEN');

    const first = await pub('POST', '/account/google', { credential: idToken({ sub: 'g1', email: 'Ana@Gmail.test', name: 'Ana López' }) });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.customer.email, 'ana@gmail.test');
    assert.equal(first.body.customer.name, 'Ana López');
    assert.equal(first.body.customer.phone, null);
    assert.ok(mails.find((m) => m.subject === 'Bienvenido a Nayo' && m.to === 'ana@gmail.test'));
    assert.equal((await pub('GET', '/account', undefined, first.body.token)).status, 200);

    const again = await pub('POST', '/account/google', { credential: idToken({ sub: 'g1', email: 'ana@gmail.test' }) });
    assert.equal(again.status, 200);
    assert.equal(again.body.customer.id, first.body.customer.id);

    // Sin contrasena: el login con contrasena le dice que use Google.
    assert.equal((await pub('POST', '/account/login', { email: 'ana@gmail.test', password: 'cualquier-cosa' })).body.code, 'USE_GOOGLE');

    // Cuenta con contrasena y el mismo correo: Google entra a esa misma cuenta.
    const reg = await pub('POST', '/account/register', { name: 'Beto', email: 'beto@gmail.test', phone: '656 111 2222', password: 'clave-beto-1' });
    const linked = await pub('POST', '/account/google', { credential: idToken({ sub: 'g2', email: 'beto@gmail.test', name: 'Roberto' }) });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.customer.id, reg.body.customer.id);
    assert.equal(linked.body.customer.name, 'Beto');
    assert.equal((await pub('POST', '/account/login', { email: 'beto@gmail.test', password: 'clave-beto-1' })).status, 200);
    // Otra persona de Google con ese correo no entra a la cuenta ya ligada.
    assert.equal((await pub('POST', '/account/google', { credential: idToken({ sub: 'g3', email: 'beto@gmail.test' }) })).body.code, 'GOOGLE_MISMATCH');
  });
});
