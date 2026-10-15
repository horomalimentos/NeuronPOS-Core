// Apps instalables de Nayo (APK de Restaurante y Repartidor, EXE de
// Restaurante): con sesion, la pagina le da a la app un token de
// /api/alertas para que suene con su propio tono y salga encima de las demas
// apps mientras haya pedidos sin atender. En el navegador no hace nada.
import { useEffect, useState } from 'react';
import { api, fleetApi } from './api';
import { getNative, nativeInfo } from './native';

export type AlertsApp = 'restaurante' | 'repartidor';

/**
 * on: con sesion (y, el repartidor, en turno). Regresa true si la app
 * nativa se encarga del sonido (la pagina ya no debe sonar).
 */
export function useNativeAlerts(app: AlertsApp, on: boolean): boolean {
  const [native, setNative] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void nativeInfo().then((info) => { if (!cancelled) setNative(Boolean(info?.alerts)); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!native) return;
    const n = getNative();
    if (!on) {
      void n?.stopAlerts?.().catch(() => {});
      return;
    }
    const call = app === 'repartidor' ? fleetApi : api;
    call<{ token: string; every_s: number }>(`/alertas/${app}`, { method: 'POST' })
      .then((r) => n?.startAlerts?.(r.token, r.every_s))
      .catch(() => {});
  }, [native, on, app]);
  return native;
}

/** El repartidor salto un pedido: la app deja de sonarle por ese. */
export function skipNativeAlert(id: string) {
  void getNative()?.skipAlert?.(id).catch(() => {});
}

/** Al cerrar sesion: la app deja de estar atenta. */
export function stopNativeAlerts() {
  void getNative()?.stopAlerts?.().catch(() => {});
}
