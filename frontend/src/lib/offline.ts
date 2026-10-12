// Caja sin internet (modulo "sin_internet"), adaptado de Horom. Mientras hay
// conexion se guarda en el navegador lo que la caja necesita para vender (menu,
// metodos de pago, impuesto y turno abierto). Si se cae el internet la caja
// vende para llevar con eso y cada venta cobrada se guarda en una cola local;
// al volver la conexion la cola se sube sola a POST /pos/offline-orders (una
// venta a la vez, sin duplicar: cada una lleva su offline_id).
import { useCallback, useEffect, useState } from 'react';
import type { CashSession, Menu, Order, PaymentMethod, PosSettings } from '../pos/types';
import { ApiError, api } from './api';

const CATALOG_KEY = (branchId: string) => `npc_offline_catalog:${branchId}`;
const QUEUE_KEY = 'npc_offline_queue';
const FOLIO_KEY = 'npc_offline_folio';
const ME_KEY = 'npc_me_cache';
const CHANGED = 'npc-offline-queue';

export interface OfflineCatalog {
  menu: Menu;
  methods: PaymentMethod[];
  settings: PosSettings | null;
  session: CashSession | null;
  saved_at: string;
}

export interface OfflineSale {
  offline_id: string;
  created_at: string;
  branch_id: string;
  cash_session_id: string | null;
  local_folio: string;
  customer_name: string | null;
  tax_rate_pct: number;
  prices_include_tax: boolean;
  items: { menu_item_id: string; quantity: number; unit_price: number; notes: string | null; modifiers: { id: string; price_delta: number }[] }[];
  payments: { payment_method_id: string; amount: number; tip: number; received?: number; reference?: string | null }[];
  /** Total cobrado (para mostrar en la lista). */
  total: number;
  /** Ultimo error del servidor (la venta se queda en la cola hasta subirla o descartarla). */
  error?: string;
}

/** Sin conexion con el servidor (o el servidor no responde). */
export const isOfflineError = (e: unknown) => e instanceof ApiError && [0, 502, 503, 504].includes(e.status);

/** Metodos que se pueden usar sin internet: pesos, sin puntos, monedero ni pagos en linea. */
export const offlineMethods = (methods: PaymentMethod[]) =>
  methods.filter((m) => m.active && (m.currency ?? 'MXN') === 'MXN' && ['efectivo', 'tarjeta', 'transferencia', 'otro'].includes(m.kind));

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin espacio o bloqueado */ }
}

export const offlineCatalog = {
  load: (branchId: string) => read<OfflineCatalog | null>(CATALOG_KEY(branchId), null),
  save: (branchId: string, patch: Partial<OfflineCatalog>) => {
    const cur = read<Partial<OfflineCatalog>>(CATALOG_KEY(branchId), {});
    write(CATALOG_KEY(branchId), { ...cur, ...patch, saved_at: new Date().toISOString() });
  },
};

/** Copia de /me para que el panel abra aunque no haya internet. */
export const meCache = {
  load: <T>() => read<T | null>(ME_KEY, null),
  save: (me: unknown) => write(ME_KEY, me),
  clear: () => { try { localStorage.removeItem(ME_KEY); } catch { /* nada */ } },
};

export const offlineQueue = {
  list: () => read<OfflineSale[]>(QUEUE_KEY, []),
  add(sale: OfflineSale) {
    write(QUEUE_KEY, [...offlineQueue.list(), sale]);
    window.dispatchEvent(new Event(CHANGED));
  },
  remove(id: string) {
    write(QUEUE_KEY, offlineQueue.list().filter((s) => s.offline_id !== id));
    window.dispatchEvent(new Event(CHANGED));
  },
  update(id: string, patch: Partial<OfflineSale>) {
    write(QUEUE_KEY, offlineQueue.list().map((s) => (s.offline_id === id ? { ...s, ...patch } : s)));
    window.dispatchEvent(new Event(CHANGED));
  },
};

/** Folio provisional de la caja (el definitivo lo pone el servidor al subir). */
export function nextLocalFolio() {
  const n = read<number>(FOLIO_KEY, 0) + 1;
  write(FOLIO_KEY, n);
  return `SI-${n}`;
}

/** Igual que calculateOrderTotals del servidor, sin descuentos. */
export function offlineTotals(lines: { unit_price: number; modifiers: { price_delta: number }[]; quantity: number }[], taxRatePct: number, pricesIncludeTax: boolean) {
  const cents = (v: number) => Math.round(Number(v || 0) * 100);
  const subtotal = lines.reduce((s, l) => s + (cents(l.unit_price) + l.modifiers.reduce((a, m) => a + cents(m.price_delta), 0)) * l.quantity, 0);
  const rate = Number(taxRatePct || 0) / 100;
  let tax: number;
  let total: number;
  if (pricesIncludeTax) {
    total = subtotal;
    tax = rate > 0 ? Math.round(subtotal - subtotal / (1 + rate)) : 0;
  } else {
    tax = Math.round(subtotal * rate);
    total = subtotal + tax;
  }
  return { subtotal: subtotal / 100, tax: tax / 100, total: total / 100 };
}

