// Pruebas unitarias de la integracion con Clip: estados, firma del webhook,
// validacion de la respuesta y cifrado de credenciales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkoutMismatch, normalizeClipStatus, signClipBody, verifyClipSignature, webhookCheckoutId,
} from '../services/clip/status.js';

test('normaliza los estados de Clip (webhook y GET /v2/checkout) como el original', () => {
  const cases = {
    CHECKOUT_CREATED: 'pending', CHECKOUT_PENDING: 'pending', CHECKOUT_COMPLETED: 'completed',
    CHECKOUT_CANCELLED: 'cancelled', CHECKOUT_EXPIRED: 'expired', COMPLETED: 'completed', PAID: 'completed',
    CANCELED: 'cancelled', EXPIRED: 'expired', REFUNDED: 'failed', declined: 'failed', algo_raro: 'pending',
  };
  for (const [raw, expected] of Object.entries(cases)) assert.equal(normalizeClipStatus(raw), expected, raw);
  assert.equal(normalizeClipStatus(null, { resource_status: 'COMPLETED' }), 'completed');
  assert.equal(normalizeClipStatus(undefined), 'pending');
});

test('firma del webhook: HMAC-SHA256 del cuerpo crudo, hex o base64, en tiempo constante', () => {
  const body = Buffer.from('{"payment_request_id":"abc"}');
  const secret = 'whsec-123';
  const hex = signClipBody(body, secret);
  assert.equal(verifyClipSignature(body, hex, secret), true);
  assert.equal(verifyClipSignature(body, `sha256=${hex}`, secret), true);
  const b64 = Buffer.from(hex, 'hex').toString('base64');
  assert.equal(verifyClipSignature(body, b64, secret), true);
  assert.equal(verifyClipSignature(body, hex, 'otro-secreto'), false);
  assert.equal(verifyClipSignature(Buffer.from('{"payment_request_id":"xyz"}'), hex, secret), false, 'cuerpo alterado');
  assert.equal(verifyClipSignature(body, undefined, secret), false);
  assert.equal(verifyClipSignature(body, 'corta', secret), false);
  assert.equal(verifyClipSignature(undefined, hex, secret), false);
});

test('id del checkout en el webhook y validacion de la respuesta de Clip', () => {
  assert.equal(webhookCheckoutId({ payment_request_id: 'a' }), 'a');
  assert.equal(webhookCheckoutId({ data: { checkout_id: 'b' } }), 'b');
  assert.equal(webhookCheckoutId({}), null);
  const local = { checkout_id: 'chk', amount: '925.00', currency: 'MXN' };
  assert.equal(checkoutMismatch(local, { payment_request_id: 'chk', amount: 925, currency: 'MXN' }), null);
  assert.equal(checkoutMismatch(local, { payment_request_id: 'otro' }), 'id');
  assert.equal(checkoutMismatch(local, { amount: 1 }), 'amount');
  assert.equal(checkoutMismatch(local, { amount: '925.001' }), null);
  assert.equal(checkoutMismatch(local, { currency: 'USD' }), 'currency');
});

test('credenciales cifradas con AES-256-GCM amarradas al restaurante', async () => {
  process.env.PAYMENT_SECRETS_KEY = Buffer.alloc(32, 3).toString('base64');
  const { encryptSecret, decryptSecret, secretsAvailable } = await import('../services/secrets.js');
  assert.equal(secretsAvailable(), true);
  const a = encryptSecret('mi-api-key', 'rest-a:clip_api_key');
  const b = encryptSecret('mi-api-key', 'rest-a:clip_api_key');
  assert.match(a, /^v1:/);
  assert.notEqual(a, b, 'IV aleatorio');
  assert.ok(!a.includes('mi-api-key'));
  assert.equal(decryptSecret(a, 'rest-a:clip_api_key'), 'mi-api-key');
  assert.throws(() => decryptSecret(a, 'rest-b:clip_api_key'), 'otro restaurante no lo descifra');
  const [p, iv, tag, data] = a.split(':');
  const flipped = Buffer.from(data, 'base64');
  flipped[0] ^= 1;
  assert.throws(() => decryptSecret([p, iv, tag, flipped.toString('base64')].join(':'), 'rest-a:clip_api_key'), 'alterado');
});
