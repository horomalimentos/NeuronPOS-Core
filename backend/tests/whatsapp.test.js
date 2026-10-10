// Bot de WhatsApp: configuracion por restaurante, webhook firmado y enrutado
// por numero, pedido completo en el chat (crea un pedido en linea normal),
// avisos de estado, preguntas frecuentes, paso a una persona, ventana de
// 24 h, mensajes repetidos, modulo requerido y aislamiento.
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const SECRET = 'app-secret-alfa';
const PNID = '1098765432';
const ANA = '5216561234567';

describe('bot de WhatsApp', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branch; let taco; let agua; let salsa; let cat; let cajero; let gerente;
  let client; let inbound; let notify;
  let sent = [];
  let n = 0;
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });

  async function hook(messages, { from = ANA, name = 'Ana López', pnid = PNID, secret = SECRET } = {}) {
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: pnid, display_phone_number: '5216560000000' },
        contacts: [{ wa_id: from, profile: { name } }],
        messages: messages.map((m) => ({ from, id: m.id || `wamid.${++n}`, timestamp: '1', ...m })),
      } }] }],
    };
    const raw = Buffer.from(JSON.stringify(body));
    const sig = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    const r = await ctx.request('POST', '/api/webhooks/whatsapp', { raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
    await inbound.whatsappIdle();
    return r;
  }
  const say = async (text, opts) => { sent = []; await hook([{ type: 'text', text: { body: text } }], opts); return sent; };
  const tap = async (id, opts) => {
    sent = [];
    await hook([{ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: id } } }], opts);
    return sent;
  };
  const last = (list) => list[list.length - 1]?.payload;
  const rowsOf = (p) => p.interactive.action.sections?.[0].rows.map((r) => r.id) ?? p.interactive.action.buttons.map((b) => b.reply.id);
  const bodyOf = (p) => (p.type === 'text' ? p.text.body : p.interactive.body.text);

  before(async () => {
    ctx = await setupDb();
    client = await import('../services/whatsapp/client.js');
    inbound = await import('../services/whatsapp/inbound.js');
    notify = await import('../services/whatsapp/notify.js');
    client.setWhatsAppTransport(async (creds, payload) => {
      sent.push({ creds, payload });
      return { ok: true, id: `out.${sent.length}.${Date.now()}` };
    });
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal', 'domicilios', 'whatsapp'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos', 'whatsapp'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    await api(A, 'PATCH', `/api/branches/${branch.id}`, { address: 'Av. Juárez 100, Centro' });
    await api(A, 'PUT', `/api/branches/${branch.id}/hours`, { hours: ALL_DAY });
    await api(A, 'PATCH', '/api/online/settings', { enabled: true });
    await api(A, 'PUT', `/api/online/branches/${branch.id}`, { delivery_fee: 25 });
    cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    salsa = (await api(A, 'POST', '/api/pos/modifier-groups', {
      name: 'Salsa', min_selections: 1, max_selections: 1, modifiers: [{ name: 'Verde' }, { name: 'Roja', price_delta: 5 }],
    })).body.group;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco de asada', price: 100, modifier_group_ids: [salsa.id] })).body.item;
    agua = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Agua de horchata', price: 30 })).body.item;
    for (const [role, email] of [['cajero', 'caja@alfa.test'], ['gerente', 'gerente@alfa.test']]) {
      await api(A, 'POST', '/api/users', { email, name: role, role, password: 'clave-segura-9', branch_ids: [branch.id] });
    }
    cajero = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'caja@alfa.test', password: 'clave-segura-9' } })).body;
    gerente = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'gerente@alfa.test', password: 'clave-segura-9' } })).body;
  });
  after(() => { client?.setWhatsAppTransport(null); return ctx?.close(); });

  test('configuracion: solo admin, llaves cifradas, numero unico', async () => {
    assert.equal((await api(gerente, 'GET', '/api/whatsapp/settings')).status, 403);
    const incomplete = await api(A, 'PUT', '/api/whatsapp/settings', { enabled: true, phone_number_id: PNID });
    assert.equal(incomplete.body.code, 'WHATSAPP_INCOMPLETE');
    const r = await api(A, 'PUT', '/api/whatsapp/settings', {
      enabled: true, phone_number_id: PNID, display_phone: '656 000 0000', access_token: 'EAAG-token-alfa', app_secret: SECRET,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.settings.has_access_token, r.body.settings.has_app_secret], [true, true]);
    assert.ok(!JSON.stringify(r.body).includes('EAAG-token-alfa'));
    assert.equal(r.body.settings.webhook_url, 'https://api.neuronpos.test/api/webhooks/whatsapp');
    const raw = await ctx.withPlatform((db) => db.query('SELECT access_token_enc FROM whatsapp_settings WHERE restaurant_id = $1', [A.id]));
    assert.ok(!raw.rows[0].access_token_enc.includes('EAAG'));
    assert.equal((await api(B, 'PUT', '/api/whatsapp/settings', { phone_number_id: PNID })).body.code, 'PHONE_TAKEN');

    const token = r.body.settings.verify_token;
    const ok = await ctx.request('GET', `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`);
    assert.deepEqual([ok.status, ok.body], [200, 12345]);
    assert.equal((await ctx.request('GET', '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1')).status, 403);
  });

  test('firma invalida: 401 y no se procesa', async () => {
    sent = [];
    const r = await hook([{ type: 'text', text: { body: 'hola' } }], { secret: 'otro' });
    assert.equal(r.status, 401);
    assert.equal(sent.length, 0);
  });

  test('pedido completo para recoger, con modificador y cambio', async () => {
    let out = await say('Hola');
    assert.equal(out.length, 1);
    assert.equal(out[0].payload.to, ANA);
    assert.equal(out[0].creds.accessToken, 'EAAG-token-alfa');
    assert.deepEqual(rowsOf(last(out)), ['pedir', 'estado', 'horario', 'humano']);
    assert.match(bodyOf(last(out)), /Hola Ana/);

    out = await tap('pedir');
    assert.deepEqual(rowsOf(last(out)), ['tipo:para_llevar', 'tipo:domicilio']);
    out = await tap('tipo:para_llevar');
    assert.deepEqual(rowsOf(last(out)), [`c:${cat.id}`]);
    out = await say('1'); // el numero de la opcion tambien sirve
    assert.deepEqual(rowsOf(last(out)), [`p:${agua.id}`, `p:${taco.id}`, 'cats']);
    out = await tap(`p:${taco.id}`);
    assert.match(bodyOf(last(out)), /Salsa/);
    const roja = salsa.modifiers.find((m) => m.name === 'Roja');
    assert.ok(!rowsOf(last(out)).includes('m:none'), 'obligatorio: sin "Ninguno"');
    out = await tap(`m:${roja.id}`);
    assert.deepEqual(rowsOf(last(out)), ['q:1', 'q:2', 'q:3']);
    out = await say('2');
    assert.match(bodyOf(last(out)), /2 × Taco de asada \(Roja\) — \$210\.00/);
    out = await say('horchata'); // busqueda desde el carrito
    assert.deepEqual(rowsOf(last(out)), ['q:1', 'q:2', 'q:3']);
    out = await tap('q:1');
    assert.match(bodyOf(last(out)), /Llevas \$240\.00/);
    out = await tap('pagar');
    assert.deepEqual(rowsOf(last(out)), ['nombre:perfil']);
    out = await tap('nombre:perfil');
    assert.deepEqual(rowsOf(last(out)), ['pago:efectivo', 'pago:tarjeta']);
    out = await tap('pago:efectivo');
    assert.match(bodyOf(last(out)), /Total: \*\$240\.00\*/);
    out = await say('100');
    assert.match(bodyOf(out[0].payload), /debe cubrir/);
    out = await say('$500');
    const summary = bodyOf(last(out));
    assert.match(summary, /\*Total \$240\.00\*/);
    assert.match(summary, /pagas con \$500\.00/);
    assert.match(summary, /A nombre de: Ana López/);
    out = await tap('confirmar');
    const done = bodyOf(last(out));
    assert.match(done, /Recibimos tu pedido \*#\d+\* por \$240\.00/);
    assert.match(done, /https:\/\/alfa\.neuronpos\.test\/pedido\/[\w-]+/);

    const orders = (await api(cajero, 'GET', `/api/pos/online-orders?branch_id=${branch.id}`)).body.orders;
    const o = orders.find((x) => x.customer_phone === `+${ANA}`);
    assert.ok(o, JSON.stringify(orders));
    assert.deepEqual([Number(o.total), o.order_type, o.customer_name, o.pay_with === null ? null : Number(o.pay_with)], [240, 'para_llevar', 'Ana López', 500]);
    const row = (await ctx.withPlatform((db) => db.query('SELECT channel, notes FROM orders WHERE id = $1', [o.id]))).rows[0];
    assert.deepEqual([row.channel, row.notes], ['whatsapp', 'Pedido por WhatsApp']);

    // Aviso al aceptar (dentro de la ventana de 24 h).
    sent = [];
    assert.equal((await api(cajero, 'POST', `/api/pos/online-orders/${o.id}/accept`, {})).status, 200);
    assert.equal(await notify.dispatchWhatsAppOutbox(), 1);
    assert.match(bodyOf(sent[0].payload), /aceptado/);
    assert.equal(await notify.dispatchWhatsAppOutbox(), 0, 'una sola vez');

    out = await say('menu');
    out = await tap('estado');
    assert.match(bodyOf(out[0].payload), new RegExp(`Pedido #${o.folio}\\* · En preparación`));
  });

  test('a domicilio: pide la direccion y cobra el envio', async () => {
    const LUIS = '5216569998877';
    await say('hola', { from: LUIS, name: 'Luis' });
    await tap('pedir', { from: LUIS });
    await tap('tipo:domicilio', { from: LUIS });
    await say('agua', { from: LUIS });
    await tap('q:2', { from: LUIS });
    let out = await tap('pagar', { from: LUIS });
    assert.match(bodyOf(last(out)), /dirección/);
    out = await say('corta', { from: LUIS });
    assert.match(bodyOf(out[0].payload), /completa/);
    out = await say('Calle Pino 12, Col. Centro, casa azul', { from: LUIS });
    await tap('nombre:perfil', { from: LUIS });
    await tap('pago:tarjeta', { from: LUIS });
    out = await tap('confirmar', { from: LUIS });
    assert.match(bodyOf(last(out)), /por \$85\.00/);
    const o = (await api(cajero, 'GET', `/api/pos/online-orders?branch_id=${branch.id}`)).body.orders.find((x) => x.customer_phone === `+${LUIS}`);
    assert.deepEqual([o.order_type, o.customer_address, Number(o.delivery_fee)], ['domicilio', 'Calle Pino 12, Col. Centro, casa azul', 25]);
  });

  test('preguntas frecuentes en el menu', async () => {
    await api(A, 'PUT', '/api/whatsapp/settings', { faqs: [{ question: '¿Tienen estacionamiento?', answer: 'Sí, enfrente del local.' }] });
    const menu = await say('buenas tardes');
    assert.ok(rowsOf(last(menu)).includes('faq:0'));
    const out = await tap('faq:0');
    assert.equal(bodyOf(out[0].payload), 'Sí, enfrente del local.');
    assert.equal((await api(A, 'PUT', '/api/whatsapp/settings', { faqs: [{ question: 'x'.repeat(30), answer: 'y' }] })).status, 400);
  });

  test('paso a una persona, respuesta del personal y regreso al bot', async () => {
    let out = await say('Quiero hablar con un asesor');
    assert.match(bodyOf(out[0].payload), /persona/);
    out = await say('¿Hacen pasteles por encargo?');
    assert.equal(out.length, 0, 'el bot ya no contesta');
    assert.equal((await api(cajero, 'GET', '/api/whatsapp/pending-count')).body.count, 1);
    const list = (await api(cajero, 'GET', '/api/whatsapp/conversations?filter=atencion')).body.conversations;
    assert.equal(list.length, 1);
    const conv = list[0];
    assert.deepEqual([conv.profile_name, conv.mode], ['Ana López', 'humano']);
    const detail = (await api(cajero, 'GET', `/api/whatsapp/conversations/${conv.id}`)).body;
    assert.ok(detail.messages.some((m) => m.direction === 'in' && m.body === '¿Hacen pasteles por encargo?'));
    assert.equal(detail.conversation.window_open, true);
    assert.equal(detail.orders.length, 1);

    sent = [];
    const r = await api(cajero, 'POST', `/api/whatsapp/conversations/${conv.id}/messages`, { text: 'Sí, con 2 días de anticipación.' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([sent[0].payload.to, sent[0].payload.text.body], [ANA, 'Sí, con 2 días de anticipación.']);
    assert.equal(r.body.message.sender, 'personal');
    assert.equal((await api(cajero, 'GET', '/api/whatsapp/pending-count')).body.count, 0);

    assert.equal((await api(cajero, 'POST', `/api/whatsapp/conversations/${conv.id}/release`)).status, 200);
    out = await say('gracias');
    assert.equal(last(out).interactive.type, 'list', 'de vuelta al menu del bot');

    // Ventana de 24 h cerrada: no se puede escribir libremente.
    await ctx.withPlatform((db) => db.query(
      "UPDATE whatsapp_conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1", [conv.id],
    ));
    const closed = await api(cajero, 'POST', `/api/whatsapp/conversations/${conv.id}/messages`, { text: 'Hola' });
    assert.equal(closed.body.code, 'WINDOW_CLOSED');
  });

  test('un mensaje repetido por Meta se procesa una vez', async () => {
    sent = [];
    await hook([{ id: 'wamid.repetido', type: 'text', text: { body: 'hola' } }]);
    await hook([{ id: 'wamid.repetido', type: 'text', text: { body: 'hola' } }]);
    assert.equal(sent.length, 1);
  });

  test('sin el modulo: el bot calla y el panel responde 402; aislamiento', async () => {
    assert.equal((await api(B, 'GET', '/api/whatsapp/conversations')).body.conversations.length, 0);
    await api(owner, 'PUT', `/api/platform/restaurants/${A.id}/modules/whatsapp`, { enabled: false });
    const out = await say('hola');
    assert.equal(out.length, 0);
    assert.equal((await api(A, 'GET', '/api/whatsapp/conversations')).status, 402);
    await api(owner, 'PUT', `/api/platform/restaurants/${A.id}/modules/whatsapp`, { enabled: true });
  });
});
