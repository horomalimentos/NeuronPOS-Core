// Fotos que sube el restaurante (platillos del menu, portada y galeria del
// sitio). Se guardan en disco por restaurante y se sirven en /api/uploads
// (app.js), sin depender de nginx. La imagen viaja como cuerpo crudo con su
// Content-Type (image/jpeg, image/png, image/webp o image/gif).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { Router } from 'express';
import { env } from '../config/env.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { HttpError, ah, badRequest } from '../utils/http.js';

const router = Router();
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Tipo real por los primeros bytes (no se confia en el Content-Type). */
export function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'gif';
  return null;
}

router.post(
  '/image',
  authenticateUser,
  requireRole('admin', 'gerente'),
  express.raw({ type: 'image/*', limit: MAX_UPLOAD_BYTES }),
  ah(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      throw badRequest('Manda la imagen como archivo (JPG, PNG, WebP o GIF)', 'IMAGE_REQUIRED');
    }
    const ext = sniffImage(req.body);
    if (!ext) throw badRequest('El archivo no es una imagen JPG, PNG, WebP o GIF', 'INVALID_IMAGE');
    const dir = path.join(env.uploadsDir, req.tenant.id);
    await fs.mkdir(dir, { recursive: true });
    const name = `${crypto.randomUUID()}.${ext}`;
    await fs.writeFile(path.join(dir, name), req.body);
    res.status(201).json({ url: `/api/uploads/${req.tenant.id}/${name}`, size: req.body.length });
  }),
);

// express.raw responde 413 con su propio error: se traduce al formato de la API.
router.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return next(new HttpError(413, 'La imagen pesa mas de 5 MB', 'IMAGE_TOO_LARGE'));
  }
  next(err);
});

export default router;
