// Cifrado de secretos guardados en la BD (credenciales de Clip de cada
// restaurante) con AES-256-GCM.
//
// La llave vive solo en el entorno (PAYMENT_SECRETS_KEY: 32 bytes en base64
// o hex), nunca en la BD. Cada valor lleva su propio IV aleatorio y la
// etiqueta de autenticacion; ademas se usa el restaurant_id como dato
// asociado (AAD), asi que un valor cifrado copiado a la fila de otro
// restaurante no se puede descifrar.
//
// Formato guardado: v1:<iv base64>:<tag base64>:<cifrado base64>
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http.js';

const PREFIX = 'v1';

function parseKey(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  let buf = null;
  if (/^[0-9a-f]{64}$/i.test(value)) buf = Buffer.from(value, 'hex');
  else {
    try { buf = Buffer.from(value, 'base64'); } catch { buf = null; }
  }
  return buf && buf.length === 32 ? buf : null;
}

/** true si hay una llave valida para cifrar/descifrar. */
export const secretsAvailable = () => Boolean(parseKey(env.paymentSecretsKey));

function key() {
  const k = parseKey(env.paymentSecretsKey);
  if (!k) {
    throw new HttpError(
      503,
      'El servidor no tiene configurada la llave de cifrado (PAYMENT_SECRETS_KEY). Avisa a NeuronPOS.',
      'SECRETS_KEY_MISSING',
    );
  }
  return k;
}

export function encryptSecret(plain, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad)));
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

/** Descifra; lanza si la llave cambio, el valor se altero o el AAD no coincide. */
export function decryptSecret(stored, aad) {
  if (!stored) return null;
  const [prefix, iv, tag, data] = String(stored).split(':');
  if (prefix !== PREFIX || !iv || !tag || data === undefined) throw new Error('Secreto cifrado con formato desconocido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(String(aad)));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
