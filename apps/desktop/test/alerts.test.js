import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAlerts, firstPending } from '../src/alerts.js';

test('firstPending toma el primer pedido y descarta ligas externas', () => {
  assert.equal(firstPending({ pending: [] }), null);
  assert.equal(firstPending(null), null);
  const o = firstPending({ pending: [{ id: 'a', title: 'Nuevo pedido', body: 'x', link: '//malo.com' }] });
  assert.deepEqual(o, { id: 'a', title: 'Nuevo pedido', body: 'x', link: '' });
  assert.equal(firstPending({ pending: [{ id: 'b', link: '/admin/delivery' }] }).link, '/admin/delivery');
});

test('suena mientras hay pendientes, se calla al atenderse y se apaga con 401', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alertas-'));
  const replies = [
    { status: 200, body: { pending: [{ id: 'p1', title: 'Nuevo pedido' }] } },
    { status: 200, body: { pending: [] } },
    { status: 401, body: {} },
  ];
  const events = [];
  let expired = false;
  const alerts = createAlerts({
    dir,
    fetch: async (url, opts) => {
      assert.equal(url, 'https://tacos.neuronpos.app/api/alertas');
      assert.equal(opts.headers.Authorization, 'Bearer tok');
      const r = replies.shift();
      return { status: r.status, ok: r.status === 200, json: async () => r.body };
    },
    onRing: (o, fresh) => events.push(['ring', o.id, fresh]),
    onQuiet: () => events.push(['quiet']),
    onExpired: () => { expired = true; },
  });
  alerts.start('https://tacos.neuronpos.app', 'tok', 5);
  assert.ok(fs.existsSync(path.join(dir, 'alertas.json')), 'guarda el token para la siguiente vez');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, [['ring', 'p1', true]]);
  alerts.stop();
  assert.deepEqual(events, [['ring', 'p1', true], ['quiet']]);
  assert.equal(alerts.active(), false);
  assert.equal(fs.existsSync(path.join(dir, 'alertas.json')), false);
  assert.equal(expired, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
