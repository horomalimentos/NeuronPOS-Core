// Utilidades compartidas por las rutas del POS: roles, acceso a sucursales y
// validaciones pequenas.
import { badRequest, forbidden, requireUuid } from '../../utils/http.js';

// Quien puede hacer que dentro del POS.
export const ROLES = {
  // Catalogo (menu, mesas, metodos de pago, configuracion).
  manage: ['admin', 'gerente'],
  // Leer el menu y las mesas, tomar ordenes.
  orders: ['admin', 'gerente', 'cajero', 'mesero'],
  // Cobrar y manejar la caja.
  cashier: ['admin', 'gerente', 'cajero'],
  // Pantalla de cocina: ver y marcar listo.
  kitchen: ['admin', 'gerente', 'cajero', 'mesero', 'cocina'],
  kitchenReady: ['admin', 'gerente', 'cocina'],
  // Marcar productos agotados en una sucursal.
  availability: ['admin', 'gerente', 'cajero'],
};

export const isManager = (user) => ROLES.manage.includes(user.role);

/** Admin y gerente ven todas las sucursales; el resto solo las asignadas (igual que /api/me). */
export function canAccessBranch(user, branchId) {
  return isManager(user) || (user.branch_ids || []).includes(branchId);
}

/** Valida el id de sucursal y que el usuario tenga acceso a ella. */
export function requireBranch(req, value, field = 'branch_id') {
  if (!value) throw badRequest(`El campo "${field}" es obligatorio`, 'MISSING_FIELD');
  requireUuid(value, field);
  if (!canAccessBranch(req.user, String(value))) {
    throw forbidden('No tienes acceso a esta sucursal', 'BRANCH_FORBIDDEN');
  }
  return String(value);
}

/** Verifica en BD que la sucursal sea del restaurante (RLS ya oculta las ajenas). */
export async function assertBranchExists(db, restaurantId, branchId) {
  const { rowCount } = await db.query('SELECT 1 FROM branches WHERE id = $1 AND restaurant_id = $2', [branchId, restaurantId]);
  if (!rowCount) throw badRequest('La sucursal no existe', 'BRANCH_NOT_FOUND');
}

export function int(value, { field, min = 0, max = 1000000, nullable = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') {
    if (nullable) return null;
    throw badRequest(`El campo "${field}" es obligatorio`, 'MISSING_FIELD');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`El campo "${field}" debe ser un numero entero entre ${min} y ${max}`, 'INVALID_FIELD');
  }
  return n;
}

/** Monto con signo (ajustes de modificadores). */
export function signedMoney(value, { field } = {}) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || Math.abs(n) > 99999) {
    throw badRequest(`El campo "${field}" debe ser un monto valido`, 'INVALID_FIELD');
  }
  return Math.round(n * 100) / 100;
}

export function uuidList(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest(`${field} debe ser una lista`, 'INVALID_FIELD');
  value.forEach((v) => requireUuid(v, field));
  return [...new Set(value.map(String))];
}

/** URL http(s) o ruta relativa para imagenes. */
export function imageUrl(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1000 || !/^(https?:\/\/|\/)[^\s]+$/i.test(value.trim())) {
    throw badRequest('La URL de la imagen no es valida', 'INVALID_FIELD');
  }
  return value.trim();
}

/** Construye un INSERT con solo los campos definidos (ademas de restaurant_id). */
export function insertSql(table, restaurantId, fields, returning = '*') {
  const cols = Object.entries(fields).filter(([, v]) => v !== undefined);
  return {
    text: `INSERT INTO ${table} (restaurant_id${cols.map(([k]) => `, ${k}`).join('')})
           VALUES ($1${cols.map((_, i) => `, $${i + 2}`).join('')}) RETURNING ${returning}`,
    values: [restaurantId, ...cols.map(([, v]) => v)],
  };
}
