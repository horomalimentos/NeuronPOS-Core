// Nayo: cuenta para depositos del restaurante (CLABE). El dueno la captura y
// la ve enmascarada; un cajero no; el Panel la ve completa; CLABE invalida no.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, ownerToken, setupDb } from './helpers.js';

const CENTRO = { latitude: 31.7389, longitude: -106.4870 };
const CLABE = '012180001234567899';


describe('Nayo: cuenta para depositos del restaurante', { skip: SKIP_DB }, () => {
  let ctx; let owner; let R; let R2;
  const api = (token, method, path, body) => ctx.request(method, path, { token, body });
  const signup = async (name, email) => {
    const r = await ctx.request('POST', '/api/marketplace/restaurants', {
      body: { name, phone: '6561112222', address: 'Av. Juarez 100', location: CENTRO, admin: { name, email, password: 'clave-segura-1' } },
    });
    const login = await ctx.request('POST', '/api/auth/login', { slug: r.body.restaurant.slug, body: { email, password: 'clave-segura-1' } });
    return { id: r.body.restaurant.id, token: login.body.token };
  };

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    R = await signup('Tacos Pepa', 'pepa@tacos.test');
    R2 = await signup('Sushi Ken', 'ken@sushi.test');
  });
  after(() => ctx?.close());

  test('CLABE: 18 digitos con digito verificador', async () => {
    // Import tardio: services/ abre la conexion con el entorno de setupDb.
    const { validClabe } = await import('../services/nayoPayouts.js');
    assert.equal(validClabe(CLABE), true);
    assert.equal(validClabe('012180001234567890'), false);
    assert.equal(validClabe('01218000123456789'), false);
    assert.equal(validClabe('01218000123456789a'), false);
  });

  test('el dueno captura y ve solo la terminacion; el Panel la ve completa', async () => {
    assert.equal((await api(R.token, 'GET', '/api/marketplace/payout-account')).body.account, null);
    const bad = await api(R.token, 'PUT', '/api/marketplace/payout-account', { holder_name: 'Pepa Lopez', bank: 'BBVA', clabe: '012180001234567890' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_CLABE');

    const ok = await api(R.token, 'PUT', '/api/marketplace/payout-account', { holder_name: 'Pepa Lopez', bank: 'BBVA', clabe: '0121 8000 1234 5678 99' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.account.clabe_last4, '7899');
    assert.equal(ok.body.account.clabe, undefined);
    const again = await api(R.token, 'PUT', '/api/marketplace/payout-account', { holder_name: 'Pepa Lopez S.', bank: 'BBVA México', clabe: CLABE });
    assert.equal(again.body.account.holder_name, 'Pepa Lopez S.');

    // Otro restaurante no la ve.
    assert.equal((await api(R2.token, 'GET', '/api/marketplace/payout-account')).body.account, null);

    const panel = await api(owner, 'GET', '/api/platform/marketplace/listings');
    const mine = panel.body.listings.find((l) => l.restaurant_id === R.id);
    assert.equal(mine.payout.clabe, CLABE);
    assert.equal(mine.payout.bank, 'BBVA México');
    assert.equal(panel.body.listings.find((l) => l.restaurant_id === R2.id).payout, null);
  });

  test('un cajero no puede ver ni cambiar la cuenta', async () => {
    const u = await api(R.token, 'POST', '/api/users', { name: 'Caja', email: 'caja@tacos.test', password: 'clave-segura-2', role: 'cajero' });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    const slug = (await api(R.token, 'GET', '/api/me')).body.restaurant.slug;
    const login = await ctx.request('POST', '/api/auth/login', { slug, body: { email: 'caja@tacos.test', password: 'clave-segura-2' } });
    assert.equal((await api(login.body.token, 'GET', '/api/marketplace/payout-account')).status, 403);
    assert.equal((await api(login.body.token, 'PUT', '/api/marketplace/payout-account', { holder_name: 'X', bank: 'Y', clabe: CLABE })).status, 403);
  });
});
