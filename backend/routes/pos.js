// Marcador del modulo POS: el POS de NeuronPOS se porta en la siguiente
// fase. Por ahora sirve para comprobar requireModule('pos') de punta a punta.
import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';

const router = Router();

router.get('/status', authenticateUser, requireModule('pos'), (req, res) => {
  res.json({ ok: true, module: 'pos', message: 'Modulo POS habilitado. El punto de venta llega en la siguiente fase.' });
});

export default router;
