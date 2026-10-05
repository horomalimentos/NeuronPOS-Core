// Reglas de acceso por estado del restaurante y modulos contratados.
// Funciones puras: el middleware requireModule les pasa los datos ya leidos.
import { isModuleActive } from './billing.js';

export const PAYMENT_REQUIRED = 402;

/** null si el restaurante puede operar; si no, el error a responder. */
export function checkRestaurantAccess(restaurant, now = new Date()) {
  if (!restaurant) {
    return { status: 404, code: 'RESTAURANT_NOT_FOUND', error: 'Restaurante no encontrado' };
  }
  if (restaurant.status === 'suspended') {
    return {
      status: PAYMENT_REQUIRED,
      code: 'RESTAURANT_SUSPENDED',
      error: 'Este restaurante está suspendido. Comunícate con NeuronPOS para reactivar tu servicio.',
    };
  }
  if (restaurant.status === 'trial' && restaurant.trial_ends_at && new Date(restaurant.trial_ends_at) <= now) {
    return {
      status: PAYMENT_REQUIRED,
      code: 'TRIAL_EXPIRED',
      error: 'Tu periodo de prueba terminó. Contrata tu suscripción para seguir usando NeuronPOS.',
    };
  }
  return null;
}

/**
 * moduleRow: fila de restaurant_modules unida al catalogo (o null si el
 * restaurante nunca tuvo el modulo). moduleName se usa en el mensaje.
 */
export function checkModuleAccess(restaurant, moduleCode, moduleRow, now = new Date()) {
  const restaurantError = checkRestaurantAccess(restaurant, now);
  if (restaurantError) return restaurantError;
  if (!isModuleActive(moduleRow, now)) {
    const name = moduleRow?.name || moduleCode;
    return {
      status: PAYMENT_REQUIRED,
      code: 'MODULE_NOT_ENABLED',
      module: moduleCode,
      error: `Tu restaurante no tiene contratado el módulo "${name}". Contrata este módulo para usarlo.`,
    };
  }
  return null;
}
