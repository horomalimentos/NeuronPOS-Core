// Modulo POS. Todas las rutas requieren usuario del restaurante y el modulo
// 'pos' contratado (requireModule responde 402 si no).
import { Router } from 'express';
import { authenticateUser } from '../../middleware/auth.js';
import { requireModule } from '../../middleware/requireModule.js';
import cashRouter from './cash.js';
import menuRouter from './menu.js';
import onlineRouter from './online.js';
import ordersRouter from './orders.js';
import settingsRouter from './settings.js';
import tablesRouter from './tables.js';

const router = Router();
router.use(authenticateUser, requireModule('pos'));

router.get('/status', (req, res) => {
  res.json({ ok: true, module: 'pos', message: 'Modulo POS habilitado.' });
});

router.use(menuRouter);
router.use(tablesRouter);
router.use(settingsRouter);
router.use(ordersRouter);
router.use(onlineRouter);
router.use(cashRouter);

export default router;
