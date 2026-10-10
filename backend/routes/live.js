// Canal en vivo de una sucursal (Server-Sent Events). Ver services/live.js.
import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { subscribeLive } from '../services/live.js';
import { ah } from '../utils/http.js';
import { requireBranch } from './pos/common.js';

const router = Router();

router.get('/', authenticateUser, ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const send = (d) => {
    if (d.b && d.b !== branchId) return;
    res.write(`event: ${d.t}\ndata: ${JSON.stringify({ branch_id: d.b })}\n\n`);
  };
  const stop = await subscribeLive(req.tenant.id, send);
  // Latido para que nginx y los celulares no corten la conexion.
  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(beat); stop(); });
}));

export default router;
