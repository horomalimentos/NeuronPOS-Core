// Modulo de recursos humanos y nomina. Todas las rutas requieren usuario del
// restaurante y el modulo 'rh' contratado (requireModule responde 402 si no).
// Los empleados viven en /api/employees (los comparte el empleado del mes).
import { Router } from 'express';
import { authenticateUser } from '../../middleware/auth.js';
import { requireModule } from '../../middleware/requireModule.js';
import attendanceRouter from './attendance.js';
import clockRouter from './clock.js';
import configRouter from './config.js';
import extrasRouter from './extras.js';
import meRouter from './me.js';
import payrollRouter from './payroll.js';
import shiftsRouter from './shifts.js';

const router = Router();
router.use(authenticateUser, requireModule('rh'));

router.use(meRouter);
router.use(configRouter);
router.use(clockRouter);
router.use(attendanceRouter);
router.use(payrollRouter);
router.use(extrasRouter);
// Con su propio prefijo: el modulo turnos solo aplica a estas rutas.
router.use('/shifts', shiftsRouter);

export default router;
