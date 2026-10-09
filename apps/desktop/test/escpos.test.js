import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeUrl, sanitize } from '../src/config.js';
import { rasterJob, toMonochrome, trimBottom } from '../src/escpos.js';

test('toMonochrome: negro = 1, blanco y transparente = 0 (BGRA)', () => {
  // 9 x 1: negro, blanco, transparente, 6 negros
  const px = [];
  const push = (b, g, r, a) => px.push(b, g, r, a);
  push(0, 0, 0, 255); push(255, 255, 255, 255); push(0, 0, 0, 0);
  for (let i = 0; i < 6; i += 1) push(10, 10, 10, 255);
  const { data, bytesPerRow } = toMonochrome(Buffer.from(px), 9, 1);
  assert.equal(bytesPerRow, 2);
  assert.equal(data[0], 0b10011111);
  assert.equal(data[1], 0b10000000);
});

test('trimBottom quita las filas blancas del final', () => {
  const mono = { data: Buffer.from([0x80, 0x00, 0x00]), bytesPerRow: 1 };
  assert.equal(trimBottom(mono, 3), 1);
});

test('rasterJob arma GS v 0 por franjas, corte y cajon', () => {
  const height = 300;
  const mono = { data: Buffer.alloc(72 * height, 0xff), bytesPerRow: 72 };
  const job = rasterJob(mono, height, { openDrawer: true });
  assert.deepEqual([...job.subarray(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...job.subarray(2, 7)], [0x1b, 0x70, 0x00, 0x19, 0xfa]);
  // Primera franja: 256 filas de 72 bytes
  assert.deepEqual([...job.subarray(7, 15)], [0x1d, 0x76, 0x30, 0x00, 72, 0, 0, 1]);
  const second = 15 + 72 * 256;
  assert.deepEqual([...job.subarray(second, second + 8)], [0x1d, 0x76, 0x30, 0x00, 72, 0, 44, 0]);
  assert.deepEqual([...job.subarray(-4)], [0x1d, 0x56, 0x42, 0x00]);
});

test('normalizeUrl acepta el nombre corto, el dominio o la URL', () => {
  assert.equal(normalizeUrl('Tacos'), 'https://tacos.neuronpos.app');
  assert.equal(normalizeUrl('tacos.neuronpos.app/admin/pos'), 'https://tacos.neuronpos.app');
  assert.equal(normalizeUrl('https://pedidos.mitaqueria.mx/'), 'https://pedidos.mitaqueria.mx');
  assert.equal(normalizeUrl('http://tacos.neuronpos.app'), '');
  assert.equal(normalizeUrl('http://tacos.localhost:5173'), 'http://tacos.localhost:5173');
  assert.equal(normalizeUrl(''), '');
});

test('sanitize limpia tipos, puertos y papel', () => {
  const c = sanitize({ url: 'tacos', printers: { ticket: { type: 'network', host: ' 10.0.0.5 ', port: '99999', paper: 58, drawer: 1 }, comanda: { type: 'x' } } });
  assert.equal(c.url, 'https://tacos.neuronpos.app');
  assert.deepEqual(c.printers.ticket, { type: 'network', name: '', host: '10.0.0.5', port: 9100, paper: 58, drawer: true });
  assert.equal(c.printers.comanda.type, 'none');
});
