// Operacion del personal: fotos, checklists del dia con foto obligatoria,
// incidencias que firma el empleado y comunicados con lectura.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

// JPG minimo valido (firma FFD8FF).
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]);

describe('operacion del personal (rh)', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branchA; let cocinero; let employee; let template;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const upload = (who, raw, type = 'image/jpeg') => ctx.request('POST', '/api/uploads/photo', { token: who.token ?? who, raw, headers: { 'content-type': type } });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['rh'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['rh'] });
    branchA = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const u = await api(A, 'POST', '/api/users', { email: 'cocina@alfa.test', name: 'Chuy', role: 'cocina', password: 'clave-segura-9', branch_ids: [branchA.id] });
    cocinero = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'cocina@alfa.test', password: 'clave-segura-9' } })).body.token;
    employee = (await api(A, 'POST', '/api/employees', { full_name: 'Chuy Pérez', user_id: u.body.user.id, branch_id: branchA.id, daily_salary: 400, hire_date: '2026-01-01', pin: '4321' })).body.employee;
  });
  after(() => ctx?.close());

  test('subir foto: solo imagenes reales, nombre aleatorio', async () => {
    assert.equal((await api(cocinero, 'POST', '/api/uploads/photo', { a: 1 })).status, 400);
    assert.equal((await upload(cocinero, Buffer.from('no soy imagen'))).body.code, 'INVALID_IMAGE');
    const r = await upload(cocinero, JPG);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.url, new RegExp(`^/api/uploads/${A.id}/[a-f0-9-]+\\.jpg$`));
    assert.equal((await ctx.request('GET', r.body.url)).status, 200);
  });

  test('checklist del dia: foto obligatoria y envio completo', async () => {
    const t = await api(A, 'POST', '/api/rh/checklists/templates', {
      name: 'Apertura', items: [{ text: 'Encender campana' }, { text: 'Foto de la barra limpia', requires_photo: true }],
    });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    template = t.body.template;
    assert.equal((await api(cocinero, 'POST', '/api/rh/checklists/templates', { name: 'x', items: [{ text: 'y' }] })).status, 403);
    const today = (await api(cocinero, 'GET', `/api/rh/checklists/today?branch_id=${branchA.id}`)).body.runs;
    assert.equal(today.length, 1);
    const run = today[0];
    const [campana, barra] = run.items;
    await api(cocinero, 'PUT', `/api/rh/checklists/runs/${run.id}/items/${campana.id}`, { done: true });
    await api(cocinero, 'PUT', `/api/rh/checklists/runs/${run.id}/items/${barra.id}`, { done: true });
    const incomplete = await api(cocinero, 'POST', `/api/rh/checklists/runs/${run.id}/submit`);
    assert.equal(incomplete.body.code, 'CHECKLIST_INCOMPLETE', 'falta la foto');
    assert.equal((await api(cocinero, 'PUT', `/api/rh/checklists/runs/${run.id}/items/${barra.id}`, { done: true, photo_url: 'https://otro.sitio/x.jpg' })).body.code, 'INVALID_PHOTO');
    const photo = (await upload(cocinero, JPG)).body.url;
    await api(cocinero, 'PUT', `/api/rh/checklists/runs/${run.id}/items/${barra.id}`, { done: true, photo_url: photo });
    const sent = await api(cocinero, 'POST', `/api/rh/checklists/runs/${run.id}/submit`);
    assert.equal(sent.body.run.status, 'enviado');
    assert.equal((await api(cocinero, 'PUT', `/api/rh/checklists/runs/${run.id}/items/${campana.id}`, { done: false })).body.code, 'CHECKLIST_SENT');
    const hist = (await api(A, 'GET', `/api/rh/checklists/runs?branch_id=${branchA.id}`)).body.runs;
    assert.deepEqual([hist[0].done, hist[0].total], [2, 2]);
  });

  test('incidencia: la levanta el gerente y la firma el empleado', async () => {
    const photo = (await upload(A, JPG)).body.url;
    const i = await api(A, 'POST', '/api/rh/incidents', {
      employee_id: employee.id, kind: 'conducta', occurred_on: '2026-10-08', description: 'Discutió con un cliente', evidence: [photo],
    });
    assert.equal(i.status, 201, JSON.stringify(i.body));
    const mine = (await api(cocinero, 'GET', '/api/rh/me/incidents')).body.incidents;
    assert.equal(mine.length, 1);
    assert.equal((await api(cocinero, 'GET', '/api/rh/incidents')).status, 403);
    const signed = await api(cocinero, 'POST', `/api/rh/me/incidents/${i.body.incident.id}/sign`, { comment: 'El cliente me insultó' });
    assert.equal(signed.body.incident.status, 'firmada');
    assert.equal((await api(cocinero, 'POST', `/api/rh/me/incidents/${i.body.incident.id}/sign`)).status, 404, 'no se firma dos veces');
  });

  test('comunicados: vigentes para el usuario y con lectura', async () => {
    await api(A, 'POST', '/api/rh/announcements', { title: 'Junta el lunes', body: 'A las 9 am en la sucursal', priority: 'importante' });
    let feed = (await api(cocinero, 'GET', '/api/rh/announcements/feed')).body.announcements;
    assert.equal(feed.length, 1);
    assert.equal(feed[0].read, false);
    await api(cocinero, 'POST', `/api/rh/announcements/${feed[0].id}/read`);
    feed = (await api(cocinero, 'GET', '/api/rh/announcements/feed')).body.announcements;
    assert.equal(feed[0].read, true);
    assert.equal((await api(A, 'GET', '/api/rh/announcements')).body.announcements[0].reads, 1);
  });

  test('B no ve nada de A', async () => {
    assert.equal((await api(B, 'GET', '/api/rh/checklists/templates')).body.templates.length, 0);
    assert.equal((await api(B, 'GET', '/api/rh/incidents')).body.incidents.length, 0);
    assert.equal((await api(B, 'GET', '/api/rh/announcements/feed')).body.announcements.length, 0);
    assert.equal((await api(B, 'PATCH', `/api/rh/checklists/templates/${template.id}`, { name: 'x' })).status, 404);
  });
});
