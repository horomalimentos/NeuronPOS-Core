// requireModule('pos'): deja pasar solo si el restaurante esta operando
// (no suspendido / prueba vigente) y tiene el modulo contratado.
// Responde 402 con mensaje en espanol en caso contrario.
import { withTenant } from '../config/database.js';
import { checkModuleAccess, checkRestaurantAccess } from '../services/access.js';

export async function loadModuleRow(restaurantId, moduleCode) {
  return withTenant(restaurantId, async (db) => {
    const { rows } = await db.query(
      `SELECT m.code AS module_code, m.name, rm.enabled, rm.started_at, rm.ends_at
         FROM modules m
         LEFT JOIN restaurant_modules rm
           ON rm.module_code = m.code AND rm.restaurant_id = $1
        WHERE m.code = $2`,
      [restaurantId, moduleCode],
    );
    return rows[0] || null;
  });
}

export function requireModule(moduleCode) {
  return async (req, res, next) => {
    try {
      const row = req.tenant ? await loadModuleRow(req.tenant.id, moduleCode) : null;
      const denied = checkModuleAccess(req.tenant, moduleCode, row);
      if (denied) {
        const { status, ...body } = denied;
        return res.status(status).json(body);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Rutas de administracion que no dependen de un modulo (sucursales,
 * usuarios): un restaurante suspendido o con la prueba vencida solo puede
 * entrar a "Mi suscripcion" para pagar. Responde 402 igual que requireModule.
 */
export function requireOperational(req, res, next) {
  const denied = checkRestaurantAccess(req.tenant);
  if (denied) {
    const { status, ...body } = denied;
    return res.status(status).json(body);
  }
  next();
}

/**
 * Deja pasar si el restaurante tiene contratado al menos uno de los modulos
 * (p. ej. la lista de empleados la usan 'rh' y 'empleado_mes'). Si no tiene
 * ninguno responde el 402 del primero.
 */
export function requireAnyModule(...moduleCodes) {
  return async (req, res, next) => {
    try {
      let firstDenied = null;
      for (const code of moduleCodes) {
        const row = req.tenant ? await loadModuleRow(req.tenant.id, code) : null;
        const denied = checkModuleAccess(req.tenant, code, row);
        if (!denied) return next();
        firstDenied = firstDenied || denied;
      }
      const { status, ...body } = firstDenied;
      return res.status(status).json(body);
    } catch (err) {
      next(err);
    }
  };
}
