import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // Sesiones de clientes del portal (mas largas que las del personal).
  customerJwtExpiresIn: process.env.CUSTOMER_JWT_EXPIRES_IN || '30d',
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
  // Rutas publicas (sitio y portal): requests por IP y restaurante cada 15 min.
  publicRateLimit: parseInt(process.env.PUBLIC_RATE_LIMIT, 10) || 600,
  // Pedidos en linea creados por IP y restaurante cada hora.
  orderRateLimit: parseInt(process.env.ORDER_RATE_LIMIT, 10) || 20,

  // --- Fase 3: cobro con Clip ---
  // URL publica del backend: Clip manda aqui los webhooks (/api/webhooks/clip/...).
  publicApiUrl: (process.env.PUBLIC_API_URL || `http://localhost:${parseInt(process.env.PORT, 10) || 8100}`).replace(/\/+$/, ''),
  // URL del sitio de cada restaurante (a donde Clip regresa al cliente).
  // {slug} y {domain} se reemplazan; un dominio propio usa https://<dominio>.
  restaurantUrlTemplate: process.env.RESTAURANT_URL_TEMPLATE || 'https://{slug}.{domain}',
  // Cuenta de Clip de la PLATAFORMA (cobro de la suscripcion a los restaurantes).
  clipApiKey: process.env.CLIP_API_KEY || '',
  clipSecretKey: process.env.CLIP_SECRET_KEY || '',
  clipWebhookSecret: process.env.CLIP_WEBHOOK_SECRET || '',
  clipApiUrl: (process.env.CLIP_API_URL || 'https://api.payclip.com').replace(/\/+$/, ''),
  // Llave (32 bytes en base64 o hex) para cifrar las credenciales de Clip de cada restaurante.
  paymentSecretsKey: process.env.PAYMENT_SECRETS_KEY || '',
  // Zona horaria para fechas de cobro (dia de cobro, vencimiento, gracia).
  billingTimezone: process.env.BILLING_TIMEZONE || 'America/Mexico_City',
  // false = no generar facturas ni suspender automaticamente (el Panel sigue
  // pudiendo generar cobros a mano).
  billingAuto: bool(process.env.BILLING_AUTO, true),
  // Jobs en segundo plano (cobro, conciliacion con Clip, pedidos sin pagar).
  jobsEnabled: bool(process.env.JOBS_ENABLED, process.env.NODE_ENV !== 'test'),

  // --- Correo (SMTP) ---
  // Sin SMTP_HOST no se mandan correos: solo se anotan en el log.
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT, 10) || 587,
  // true = TLS directo (puerto 465); false = STARTTLS.
  smtpSecure: bool(process.env.SMTP_SECURE, (parseInt(process.env.SMTP_PORT, 10) || 587) === 465),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  // Remitente: "NeuronPOS <no-reply@neuronpos.app>". En correos de un
  // restaurante se usa su nombre con esta misma direccion.
  mailFrom: process.env.MAIL_FROM || 'NeuronPOS <no-reply@neuronpos.app>',

  // Instaladores de las apps (deploy/instaladores.sh) servidos en /api/descargas.
  downloadsDir: process.env.DOWNLOADS_DIR
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'descargas'),
  // Fotos subidas por los restaurantes (una carpeta por restaurante), servidas en /api/uploads.
  uploadsDir: process.env.UPLOADS_DIR
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'uploads'),
};

if (!env.jwtSecret) {
  throw new Error('JWT_SECRET es obligatorio en produccion');
}
