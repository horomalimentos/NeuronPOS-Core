// Construye la app de Express (sin escuchar): server.js la levanta y las
// pruebas la usan directamente.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pool from './config/database.js';
import { env } from './config/env.js';
import { resolveTenant } from './middleware/tenant.js';
import { platformAuthRouter, restaurantAuthRouter } from './routes/auth.js';
import branchesRouter from './routes/branches.js';
import deliveryRouter from './routes/delivery/index.js';
import employeesRouter from './routes/employees.js';
import fleetRouter from './routes/fleet.js';
import inventoryRouter from './routes/inventory/index.js';
import meRouter from './routes/me.js';
import onlineRouter from './routes/online.js';
import platformRouter from './routes/platform.js';
import portalRouter from './routes/portal.js';
import posRouter from './routes/pos/index.js';
import publicRouter from './routes/public.js';
import recognitionRouter from './routes/recognition.js';
import rhRouter from './routes/rh/index.js';
import subscriptionRouter from './routes/subscription.js';
import uploadsRouter from './routes/uploads.js';
import usersRouter from './routes/users.js';
import webhooksRouter from './routes/webhooks.js';
import websiteRouter from './routes/website.js';
import { errorHandler, notFound } from './utils/http.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // detras de nginx

  app.use(helmet());
  app.use(cors({
    origin: env.corsOrigins.length ? env.corsOrigins : !env.isProduction,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Restaurant-Slug'],
  }));
  // Los webhooks de Clip se firman sobre el cuerpo crudo: se guarda en req.rawBody.
  app.use(express.json({
    limit: '1mb',
    verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/webhooks/')) req.rawBody = buf; },
  }));

  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });

  // Panel NeuronPOS (dueno de la plataforma): no usa tenant.
  app.use('/api/platform/auth', platformAuthRouter);
  app.use('/api/platform', platformRouter);
  // Webhooks de Clip (fase 3): el restaurante va en la ruta, no en el Host.
  app.use('/api/webhooks', webhooksRouter);
  // Instaladores de NeuronPOS / Neuron KDS (escritorio y Android) y los
  // archivos de actualizacion automatica. Los "latest*" nunca se cachean.
  app.use('/api/descargas', express.static(env.downloadsDir, {
    index: false,
    dotfiles: 'ignore',
    setHeaders(res, file) {
      if (/latest[^/]*\.(ya?ml|json)$/.test(file) || file.endsWith('index.json')) res.setHeader('Cache-Control', 'no-cache');
      if (file.endsWith('.apk')) res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    },
  }));
  app.use('/api/descargas', (req, res, next) => next(notFound('Archivo no encontrado', 'FILE_NOT_FOUND')));
  // Fotos subidas por los restaurantes: publicas (las ve el sitio) y con
  // nombre aleatorio, asi que se pueden cachear para siempre.
  app.use('/api/uploads', express.static(env.uploadsDir, {
    index: false,
    dotfiles: 'ignore',
    immutable: true,
    maxAge: '365d',
    setHeaders(res) { res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); },
  }));
  // Fase 5: app de los repartidores de la flota de la plataforma (sin tenant).
  app.use('/api/fleet', fleetRouter);

  // Todo lo demas es de un restaurante.
  app.use('/api', resolveTenant);
  app.use('/api/auth', restaurantAuthRouter);
  app.use('/api/me', meRouter);
  app.use('/api/branches', branchesRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/pos', posRouter);
  // Fase 2: sitio web y portal de clientes.
  app.use('/api/website', websiteRouter);
  app.use('/api/online', onlineRouter);
  app.use('/api/portal', portalRouter);
  // Fase 3: suscripcion del restaurante (funciona aun suspendido, para pagar).
  app.use('/api/subscription', subscriptionRouter);
  // Fase 4: empleados (rh o empleado_mes), recursos humanos y nomina, empleado del mes.
  app.use('/api/employees', employeesRouter);
  app.use('/api/rh', rhRouter);
  app.use('/api/recognition', recognitionRouter);
  // Fase 5: domicilios (reparto en caja, app del repartidor propio, cortes).
  app.use('/api/delivery', deliveryRouter);
  // Inventario y compras (modulo 'inventario').
  app.use('/api/inventory', inventoryRouter);

  app.use('/api', (req, res, next) => next(notFound('Ruta no encontrada', 'ROUTE_NOT_FOUND')));
  app.use(errorHandler);
  return app;
}
