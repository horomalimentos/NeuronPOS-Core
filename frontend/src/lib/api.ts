import { session, type Realm } from './session';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Options {
  method?: string;
  body?: unknown;
  realm?: Realm;
  /** No mandar a login en 401 (p. ej. el propio formulario de login). */
  noRedirect?: boolean;
}

const LOGIN_PATH: Record<Realm, string> = { platform: '/panel/login', restaurant: '/admin/login' };

export async function api<T>(path: string, { method = 'GET', body, realm = 'restaurant', noRedirect }: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = session.getToken(realm);
  if (token) headers.Authorization = `Bearer ${token}`;
  const slug = session.getDevSlug();
  if (slug && realm === 'restaurant') headers['X-Restaurant-Slug'] = slug;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'No se pudo conectar con el servidor');
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token && !noRedirect) {
      session.setToken(realm, null);
      window.location.assign(LOGIN_PATH[realm]);
    }
    throw new ApiError(res.status, data?.error || `Error ${res.status}`, data?.code);
  }
  return data as T;
}

export const platformApi = <T,>(path: string, opts: Omit<Options, 'realm'> = {}) => api<T>(path, { ...opts, realm: 'platform' });

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Ocurrio un error inesperado');
