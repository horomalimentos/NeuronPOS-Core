// PIN de autorizacion del gerente (como el PIN rotativo de Horom): admin y
// gerente ven en su pantalla un codigo de 6 digitos que cambia cada 10
// minutos y se lo dictan al cajero para autorizar un descuento mayor a su
// limite. No se guarda nada: el codigo sale de un HMAC del usuario y la
// ventana de tiempo. Se aceptan la ventana actual y la anterior.
import crypto from 'node:crypto';
import { env } from '../config/env.js';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;
const fails = new Map(); // userId -> { count, until }

export function pinFor(userId, at = Date.now()) {
  const win = Math.floor(at / WINDOW_MS);
  const h = crypto.createHmac('sha256', String(env.jwtSecret)).update(`aprobacion:${userId}:${win}`).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}

export function pinExpiresAt(at = Date.now()) {
  return new Date((Math.floor(at / WINDOW_MS) + 1) * WINDOW_MS).toISOString();
}

/** Limite de intentos por usuario que captura el PIN (5 fallos = espera 10 min). */
export function pinLocked(userId, at = Date.now()) {
  const f = fails.get(userId);
  return Boolean(f && f.count >= MAX_FAILS && f.until > at);
}

/**
 * Busca al gerente/admin activo del restaurante cuyo PIN coincide. Regresa su
 * id o null. Cuenta los fallos de quien lo captura.
 */
export async function verifyApprovalPin(db, restaurantId, capturedBy, pin, at = Date.now()) {
  if (!/^\d{6}$/.test(String(pin || ''))) return null;
  const managers = (await db.query(
    "SELECT id FROM users WHERE restaurant_id = $1 AND active AND role IN ('admin', 'gerente')",
    [restaurantId],
  )).rows;
  for (const m of managers) {
    for (const t of [at, at - WINDOW_MS]) {
      const expected = pinFor(m.id, t);
      if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(pin)))) {
        fails.delete(capturedBy);
        return m.id;
      }
    }
  }
  const f = fails.get(capturedBy);
  fails.set(capturedBy, { count: (f && f.until > at ? f.count : 0) + 1, until: at + WINDOW_MS });
  return null;
}
