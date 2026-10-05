import { config } from 'dotenv';

config();

const bool = (v, def) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const isProduction = process.env.NODE_ENV === 'production';

export const env = {
  isProduction,
  isTest: process.env.NODE_ENV === 'test',
  port: parseInt(process.env.PORT, 10) || 8100,
  jwtSecret: process.env.JWT_SECRET || (isProduction ? null : 'dev-secret-cambiar'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  // Dominio base de la plataforma: los restaurantes viven en <slug>.<dominio>.
  platformDomain: (process.env.PLATFORM_DOMAIN || 'localhost').toLowerCase(),
  // Subdominios que nunca son restaurantes (panel, api, www...).
  reservedSubdomains: (process.env.RESERVED_SUBDOMAINS || 'www,app,api,admin,panel,static,cdn,mail')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // Permite elegir restaurante con el header X-Restaurant-Slug (desarrollo,
  // o cuando el frontend no se sirve desde el subdominio del restaurante).
  allowSlugHeader: bool(process.env.ALLOW_SLUG_HEADER, !isProduction),
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  loginRateLimit: parseInt(process.env.LOGIN_RATE_LIMIT, 10) || 20,
};

if (!env.jwtSecret) {
  throw new Error('JWT_SECRET es obligatorio en produccion');
}
