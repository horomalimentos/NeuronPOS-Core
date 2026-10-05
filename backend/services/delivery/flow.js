// Estados de un reparto (fase 5). Funciones puras: las rutas validan cada
// cambio con assertTransition antes de tocar la BD.
//
//   solicitado (solo flota) -> asignado -> recogido -> en_camino -> entregado
//                                  |            |           |
//                              cancelado     fallido     fallido  (con motivo)
//
// - Repartidores propios: el reparto nace "asignado" (la caja elige quien
//   se lleva el pedido); "cancelado" = se le quita el pedido antes de que lo
//   recoja.
// - Flota de la plataforma: la solicitud nace "solicitado" hasta que el
//   Panel (o una oferta aceptada) le asigna repartidor; quitarle el
//   repartidor la regresa a "solicitado".
import { HttpError } from '../../utils/http.js';

export const DELIVERY_STATUSES = ['solicitado', 'asignado', 'recogido', 'en_camino', 'entregado', 'fallido', 'cancelado'];
export const ACTIVE_DELIVERY_STATUSES = ['solicitado', 'asignado', 'recogido', 'en_camino'];
export const FINAL_DELIVERY_STATUSES = ['entregado', 'fallido', 'cancelado'];

export const DELIVERY_STATUS_LABEL = {
  solicitado: 'Buscando repartidor',
  asignado: 'Repartidor asignado',
  recogido: 'Recogido por el repartidor',
  en_camino: 'En camino',
  entregado: 'Entregado',
  fallido: 'No se pudo entregar',
  cancelado: 'Cancelado',
};

const NEXT = {
  solicitado: ['asignado', 'cancelado'],
  asignado: ['recogido', 'cancelado'],
  recogido: ['en_camino', 'fallido'],
  en_camino: ['entregado', 'fallido'],
  entregado: [],
  fallido: [],
  cancelado: [],
};

/** Lo que el repartidor puede marcar desde su app. */
export const DRIVER_STATUSES = ['recogido', 'en_camino', 'entregado', 'fallido'];

export const canTransition = (from, to) => Boolean(NEXT[from]?.includes(to));

/** Lanza 409 INVALID_TRANSITION si el cambio de estado no es valido. */
export function assertTransition(from, to) {
  if (!DELIVERY_STATUSES.includes(to)) {
    throw new HttpError(400, `Estado de reparto invalido: ${to}`, 'INVALID_STATUS');
  }
  if (!canTransition(from, to)) {
    throw new HttpError(
      409,
      `No se puede pasar de "${DELIVERY_STATUS_LABEL[from] || from}" a "${DELIVERY_STATUS_LABEL[to]}"`,
      'INVALID_TRANSITION',
    );
  }
}

/** Columna de hora que se llena al llegar a cada estado. */
export const STATUS_TIMESTAMP = {
  asignado: 'assigned_at',
  recogido: 'picked_up_at',
  en_camino: 'on_way_at',
  entregado: 'delivered_at',
  fallido: 'failed_at',
  cancelado: 'cancelled_at',
};
