// "Continuar con Google" (Google Identity Services): el navegador recibe un
// id_token (JWT firmado por Google) y aqui se verifica con las llaves publicas
// de Google: firma RS256, audiencia = nuestro GOOGLE_CLIENT_ID, emisor de
// Google, vigente y con el correo verificado.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http.js';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

let cache = { keys: null, until: 0 };
let override = null;

/** Solo pruebas: llaves propias en lugar de las de Google (null las quita). */
export function setGoogleKeysForTest(keys) { override = keys; cache = { keys: null, until: 0 }; }

async function googleKeys() {
  if (override) return override;
  if (cache.keys && Date.now() < cache.until) return cache.keys;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw new HttpError(502, 'No pudimos hablar con Google; intenta de nuevo', 'GOOGLE_UNAVAILABLE');
  const { keys } = await r.json();
  const maxAge = Number((r.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  cache = { keys, until: Date.now() + maxAge * 1000 };
  return keys;
}

const invalid = () => new HttpError(401, 'No pudimos confirmar tu cuenta de Google', 'INVALID_GOOGLE_TOKEN');

/** Regresa { sub, email, name } de un id_token valido de Google. */
export async function verifyGoogleIdToken(idToken) {
  if (!env.googleClientId) throw new HttpError(503, 'Entrar con Google no esta disponible', 'GOOGLE_DISABLED');
  if (typeof idToken !== 'string' || idToken.length > 4096) throw invalid();
  const decoded = jwt.decode(idToken, { complete: true });
  const kid = decoded?.header?.kid;
  if (!kid) throw invalid();
  const jwk = (await googleKeys()).find((k) => k.kid === kid);
  if (!jwk) throw invalid();
  let p;
  try {
    p = jwt.verify(idToken, crypto.createPublicKey({ key: jwk, format: 'jwk' }), {
      algorithms: ['RS256'], audience: env.googleClientId, issuer: ISSUERS,
    });
  } catch {
    throw invalid();
  }
  if (!p.sub || !p.email || (p.email_verified !== true && p.email_verified !== 'true')) throw invalid();
  return { sub: String(p.sub), email: String(p.email).trim().toLowerCase(), name: String(p.name || p.given_name || p.email.split('@')[0]).slice(0, 120) };
}
