// Puente con las apps instaladas (NeuronPOS / Neuron KDS de escritorio y
// Android). En el navegador no existe y todo sigue igual: se imprime con la
// ventana de impresion. Dentro de la app se imprime directo a la impresora
// configurada en la app (tickets y cortes, o comandas).

export type PrintRole = 'ticket' | 'comanda' | 'documento';

export interface NativeInfo {
  platform: 'desktop' | 'android';
  mode: 'pos' | 'kds' | 'nayorest' | 'nayorep';
  version: string;
  printers: { ticket: boolean; comanda: boolean };
  drawer: boolean;
  /** Apps de Nayo: la app suena con su tono cuando hay pedidos sin atender. */
  alerts?: boolean;
}

interface NativeBridge {
  info(): Promise<NativeInfo | null>;
  print(job: { role: PrintRole; html: string; openDrawer?: boolean }): Promise<{ printed: boolean }>;
  openDrawer(): Promise<boolean>;
  openSettings(): Promise<boolean>;
  startAlerts?(token: string, everySeconds: number): Promise<boolean>;
  stopAlerts?(): Promise<boolean>;
  skipAlert?(id: string): Promise<boolean>;
}

// La app de Android (MainActivity.WebBridge) expone metodos de Java: info()
// responde al momento; print y openDrawer responden despues llamando a
// window.__neuronCb(id, resultado). Aqui se adapta a la forma de escritorio.
interface AndroidBridge {
  info(): string;
  print(job: string, callbackId: string): void;
  openDrawer(callbackId: string): void;
  openSettings(): void;
  // Solo las apps de Nayo.
  startAlerts?(token: string, everySeconds: number): void;
  stopAlerts?(): void;
  skipAlert?(id: string): void;
}

declare global {
  interface Window {
    neuronNative?: NativeBridge;
    NeuronAndroid?: AndroidBridge;
    __neuronCb?: (id: string, result: unknown) => void;
  }
}

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let seq = 0;

function androidBridge(a: AndroidBridge): NativeBridge {
  if (!window.__neuronCb) {
    window.__neuronCb = (id, result) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      const r = result as { error?: string } | null;
      if (r && r.error) p.reject(new Error(r.error)); else p.resolve(r);
    };
  }
  const later = <T,>(fn: (id: string) => void) => new Promise<T>((resolve, reject) => {
    const id = `n${++seq}`;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    fn(id);
  });
  return {
    info: async () => JSON.parse(a.info()) as NativeInfo | null,
    print: (job) => later((id) => a.print(JSON.stringify(job), id)),
    openDrawer: () => later((id) => a.openDrawer(id)),
    openSettings: async () => { a.openSettings(); return true; },
    startAlerts: a.startAlerts ? async (token, every) => { a.startAlerts?.(token, every); return true; } : undefined,
    stopAlerts: a.stopAlerts ? async () => { a.stopAlerts?.(); return true; } : undefined,
    skipAlert: a.skipAlert ? async (id) => { a.skipAlert?.(id); return true; } : undefined,
  };
}

export function getNative(): NativeBridge | null {
  if (typeof window === 'undefined') return null;
  if (window.neuronNative) return window.neuronNative;
  if (window.NeuronAndroid) return androidBridge(window.NeuronAndroid);
  return null;
}

let infoPromise: Promise<NativeInfo | null> | null = null;
/** Datos de la app (null en el navegador). Se cachea; `fresh` vuelve a preguntar. */
export function nativeInfo(fresh = false): Promise<NativeInfo | null> {
  const n = getNative();
  if (!n) return Promise.resolve(null);
  if (!infoPromise || fresh) infoPromise = n.info().catch(() => null);
  return infoPromise;
}

/**
 * Manda a la impresora de la app. Regresa false si no hay app o la app no
 * tiene impresora para ese uso (el llamador decide si usa el navegador).
 */
export async function nativePrint(role: PrintRole, html: string, opts: { openDrawer?: boolean } = {}): Promise<boolean> {
  const n = getNative();
  if (!n) return false;
  const res = await n.print({ role, html, openDrawer: opts.openDrawer });
  return Boolean(res?.printed);
}
