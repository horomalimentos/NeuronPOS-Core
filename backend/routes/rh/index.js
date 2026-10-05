// Modulo de recursos humanos y nomina. Todas las rutas requieren usuario del
// restaurante y el modulo 'rh' contratado (requireModule responde 402 si no).
// Los empleados viven en /api/employees (los comparte el empleado del mes).
import { Router } from 'express';
import { authenticateUser } from '../../middleware/auth.js';
import { requireModule } from '../../middleware/requireModule.js';
import attendanceRouter from './attendance.js';
import clockRouter from './clock.js';
import configRouter from './config.js';
import meRouter from './me.js';
import payrollRouter from './payroll.js';

const router = Router();
router.use(authenticateUser, requireModule('rh'));

router.use(meRouter);
router.use(configRouter);
router.use(clockRouter);
router.use(attendanceRouter);
router.use(payrollRouter);

export default router;
