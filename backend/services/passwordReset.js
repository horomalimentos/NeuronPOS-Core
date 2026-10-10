// Recuperar contrasena (clientes del portal y personal del restaurante).
//
// - El token va solo en el correo; en la base queda su sha256.
// - Vence en 1 hora, sirve una vez y pedir otro invalida el anterior.
// - Pedir otro antes de 1 minuto no manda otro correo (evita inundar el buzon).
// - Al cambiar la contrasena se marca password_changed_at: las sesiones
//   abiertas antes de ese momento dejan de servir (ver middleware/auth.js).
import crypto from 'node:crypto';
import { badRequest } from '../utils/http.js';

export const RESET_TTL_MINUTES = 60;
const RESEND_AFTER_SECONDS = 60;
const TABLES = new Set(['customers', 'users']);

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest();

function table(name) {
  if (!TABLES.has(name)) throw new Error(`tabla no permitida: ${name}`);
  return name;
}

/**
 * Crea el token de una cuenta con contrasena y activa. Regresa
 * { token, account } o null (no existe, sin contrasena, inactiva o muy seguido).
 */
export async function createResetToken(db, tableName, restaurantId, email) {
  const t = table(tableName);
  const account = (await db.query(
    `SELECT id, name, email, reset_expires_at FROM ${t}
      WHERE restaurant_id = $1 AND email = $2 AND password_hash IS NOT NULL AND active FOR UPDATE`,
    [restaurantId, email],
  )).rows[0];
  if (!account) return null;
  const issuedAt = account.reset_expires_at
    ? new Date(account.reset_expires_at).getTime() - RESET_TTL_MINUTES * 60000 : 0;
  if (Date.now() - issuedAt < RESEND_AFTER_SECONDS * 1000) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `UPDATE ${t} SET reset_token_hash = $3, reset_expires_at = now() + make_interval(mins => $4::int)
      WHERE id = $1 AND restaurant_id = $2`,
    [account.id, restaurantId, hashToken(token), RESET_TTL_MINUTES],
  );
  return { token, account };
}

/** Lee el token del cuerpo (43 caracteres base64url). */
export function readResetToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw invalidToken();
  return token;
}

const invalidToken = () => badRequest('La liga para cambiar tu contraseña no es válida o ya venció. Pide otra.', 'INVALID_RESET_TOKEN');

/**
 * Cambia la contrasena con el token (una sola vez). Regresa la cuenta
 * (id, restaurant_id, ...cols). Lanza INVALID_RESET_TOKEN si no sirve.
 */
export async function consumeResetToken(db, tableName, restaurantId, token, passwordHash, cols = 'id, restaurant_id') {
  const t = table(tableName);
  const row = (await db.query(
    `UPDATE ${t} SET password_hash = $3, password_changed_at = now(), reset_token_hash = NULL, reset_expires_at = NULL,
            updated_at = now()
      WHERE restaurant_id = $1 AND reset_token_hash = $2 AND reset_expires_at > now() AND active
      RETURNING ${cols}`,
    [restaurantId, hashToken(token), passwordHash],
  )).rows[0];
  if (!row) throw invalidToken();
  return row;
}

/** true si el token se emitio antes del ultimo cambio de contrasena. */
export function issuedBeforePasswordChange(payload, changedAt) {
  if (!changedAt || !payload?.iat) return false;
  return payload.iat < Math.floor(new Date(changedAt).getTime() / 1000);
}
