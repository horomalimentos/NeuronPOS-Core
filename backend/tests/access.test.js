import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkModuleAccess, checkRestaurantAccess } from '../services/access.js';
import { parseHost } from '../middleware/tenant.js';

const now = new Date('2026-10-15T12:00:00Z');
const active = { id: 'x', status: 'active', trial_ends_at: null };
const pos = { module_code: 'pos', name: 'Punto de venta', enabled: true, started_at: null, ends_at: null };

test('requireModule (logica): deja pasar con modulo contratado', () => {
  assert.equal(checkModuleAccess(active, 'pos', pos, now), null);
  assert.equal(checkModuleAccess({ ...active, status: 'trial', trial_ends_at: '2026-10-20' }, 'pos', pos, now), null);
});

test('requireModule (logica): 402 si el modulo no esta contratado', () => {
  for (const row of [null, { ...pos, enabled: false }, { ...pos, enabled: null }, { ...pos, ends_at: '2026-10-01' }]) {
    const r = checkModuleAccess(active, 'pos', row, now);
    assert.equal(r.status, 402);
    assert.equal(r.code, 'MODULE_NOT_ENABLED');
    assert.match(r.error, /Contrata este módulo/);
  }
  assert.match(checkModuleAccess(active, 'pos', { ...pos, enabled: false }, now).error, /"Punto de venta"/);
});

test('requireModule (logica): 402 si el restaurante esta suspendido o vencio la prueba', () => {
  const s = checkModuleAccess({ ...active, status: 'suspended' }, 'pos', pos, now);
  assert.equal(s.status, 402);
  assert.equal(s.code, 'RESTAURANT_SUSPENDED');
  assert.match(s.error, /suspendido/);
  const t = checkModuleAccess({ ...active, status: 'trial', trial_ends_at: '2026-10-01' }, 'pos', pos, now);
  assert.equal(t.code, 'TRIAL_EXPIRED');
  assert.equal(checkRestaurantAccess(null).status, 404);
});

test('parseHost: subdominio, dominio propio y hosts de plataforma', () => {
  const reserved = ['www', 'api', 'panel'];
  const d = 'neuronpos.mx';
  assert.deepEqual(parseHost('horom.neuronpos.mx', d, reserved), { slug: 'horom' });
  assert.deepEqual(parseHost('Horom.NeuronPOS.mx:443', d, reserved), { slug: 'horom' });
  assert.deepEqual(parseHost('www.horomsushi.com', d, reserved), { customDomain: 'www.horomsushi.com' });
  assert.deepEqual(parseHost('horom.localhost:5173', d, reserved), { slug: 'horom' });
  assert.equal(parseHost('neuronpos.mx', d, reserved), null);
  assert.equal(parseHost('www.neuronpos.mx', d, reserved), null);
  assert.equal(parseHost('panel.neuronpos.mx', d, reserved), null);
  assert.equal(parseHost('a.b.neuronpos.mx', d, reserved), null);
  assert.equal(parseHost('localhost:8100', d, reserved), null);
  assert.equal(parseHost('127.0.0.1:8100', d, reserved), null);
  assert.equal(parseHost(undefined, d, reserved), null);
});
