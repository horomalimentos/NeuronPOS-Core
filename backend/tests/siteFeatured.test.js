// Sitio: platillos destacados (en el orden elegido, solo activos) y portada en carrusel.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('sitio: destacados y carrusel', { skip: SKIP_DB }, () => {
  let ctx; let A; let items;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });

  before(async () => {
    ctx = await setupDb();
    const owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'landing'] });
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Menu' })).body.category;
    items = [];
    for (const [name, price] of [['Taco', 30], ['Torta', 80], ['Agua', 20]]) items.push((await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name, price })).body.item);
  });
  after(() => ctx?.close());

  test('destacados en el orden elegido', async () => {
    assert.equal((await api(A, 'PATCH', '/api/website/content', { featured_item_ids: ['no-es-uuid'] })).status, 400);
    assert.equal((await api(A, 'PATCH', '/api/website/content', { featured_item_ids: Array(9).fill(items[0].id) })).status, 400);
    const r = await api(A, 'PATCH', '/api/website/content', {
      show_featured: true, featured_title: 'Lo más pedido', featured_item_ids: [items[1].id, items[0].id], hero_carousel: true,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let site = (await ctx.request('GET', '/api/public/landing', { slug: 'alfa' })).body;
    assert.deepEqual(site.featured.map((i) => i.name), ['Torta', 'Taco']);
    assert.equal(site.content.hero_carousel, true);
    assert.equal(site.content.featured_title, 'Lo más pedido');
    // Un producto desactivado ya no sale.
    await api(A, 'PATCH', `/api/pos/items/${items[1].id}`, { active: false });
    site = (await ctx.request('GET', '/api/public/landing', { slug: 'alfa' })).body;
    assert.deepEqual(site.featured.map((i) => i.name), ['Taco']);
    await api(A, 'PATCH', '/api/website/content', { show_featured: false });
    assert.deepEqual((await ctx.request('GET', '/api/public/landing', { slug: 'alfa' })).body.featured, []);
  });
});
