// Webhook de la Cloud API de WhatsApp (un solo URL para todos los
// restaurantes; el numero que recibio el mensaje dice de quien es).
import { Router } from 'express';
import { handleWebhook, verifyChallenge } from '../services/whatsapp/inbound.js';
import { ah } from '../utils/http.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const challenge = await verifyChallenge(req.query);
  if (challenge === null) return res.status(403).send('Token de verificacion invalido');
  return res.type('text/plain').send(challenge);
}));

router.post('/', ah(async (req, res) => {
  const status = await handleWebhook(req.rawBody || Buffer.from(''), req.headers['x-hub-signature-256']);
  res.status(status).end();
}));

export default router;
