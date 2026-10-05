import { useState } from 'react';
import { useAdmin } from '../restaurant/context';
import { posPrefs } from './lib';

/**
 * Sucursal con la que trabaja el POS en este dispositivo. Se recuerda en
 * localStorage; si ya no es accesible se usa la principal del usuario.
 */
export function usePosBranch() {
  const { me } = useAdmin();
  const branches = me.branches.filter((b) => b.active);
  const [branchId, setBranchIdState] = useState<string>(() => {
    const saved = posPrefs.getBranch();
    if (saved && branches.some((b) => b.id === saved)) return saved;
    const primary = me.user.branch_ids.find((id) => branches.some((b) => b.id === id));
    return primary || branches[0]?.id || '';
  });
  const setBranchId = (id: string) => {
    posPrefs.setBranch(id);
    setBranchIdState(id);
  };
  const branch = branches.find((b) => b.id === branchId) || null;
  return { branchId, setBranchId, branches, branch };
}
