// Limites de peticiones para lo publico (sitio y portal de clientes). La
// llave es restaurante + IP: el trafico de un restaurante no agota el limite
// de otro. En pruebas se desactivan (como el limite de login).
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';

const keyByTenantAndIp = (req) => `${req.tenant?.id || 'sin-restaurante'}:${ipKeyGenerator(req.ip || '')}`;

function limiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.isTest,
    keyGenerator: keyByTenantAndIp,
    message: { error: message, code: 'RATE_LIMITED' },
  });
}

/** Lecturas publicas: sitio, menu, seguimiento de pedidos (con sondeo). */
export const publicLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: env.publicRateLimit,
  message: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.',
});

/** Registro e inicio de sesion de clientes. */
export const customerAuthLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: env.loginRateLimit,
  message: 'Demasiados intentos. Intenta de nuevo en unos minutos.',
});

/** Crear pedidos en linea. */
export const orderLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: env.orderRateLimit,
  message: 'Hiciste demasiados pedidos seguidos. Intenta mas tarde o llama a la sucursal.',
});

/** Calificar, quejarse y subir fotos de evidencia. */
export const feedbackLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  message: 'Demasiados intentos. Intenta de nuevo más tarde.',
});

/** Checador (kiosco): intentos de NIP por dispositivo. El bloqueo por empleado vive en la BD. */
export const kioskLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 60,
  message: 'Demasiados intentos en el checador. Espera un minuto.',
});
