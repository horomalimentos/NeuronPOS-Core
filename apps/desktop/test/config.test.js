import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitize } from '../src/config.js';

test('sanitize conserva los tipos de impresora validos y descarta los demas', () => {
  const cfg = sanitize({
    url: 'https://tacos.neuronpos.app/',
    printers: { ticket: { type: 'usb', name: 'POS-80', paper: 58, drawer: true }, comanda: { type: 'serial' } },
  });
  assert.equal(cfg.url, 'https://tacos.neuronpos.app');
  assert.deepEqual(cfg.printers.ticket, { type: 'usb', name: 'POS-80', host: '', port: 9100, paper: 58, drawer: true });
  assert.equal(cfg.printers.comanda.type, 'none');
});
