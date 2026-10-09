import { useOutletContext } from 'react-router-dom';
import type { Branch } from '../lib/types';
import type { AdminContext } from '../restaurant/context';

export interface InvContext extends AdminContext {
  branchId: string;
  branches: Branch[];
  manager: boolean;
}

/** Sesion, sucursal elegida y si es admin/gerente (lo comparte InventoryLayout). */
export const useInv = () => useOutletContext<InvContext>();
