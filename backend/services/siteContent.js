// Contenido editable del sitio web del restaurante (site_content.content).
// Se guarda como JSON plano; aqui se define que llaves existen, su tipo y
// limite, para que nunca se guarde algo que el sitio no sepa mostrar (ni
// URLs con esquemas peligrosos como javascript:).
import { badRequest } from '../utils/http.js';

const text = (max) => ({ type: 'text', max });
const url = { type: 'url' };
const image = { type: 'image' }; // http(s) o ruta relativa del mismo sitio
const flag = { type: 'bool' };

export const SITE_FIELDS = {
  // Portada
  hero_title: text(120),
  hero_subtitle: text(300),
  hero_image_url: image,
  announcement: text(200),
  // Acerca de
  about_title: text(120),
  about_text: text(3000),
  about_image_url: image,
  // Secciones
  show_menu: flag,
  menu_title: text(120),
  show_gallery: flag,
  gallery_title: text(120),
  // Contacto y redes
  contact_email: text(200),
  whatsapp: text(30),
  social_facebook: url,
  social_instagram: url,
  social_tiktok: url,
  social_x: url,
  social_website: url,
  // Pie y SEO
  footer_text: text(500),
  seo_title: text(70),
  seo_description: text(200),
};

export const DEFAULT_CONTENT = {
  show_menu: true,
  show_gallery: true,
};

const URL_RE = /^https?:\/\/[^\s<>"']+$/i;
const WHATSAPP_RE = /^\+?[0-9 ()-]{7,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Valida un cambio parcial: solo llaves conocidas; '' o null borran la llave.
 * Regresa { set: {...}, unset: [...] }.
 */
export function normalizeContentPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Contenido invalido', 'INVALID_FIELD');
  const set = {};
  const unset = [];
  for (const [key, value] of Object.entries(body)) {
    const spec = SITE_FIELDS[key];
    if (!spec) throw badRequest(`Campo desconocido: "${key}"`, 'INVALID_FIELD');
    if (value === null || value === '') { unset.push(key); continue; }
    if (spec.type === 'bool') {
      if (typeof value !== 'boolean') throw badRequest(`"${key}" debe ser verdadero o falso`, 'INVALID_FIELD');
      set[key] = value;
    } else if (typeof value !== 'string') {
      throw badRequest(`"${key}" debe ser texto`, 'INVALID_FIELD');
    } else if (spec.type === 'url') {
      const v = value.trim();
      if (v.length > 1000 || !URL_RE.test(v)) throw badRequest(`"${key}" debe ser una URL http(s) valida`, 'INVALID_URL');
      set[key] = v;
    } else if (spec.type === 'image') {
      set[key] = galleryUrl(value);
    } else {
      const v = value.trim();
      if (v.length > spec.max) throw badRequest(`"${key}" es demasiado largo (maximo ${spec.max})`, 'INVALID_FIELD');
      if (key === 'whatsapp' && v && !WHATSAPP_RE.test(v)) throw badRequest('El WhatsApp debe ser un numero de telefono', 'INVALID_FIELD');
      if (key === 'contact_email' && v && !EMAIL_RE.test(v)) throw badRequest('Correo de contacto invalido', 'INVALID_FIELD');
      if (v) set[key] = v; else unset.push(key);
    }
  }
  return { set, unset };
}

/** Contenido guardado + valores por defecto, solo con llaves conocidas. */
export function withDefaults(content) {
  const out = { ...DEFAULT_CONTENT };
  for (const [k, v] of Object.entries(content || {})) if (SITE_FIELDS[k]) out[k] = v;
  return out;
}

/** URL de imagen de galeria: http(s) o ruta relativa. */
export function galleryUrl(value) {
  if (typeof value !== 'string' || !(URL_RE.test(value.trim()) || /^\/(?!\/)[^\s<>"']+$/.test(value.trim())) || value.length > 1000) {
    throw badRequest('La URL de la imagen no es valida', 'INVALID_URL');
  }
  return value.trim();
}
