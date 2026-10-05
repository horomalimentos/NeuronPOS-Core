// Utilidades HTTP compartidas: errores con status, wrapper async y
// validaciones pequenas (sin dependencias extra).

export class HttpError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg, code = 'BAD_REQUEST') => new HttpError(400, msg, code);
export const notFound = (msg = 'No encontrado', code = 'NOT_FOUND') => new HttpError(404, msg, code);
export const forbidden = (msg = 'No tienes permiso para esta accion', code = 'FORBIDDEN') => new HttpError(403, msg, code);

/** Express 4 no atrapa promesas rechazadas: este wrapper las manda a next(). */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const PG_ERRORS = {
  '23505': [409, 'Ya existe un registro con esos datos', 'DUPLICATE'],
  '23503': [400, 'Referencia invalida', 'INVALID_REFERENCE'],
  '23514': [400, 'Algun dato no tiene un valor permitido', 'INVALID_VALUE'],
  '23502': [400, 'Falta un dato obligatorio', 'MISSING_VALUE'],
  '22P02': [400, 'Formato de dato invalido', 'INVALID_FORMAT'],
  '22007': [400, 'Fecha invalida', 'INVALID_DATE'],
  '22008': [400, 'Fecha invalida', 'INVALID_DATE'],
  '42501': [403, 'Acceso denegado', 'RLS_DENIED'],
};

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalido', code: 'INVALID_JSON' });
  }
  const mapped = err?.code && PG_ERRORS[err.code];
  if (mapped) {
    const [status, error, code] = mapped;
    return res.status(status).json({ error, code, detail: err.constraint || undefined });
  }
  console.error('Error no controlado:', err);
  return res.status(500).json({ error: 'Error interno del servidor', code: 'INTERNAL' });
}

// ---------------------------------------------------------------------------
// Validaciones
// ---------------------------------------------------------------------------

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function requireUuid(value, what = 'id') {
  if (!UUID_RE.test(String(value || ''))) throw badRequest(`${what} invalido`, 'INVALID_ID');
  return value;
}

export function str(value, { field, required = false, max = 200, allowEmpty = false } = {}) {
  if (value === undefined || value === null || (!allowEmpty && String(value).trim() === '')) {
    if (required) throw badRequest(`El campo "${field}" es obligatorio`, 'MISSING_FIELD');
    return value === undefined ? undefined : null;
  }
  if (typeof value !== 'string') throw badRequest(`El campo "${field}" debe ser texto`, 'INVALID_FIELD');
  const v = value.trim();
  if (v.length > max) throw badRequest(`El campo "${field}" es demasiado largo`, 'INVALID_FIELD');
  return v;
}

export function money(value, { field, nullable = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') {
    if (nullable) return null;
    throw badRequest(`El campo "${field}" es obligatorio`, 'MISSING_FIELD');
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99999999) {
    throw badRequest(`El campo "${field}" debe ser un monto valido`, 'INVALID_FIELD');
  }
  return Math.round(n * 100) / 100;
}

export function oneOf(value, allowed, field) {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw badRequest(`El campo "${field}" debe ser uno de: ${allowed.join(', ')}`, 'INVALID_FIELD');
  }
  return value;
}

export function bool(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest(`El campo "${field}" debe ser verdadero o falso`, 'INVALID_FIELD');
  return value;
}

export function dateOrNull(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`El campo "${field}" debe ser una fecha valida`, 'INVALID_FIELD');
  return d.toISOString();
}

/**
 * Construye "SET a = $n, b = $n+1" con solo los campos definidos.
 * Regresa null si no hay nada que actualizar.
 */
export function buildSet(fields, startIndex = 1) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return null;
  const sql = entries.map(([k], i) => `${k} = $${startIndex + i}`).join(', ');
  return { sql, values: entries.map(([, v]) => v) };
}
