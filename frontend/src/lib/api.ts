import { session, type Realm } from './session';

export class ApiError extends Error {
  status: number;
  code?: string;
  /** Cuerpo completo de la respuesta (algunos errores traen datos extra). */
  data?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

interface Options {
  method?: string;
  body?: unknown;
  /** Archivo que se manda tal cual (con su tipo), p. ej. una foto. */
  file?: Blob;
  realm?: Realm;
  /** No mandar a login en 401 (p. ej. el propio formulario de login). */
  noRedirect?: boolean;
}

/**
 * Llave de este equipo (control de dispositivos): aleatoria, se crea la primera
 * vez y se queda en el navegador o la app. El servidor solo guarda su hash.
 */
export function deviceToken(): string {
  try {
    let t = localStorage.getItem('npc_device');
    if (!t || !/^[A-Za-z0-9_-]{32,128}$/.test(t)) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      t = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      localStorage.setItem('npc_device', t);
    }
    return t;
  } catch {
    return '';
  }
}

const LOGIN_PATH: Record<Realm, string> = {
  platform: '/panel/login', restaurant: '/admin/login', customer: '/cuenta/entrar', fleet: '/repartidor', nayo: '/nayo',
};

/** La app del repartidor tiene su propio login (personal del restaurante o flota). */
const loginPath = (realm: Realm) => (window.location.pathname.startsWith('/repartidor') ? '/repartidor' : LOGIN_PATH[realm]);

export async function api<T>(path: string, { method = 'GET', body, file, realm = 'restaurant', noRedirect }: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (file) headers['Content-Type'] = file.type || 'application/octet-stream';
  else if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = session.getToken(realm);
  if (token) headers.Authorization = `Bearer ${token}`;
  const slug = session.getDevSlug();
  if (slug && realm !== 'platform' && realm !== 'fleet' && realm !== 'nayo') headers['X-Restaurant-Slug'] = slug;
  if (realm === 'restaurant') {
    const device = deviceToken();
    if (device) headers['X-Device-Token'] = device;
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: file ?? (body === undefined ? undefined : JSON.stringify(body)) });
  } catch {
    throw new ApiError(0, 'No se pudo conectar con el servidor');
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Sesion de cliente de otro restaurante (mismo navegador en desarrollo): se descarta.
    if (res.status === 403 && realm === 'customer' && data?.code === 'TENANT_MISMATCH') session.setToken(realm, null);
    if (res.status === 401 && token && !noRedirect) {
      session.setToken(realm, null);
      window.location.assign(loginPath(realm));
    }
    throw new ApiError(res.status, data?.error || `Error ${res.status}`, data?.code, data || undefined);
  }
  return data as T;
}

/** App de los repartidores de la flota de la plataforma. */
export const fleetApi = <T,>(path: string, opts: Omit<Options, 'realm'> = {}) => api<T>(path, { ...opts, realm: 'fleet' });

/** Cliente de Nayo: manda solo su token de cuenta de Nayo y nunca redirige. */
export const nayoApi = <T,>(path: string, opts: Omit<Options, 'realm' | 'noRedirect'> = {}) => api<T>(path, { ...opts, realm: 'nayo', noRedirect: true });

export const platformApi = <T,>(path: string, opts: Omit<Options, 'realm'> = {}) => api<T>(path, { ...opts, realm: 'platform' });

/** Sitio publico y portal de clientes: solo manda el token del cliente (nunca el del personal). */
export const portalApi = <T,>(path: string, opts: Omit<Options, 'realm'> = {}) => api<T>(path, { ...opts, realm: 'customer' });

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Ocurrio un error inesperado');
