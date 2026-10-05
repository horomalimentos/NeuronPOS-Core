// Carrito del portal de clientes en localStorage (por restaurante). Los
// precios que guarda son solo para mostrar un estimado: el servidor vuelve a
// valuar todo al cotizar y al crear el pedido.
import { useSyncExternalStore } from 'react';
import { session } from '../lib/session';

export interface CartLine {
  key: string;
  item_id: string;
  name: string;
  image_url: string | null;
  /** Precio unitario estimado (producto + modificadores). */
  unit_price: number;
  quantity: number;
  modifier_ids: string[];
  modifier_names: string[];
  notes: string;
}

export interface Cart {
  branch_id: string | null;
  lines: CartLine[];
}

const EMPTY: Cart = { branch_id: null, lines: [] };
const listeners = new Set<() => void>();
const storageKey = (base: string) => `${base}:${session.getDevSlug() || window.location.hostname}`;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey(key));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch { /* almacenamiento bloqueado */ }
}

let current: Cart = (() => {
  const c = readJson<Cart>('npc_cart', EMPTY);
  return c && Array.isArray(c.lines) ? c : EMPTY;
})();

function save(next: Cart) {
  current = next;
  writeJson('npc_cart', next);
  listeners.forEach((l) => l());
}

export const cartStore = {
  get: () => current,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  setBranch(branchId: string) {
    // Cambiar de sucursal conserva el carrito; el servidor revalida disponibilidad.
    save({ ...current, branch_id: branchId });
  },
  add(line: Omit<CartLine, 'key'>) {
    const same = current.lines.find((l) => l.item_id === line.item_id && l.notes === line.notes
      && l.modifier_ids.join(',') === line.modifier_ids.join(','));
    if (same) {
      save({ ...current, lines: current.lines.map((l) => (l === same ? { ...l, quantity: Math.min(99, l.quantity + line.quantity) } : l)) });
    } else {
      save({ ...current, lines: [...current.lines, { ...line, key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }] });
    }
  },
  setQuantity(key: string, quantity: number) {
    save({
      ...current,
      lines: quantity <= 0 ? current.lines.filter((l) => l.key !== key)
        : current.lines.map((l) => (l.key === key ? { ...l, quantity: Math.min(99, quantity) } : l)),
    });
  },
  remove(key: string) {
    save({ ...current, lines: current.lines.filter((l) => l.key !== key) });
  },
  clear() {
    save({ ...current, lines: [] });
  },
};

export function useCart() {
  const cart = useSyncExternalStore(cartStore.subscribe, cartStore.get);
  const count = cart.lines.reduce((s, l) => s + l.quantity, 0);
  const subtotal = Math.round(cart.lines.reduce((s, l) => s + l.unit_price * l.quantity, 0) * 100) / 100;
  return { cart, count, subtotal };
}

// ---------------------------------------------------------------------------
// Pedidos recientes (para que un invitado pueda volver a su seguimiento)
// ---------------------------------------------------------------------------

export interface RecentOrder { token: string; folio: number; created_at: string }

export const recentOrders = {
  list: () => readJson<RecentOrder[]>('npc_recent_orders', []).slice(0, 10),
  add(o: RecentOrder) {
    writeJson('npc_recent_orders', [o, ...recentOrders.list().filter((x) => x.token !== o.token)].slice(0, 10));
  },
};
