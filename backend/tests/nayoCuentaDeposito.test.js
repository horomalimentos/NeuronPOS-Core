// Nayo: datos bancarios del restaurante (CLABE). El dueno o gerente los
// captura; un cajero no; otro restaurante no; el Panel los ve; CLABE invalida no.
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

  test('el dueno captura sus datos; el banco sale de la CLABE; el Panel los ve', async () => {
    assert.equal((await api(R.token, 'GET', '/api/marketplace/bank')).body.bank.bank_clabe, null);
    const bad = await api(R.token, 'PUT', '/api/marketplace/bank', { holder: 'Pepa Lopez', clabe: '012180001234567890' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_CLABE');

    const ok = await api(R.token, 'PUT', '/api/marketplace/bank', { holder: 'Pepa  Lopez', clabe: '0121 8000 1234 5678 99' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.bank.bank_clabe, CLABE);
    assert.equal(ok.body.bank.bank_name, 'BBVA');
    assert.equal(ok.body.bank.bank_holder, 'Pepa Lopez');
    assert.ok(ok.body.bank.bank_updated_at);

    // Otro restaurante no la ve.
    assert.equal((await api(R2.token, 'GET', '/api/marketplace/bank')).body.bank.bank_clabe, null);

    const panel = await api(owner, 'GET', '/api/platform/marketplace/listings');
    const mine = panel.body.listings.find((l) => l.restaurant_id === R.id);
    assert.equal(mine.bank_clabe, CLABE);
    assert.equal(mine.bank_holder, 'Pepa Lopez');
    assert.equal(panel.body.listings.find((l) => l.restaurant_id === R2.id).bank_clabe, null);
  });

  test('un cajero no puede ver ni cambiar la cuenta', async () => {
    const u = await api(R.token, 'POST', '/api/users', { name: 'Caja', email: 'caja@tacos.test', password: 'clave-segura-2', role: 'cajero' });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    const slug = (await api(R.token, 'GET', '/api/me')).body.restaurant.slug;
    const login = await ctx.request('POST', '/api/auth/login', { slug, body: { email: 'caja@tacos.test', password: 'clave-segura-2' } });
    assert.equal((await api(login.body.token, 'GET', '/api/marketplace/bank')).status, 403);
    assert.equal((await api(login.body.token, 'PUT', '/api/marketplace/bank', { holder: 'Otra Persona', clabe: CLABE })).status, 403);
  });
});
