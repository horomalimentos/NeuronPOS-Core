import { useOutletContext } from 'react-router-dom';
import type { Me } from '../lib/types';

export interface AdminContext {
  me: Me;
  reload: () => void;
}

/** Datos de la sesion del restaurante que AdminLayout comparte con sus paginas. */
export const useAdmin = () => useOutletContext<AdminContext>();

export const canManage = (role: string) => role === 'admin' || role === 'gerente';

/** ¿El restaurante tiene contratado el modulo? (las funciones con precio aparte se ocultan sin el). */
export const meHas = (me: { modules: { code: string; enabled: boolean }[] }, code: string) =>
  Boolean(me.modules.find((m) => m.code === code)?.enabled);
