import { useOutletContext } from 'react-router-dom';
import type { Me } from '../lib/types';

export interface AdminContext {
  me: Me;
  reload: () => void;
}

/** Datos de la sesion del restaurante que AdminLayout comparte con sus paginas. */
export const useAdmin = () => useOutletContext<AdminContext>();

export const canManage = (role: string) => role === 'admin' || role === 'gerente';
