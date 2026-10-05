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
import meRouter from './routes/me.js';
import platformRouter from './routes/platform.js';
import posRouter from './routes/pos/index.js';
import publicRouter from './routes/public.js';
import usersRouter from './routes/users.js';
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
  app.use(express.json({ limit: '1mb' }));

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

  // Todo lo demas es de un restaurante.
  app.use('/api', resolveTenant);
  app.use('/api/auth', restaurantAuthRouter);
  app.use('/api/me', meRouter);
  app.use('/api/branches', branchesRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/pos', posRouter);

  app.use('/api', (req, res, next) => next(notFound('Ruta no encontrada', 'ROUTE_NOT_FOUND')));
  app.use(errorHandler);
  return app;
}
