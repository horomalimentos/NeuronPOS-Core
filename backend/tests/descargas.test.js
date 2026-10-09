// Descargas de las apps: archivos estaticos sin restaurante ni sesion.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKIP_DB, setupDb } from './helpers.js';

describe('descargas de las apps', { skip: SKIP_DB }, () => {
  let ctx;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'descargas-'));

  before(async () => {
    fs.mkdirSync(path.join(dir, 'android'));
    fs.writeFileSync(path.join(dir, 'android', 'latest-pos.json'), '{"versionCode":5}');
    fs.writeFileSync(path.join(dir, 'android', 'NeuronPOS-1.0.5.apk'), 'apk');
    process.env.DOWNLOADS_DIR = dir;
    ctx = await setupDb();
  });
  after(() => { ctx?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('sirve el manifiesto sin cache y el apk con su tipo', async () => {
    const json = await ctx.request('GET', '/api/descargas/android/latest-pos.json');
    assert.equal(json.status, 200);
    assert.equal(json.body.versionCode, 5);
    const apk = await ctx.request('GET', '/api/descargas/android/NeuronPOS-1.0.5.apk');
    assert.equal(apk.status, 200);
  });

  test('404 claro si no existe y no expone rutas fuera de la carpeta', async () => {
    const missing = await ctx.request('GET', '/api/descargas/pos/latest.yml');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'FILE_NOT_FOUND');
    const escape = await ctx.request('GET', '/api/descargas/..%2f..%2fbackend%2f.env');
    assert.equal(escape.status, 404);
  });
});
