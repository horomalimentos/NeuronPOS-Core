// Capacidades del POS por rol, con lo que cada restaurante cambie en
// role_permissions (como los permisos de Horom). El admin siempre puede todo.
import { withTenant } from '../config/database.js';
import { forbidden } from '../utils/http.js';

export const CAPABILITIES = {
  orders: { label: 'Tomar órdenes y enviarlas a cocina', defaults: ['gerente', 'cajero', 'mesero'] },
  cashier: { label: 'Cobrar, descuentos y manejar la caja', defaults: ['gerente', 'cajero'] },
  cancelSent: { label: 'Cancelar órdenes que ya fueron a cocina', defaults: ['gerente', 'cajero'] },
  voidSent: { label: 'Quitar artículos que ya fueron a cocina', defaults: ['gerente'] },
  availability: { label: 'Marcar productos agotados', defaults: ['gerente', 'cajero'] },
  kitchen: { label: 'Ver la pantalla de cocina', defaults: ['gerente', 'cajero', 'mesero', 'cocina'] },
  kitchenReady: { label: 'Marcar órdenes como listas en cocina', defaults: ['gerente', 'cocina'] },
  manage: { label: 'Editar menú, mesas, promociones, ajustes y ver reportes', defaults: ['gerente'] },
};
export const EDITABLE_ROLES = ['gerente', 'cajero', 'mesero', 'cocina', 'repartidor'];

/** Capacidades efectivas de un rol en un restaurante (Set). */
export async function capabilitiesFor(db, restaurantId, role) {
  if (role === 'admin') return new Set(Object.keys(CAPABILITIES));
  const overrides = new Map((await db.query(
    'SELECT capability, allowed FROM role_permissions WHERE restaurant_id = $1 AND role = $2',
    [restaurantId, role],
  )).rows.map((r) => [r.capability, r.allowed]));
  return new Set(Object.entries(CAPABILITIES)
    .filter(([key, c]) => (overrides.has(key) ? overrides.get(key) : c.defaults.includes(role)))
    .map(([key]) => key));
}

/** Capacidades del usuario de la peticion (se cargan una vez por peticion). */
export async function userCapabilities(req) {
  if (!req._caps) req._caps = await withTenant(req.tenant.id, (db) => capabilitiesFor(db, req.tenant.id, req.user.role));
  return req._caps;
}

export async function hasCapability(req, key) {
  return (await userCapabilities(req)).has(key);
}

/** Middleware: 403 si el rol no tiene la capacidad. */
export function can(key) {
  if (!CAPABILITIES[key]) throw new Error(`Capacidad desconocida: ${key}`);
  return async (req, res, next) => {
    try {
      if (!req.user) return next(forbidden());
      if (!(await hasCapability(req, key))) return next(forbidden('Tu rol no tiene permiso para esta accion', 'ROLE_REQUIRED'));
      next();
    } catch (err) {
      next(err);
    }
  };
}