let syncing: Promise<void> | null = null;

/** Sube la cola. Se detiene en cuanto no hay conexion. */
export function syncOfflineQueue(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    for (const sale of offlineQueue.list()) {
      try {
        // El servidor ignora los campos de la caja (total, error).
        await api('/pos/offline-orders', { method: 'POST', body: sale });
        offlineQueue.remove(sale.offline_id);
      } catch (e) {
        if (isOfflineError(e)) break;
        offlineQueue.update(sale.offline_id, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  })().finally(() => { syncing = null; });
  return syncing;
}

/** Guarda en cache el panel (app shell) para abrir sin internet. */
function registerShellCache() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/**
 * Cola de ventas sin internet: cuantas faltan por subir y si alguna fallo.
 * Intenta subirlas al abrir, al volver la conexion y cada 30 segundos.
 */
export function useOfflineQueue(enabled: boolean) {
  const [sales, setSales] = useState<OfflineSale[]>(() => offlineQueue.list());
  const refresh = useCallback(() => setSales(offlineQueue.list()), []);
  useEffect(() => {
    window.addEventListener(CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(CHANGED, refresh); window.removeEventListener('storage', refresh); };
  }, [refresh]);
  useEffect(() => {
    if (!enabled) return undefined;
    registerShellCache();
    const go = () => { if (offlineQueue.list().length) void syncOfflineQueue(); };
    go();
    window.addEventListener('online', go);
    const t = setInterval(go, 30000);
    return () => { window.removeEventListener('online', go); clearInterval(t); };
  }, [enabled]);
  return { sales, sync: syncOfflineQueue };
}

/** Orden armada en la caja para imprimir el ticket y la comanda sin internet. */
export function offlineOrder(sale: OfflineSale, names: Map<string, string>, modNames: Map<string, { name: string; group_name: string }>,
  methodNames: Map<string, PaymentMethod>, totals: { subtotal: number; tax: number; total: number }, userName: string, change: number): Order {
  return {
    id: sale.offline_id, branch_id: sale.branch_id, folio: sale.local_folio as unknown as number, order_type: 'para_llevar',
    table_id: null, table_name: null, guests: null, customer_name: sale.customer_name, customer_phone: null, customer_address: null,
    notes: 'Venta sin internet', status: 'pagada', subtotal: String(totals.subtotal), discount_type: null, discount_value: null,
    discount_amount: '0', discount_reason: null, tax_rate_pct: String(sale.tax_rate_pct), prices_include_tax: sale.prices_include_tax,
    tax_amount: String(totals.tax), total: String(totals.total), paid_amount: String(totals.total),
    tip_amount: String(sale.payments.reduce((s, p) => s + p.tip, 0)), created_by_name: userName,
    sent_at: sale.created_at, ready_at: null, paid_at: sale.created_at, cancel_reason: null, created_at: sale.created_at, source: 'pos',
    items: sale.items.map((it, i) => {
      const mods = it.modifiers.map((m) => ({ modifier_id: m.id, name: modNames.get(m.id)?.name || '', group_name: modNames.get(m.id)?.group_name || '', price_delta: String(m.price_delta) }));
      const unit = it.unit_price + it.modifiers.reduce((s, m) => s + m.price_delta, 0);
      return {
        id: `${sale.offline_id}-${i}`, order_id: sale.offline_id, menu_item_id: it.menu_item_id, name: names.get(it.menu_item_id) || '',
        unit_price: String(it.unit_price), modifiers_total: String(unit - it.unit_price), quantity: it.quantity,
        line_total: String(Math.round(unit * it.quantity * 100) / 100), notes: it.notes, sent_at: sale.created_at, ready_at: null,
        station_id: null, station_name: null, voided_at: null, void_reason: null, modifiers: mods,
      };
    }),
    payments: sale.payments.map((p, i) => ({
      id: `${sale.offline_id}-p${i}`, payment_method_id: p.payment_method_id, method_name: methodNames.get(p.payment_method_id)?.name || '',
      method_kind: methodNames.get(p.payment_method_id)?.kind || 'otro', amount: String(p.amount), tip: String(p.tip),
      received: String(p.received ?? p.amount + p.tip), change_given: String(i === 0 ? change : 0), reference: p.reference ?? null, created_at: sale.created_at,
    })),
  };
}
