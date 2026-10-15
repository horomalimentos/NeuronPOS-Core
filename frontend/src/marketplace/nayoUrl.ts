// Nayo tiene su propio dominio (elnayo.com): ahi vive en la raiz (/,
// /restaurantes, /r/:id...). En neuronpos.app sigue bajo /nayo.
export const NAYO_HOSTS = ['elnayo.com', 'www.elnayo.com'];

export const onNayoHost = () => NAYO_HOSTS.includes(window.location.hostname.toLowerCase());

/** Ruta de Nayo segun el dominio: nayoPath('/restaurantes') → /restaurantes o /nayo/restaurantes. */
export const nayoPath = (path = '') => (onNayoHost() ? path || '/' : `/nayo${path}`);
