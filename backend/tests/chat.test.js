// Chat del equipo: muro por sucursal, respuestas, fijar, borrar, no leidos y
// aislamiento entre restaurantes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('chat del equipo', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let C; let norte; let centro; let mesero; let cajero;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const login = async (slug, email) => (await ctx.request('POST', '/api/auth/login', { slug, body: { email, password: 'clave-segura-9' } })).body.token;

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['chat'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['chat'] });
    C = await createRestaurant(ctx, owner, 'gama', { modules: ['pos'] });
    norte = (await api(A, 'GET', '/api/branches')).body.branches[0];
    centro = (await api(A, 'POST', '/api/branches', { name: 'Centro' })).body.branch;
    await api(A, 'POST', '/api/users', { email: 'mesero@alfa.test', name: 'Lupe', role: 'mesero', password: 'clave-segura-9', branch_ids: [norte.id] });
    await api(A, 'POST', '/api/users', { email: 'caja@alfa.test', name: 'Beto', role: 'cajero', password: 'clave-segura-9', branch_ids: [centro.id] });
    mesero = await login('alfa', 'mesero@alfa.test');
    cajero = await login('alfa', 'caja@alfa.test');
  });
  after(() => ctx?.close());

  test('sin el modulo responde 402', async () => {
    assert.equal((await api(C, 'GET', '/api/chat/posts')).status, 402);
  });

  test('cada quien ve los mensajes generales y los de sus sucursales', async () => {
    const general = await api(A, 'POST', '/api/chat/posts', { body: 'Junta el lunes a las 9' });
    assert.equal(general.status, 201, JSON.stringify(general.body));
    assert.equal(general.body.post.branch_id, null);
    assert.equal((await api(mesero, 'POST', '/api/chat/posts', { body: 'Sin sucursal' })).body.code, 'MISSING_FIELD');
    assert.equal((await api(mesero, 'POST', '/api/chat/posts', { body: 'Hola Centro', branch_id: centro.id })).status, 403);
    const n = await api(mesero, 'POST', '/api/chat/posts', { body: 'Se acabó el salmón en Norte', branch_id: norte.id });
    assert.equal(n.status, 201);
    assert.equal(n.body.post.author_name, 'Lupe');

    const forMesero = (await api(mesero, 'GET', '/api/chat/posts')).body.posts.map((p) => p.body);
    assert.deepEqual(forMesero.sort(), ['Junta el lunes a las 9', 'Se acabó el salmón en Norte']);
    const forCajero = (await api(cajero, 'GET', '/api/chat/posts')).body.posts.map((p) => p.body);
    assert.deepEqual(forCajero, ['Junta el lunes a las 9']);
    assert.equal((await api(cajero, 'GET', `/api/chat/posts/${n.body.post.id}/replies`)).status, 404, 'no ve el de otra sucursal');
    assert.equal((await api(A, 'GET', '/api/chat/posts')).body.posts.length, 2, 'el admin ve todo');
    assert.equal((await api(B, 'GET', '/api/chat/posts')).body.posts.length, 0, 'otro restaurante no ve nada');
  });

  test('responder sube el mensaje; fijar lo deja arriba', async () => {
    const posts = (await api(A, 'GET', '/api/chat/posts')).body.posts;
    const junta = posts.find((p) => p.body.startsWith('Junta'));
    const r = await api(cajero, 'POST', `/api/chat/posts/${junta.id}/replies`, { body: 'Ahí estaré' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.reply.author_name, 'Beto');
    let feed = (await api(A, 'GET', '/api/chat/posts')).body.posts;
    assert.equal(feed[0].id, junta.id);
    assert.equal(feed[0].reply_count, 1);

    const salmon = feed.find((p) => p.body.includes('salmón'));
    assert.equal((await api(mesero, 'PATCH', `/api/chat/posts/${salmon.id}/pin`, { pinned: true })).status, 403);
    assert.equal((await api(A, 'PATCH', `/api/chat/posts/${salmon.id}/pin`, { pinned: true })).body.post.pinned, true);
    feed = (await api(A, 'GET', '/api/chat/posts')).body.posts;
    assert.equal(feed[0].id, salmon.id);
    const replies = (await api(mesero, 'GET', `/api/chat/posts/${junta.id}/replies`)).body.replies;
    assert.deepEqual(replies.map((x) => x.body), ['Ahí estaré']);
  });

  test('editar solo el autor; borrar el autor o un gerente', async () => {
    const mine = (await api(cajero, 'POST', '/api/chat/posts', { body: 'Falta cambio', branch_id: centro.id })).body.post;
    assert.equal((await api(A, 'PUT', `/api/chat/posts/${mine.id}`, { body: 'x' })).body.code, 'NOT_AUTHOR');
    const edited = await api(cajero, 'PUT', `/api/chat/posts/${mine.id}`, { body: 'Falta cambio de $50' });
    assert.equal(edited.body.post.body, 'Falta cambio de $50');
    assert.ok(edited.body.post.edited_at);
    const reply = (await api(A, 'POST', `/api/chat/posts/${mine.id}/replies`, { body: 'Voy al banco' })).body.reply;
    assert.equal((await api(mesero, 'DELETE', `/api/chat/replies/${reply.id}`)).status, 404, 'el mesero no ve ese mensaje');
    assert.equal((await api(cajero, 'DELETE', `/api/chat/replies/${reply.id}`)).body.code, 'NOT_AUTHOR');
    assert.equal((await api(A, 'DELETE', `/api/chat/replies/${reply.id}`)).status, 204);
    assert.equal((await api(A, 'DELETE', `/api/chat/posts/${mine.id}`)).status, 204);
    assert.equal((await api(cajero, 'GET', `/api/chat/posts/${mine.id}/replies`)).status, 404);
  });

  test('no leidos: cuenta lo de otros desde la ultima vez', async () => {
    const before = (await api(mesero, 'GET', '/api/chat/unread')).body.unread;
    assert.ok(before >= 2, `esperaba no leidos, hubo ${before}`);
    await api(mesero, 'POST', '/api/chat/seen');
    assert.equal((await api(mesero, 'GET', '/api/chat/unread')).body.unread, 0);
    await api(mesero, 'POST', '/api/chat/posts', { body: 'Mio no cuenta', branch_id: norte.id });
    await api(cajero, 'POST', '/api/chat/posts', { body: 'De Centro no lo ve', branch_id: centro.id });
    assert.equal((await api(mesero, 'GET', '/api/chat/unread')).body.unread, 0);
    await api(A, 'POST', '/api/chat/posts', { body: 'Para todos' });
    assert.equal((await api(mesero, 'GET', '/api/chat/unread')).body.unread, 1);
  });
});
