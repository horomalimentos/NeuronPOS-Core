// Tokens y restaurante de desarrollo guardados en localStorage. Las cuentas
// de plataforma y de restaurante usan llaves distintas y nunca se mezclan.
const KEYS = {
  platform: 'npc_platform_token',
  restaurant: 'npc_token',
  slug: 'npc_dev_slug',
} as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* almacenamiento bloqueado */
  }
}

export type Realm = 'platform' | 'restaurant';

export const session = {
  getToken: (realm: Realm) => read(KEYS[realm]),
  setToken: (realm: Realm, token: string | null) => write(KEYS[realm], token),
  /**
   * Restaurante elegido manualmente (desarrollo o dominio sin subdominio).
   * Se fija con ?restaurante=<slug> en cualquier URL.
   */
  getDevSlug: () => read(KEYS.slug),
  setDevSlug: (slug: string | null) => write(KEYS.slug, slug),
};

export function captureSlugFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('restaurante');
  if (slug !== null) {
    const next = slug.trim().toLowerCase() || null;
    // Cambiar de restaurante invalida la sesion del anterior.
    if (next !== read(KEYS.slug)) session.setToken('restaurant', null);
    session.setDevSlug(next);
  }
}
