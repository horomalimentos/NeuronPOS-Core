// Control de dispositivos (modulo "dispositivos"): cada equipo manda su llave
// en el header X-Device-Token; aqui se identifica y se exige que este
// autorizado para las acciones de caja.
import crypto from 'node:crypto';
import { withTenant } from '../config/database.js';
import { HttpError } from '../utils/http.js';
import { moduleActive } from '../routes/pos/common.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
export const hashDeviceToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const readDeviceToken = (req) => {
  const t = String(req.headers['x-device-token'] || '');
  return TOKEN_RE.test(t) ? t : null;
};

export async function findDevice(db, restaurantId, token) {
  if (!token) return null;
  return (await db.query('SELECT * FROM pos_devices WHERE restaurant_id = $1 AND token_hash = $2', [restaurantId, hashDeviceToken(token)])).rows[0] || null;
}

/**
 * Middleware: con el modulo activo, la peticion debe venir de un equipo
 * autorizado (deja req.device). Sin el modulo no hace nada.
 */
export async function requireDevice(req, res, next) {
  try {
    const device = await withTenant(req.tenant.id, async (db) => {
      if (!(await moduleActive(db, req.tenant.id, 'dispositivos'))) return undefined;
      const d = await findDevice(db, req.tenant.id, readDeviceToken(req));
      if (d?.status === 'activo') {
        await db.query('UPDATE pos_devices SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval \'1 minute\')', [d.id]);
      }
      return d;
    });
    if (device === undefined) return next();
    if (!device || device.status !== 'activo') {
      throw new HttpError(403, device?.status === 'pendiente'
        ? 'Este equipo espera la autorizacion del gerente'
        : 'Este equipo no esta autorizado para la caja. Pide su alta en Caja.', 'DEVICE_NOT_AUTHORIZED');
    }
    req.device = device;
    next();
  } catch (err) {
    next(err);
  }
}

/** El equipo autorizado solo trabaja con su sucursal. */
export function assertDeviceBranch(req, branchId) {
  if (req.device && req.device.branch_id !== branchId) {
    throw new HttpError(403, 'Este equipo esta autorizado para otra sucursal', 'DEVICE_WRONG_BRANCH');
  }
}
