// Estado del cliente de NeuronPOS Delivery en el navegador: su ubicacion,
// su carrito (de un solo restaurante a la vez) y sus datos de contacto. Los
// precios del carrito son un estimado: el servidor valua todo al cotizar.
import { useSyncExternalStore } from 'react';
import type { Point } from '../components/ZoneMap';
import type { CartLine } from '../site/cart';

export interface DeliveryCart { branch_id: string | null; restaurant_name: string | null; lines: CartLine[] }
export interface Contact { name: string; phone: string; address: string; reference: string }

const KEYS = { location: 'npd_location', cart: 'npd_cart', contact: 'npd_contact', orders: 'npd_orders' } as const;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* almacenamiento bloqueado */ }
}

function store<T>(key: string, fallback: T) {
  let current = read<T>(key, fallback);
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next: T) {
      current = next;
      write(key, next);
      listeners.forEach((l) => l());
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export const locationStore = store<Point | null>(KEYS.location, null);
export const cartStore = store<DeliveryCart>(KEYS.cart, { branch_id: null, restaurant_name: null, lines: [] });
export const contactStore = store<Contact>(KEYS.contact, { name: '', phone: '', address: '', reference: '' });
/** Ultimos pedidos (token y restaurante) para volver al seguimiento. */
export const ordersStore = store<{ token: string; restaurant: string; at: string }[]>(KEYS.orders, []);

export const useStore = <T,>(s: { get: () => T; subscribe: (fn: () => void) => () => void }) => useSyncExternalStore(s.subscribe, s.get);

let seq = 0;
/** Agrega una linea; si el carrito era de otro restaurante, empieza uno nuevo. */
export function addToCart(branchId: string, restaurantName: string, line: Omit<CartLine, 'key'>) {
  const cur = cartStore.get();
  const lines = cur.branch_id === branchId ? cur.lines : [];
  seq += 1;
  cartStore.set({ branch_id: branchId, restaurant_name: restaurantName, lines: [...lines, { ...line, key: `${Date.now()}-${seq}` }] });
}

export function setQuantity(key: string, quantity: number) {
  const cur = cartStore.get();
  const lines = quantity <= 0 ? cur.lines.filter((l) => l.key !== key) : cur.lines.map((l) => (l.key === key ? { ...l, quantity } : l));
  cartStore.set({ ...cur, lines, ...(lines.length ? {} : { branch_id: null, restaurant_name: null }) });
}

export const clearCart = () => cartStore.set({ branch_id: null, restaurant_name: null, lines: [] });

export const cartTotal = (c: DeliveryCart) => Math.round(c.lines.reduce((s, l) => s + l.unit_price * l.quantity, 0) * 100) / 100;
