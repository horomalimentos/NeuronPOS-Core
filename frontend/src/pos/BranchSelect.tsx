import { Building2 } from 'lucide-react';
import type { Branch } from '../lib/types';

/** Selector compacto de sucursal (se oculta si solo hay una). */
export default function BranchSelect({ branches, value, onChange }: {
  branches: Branch[]; value: string; onChange: (id: string) => void;
}) {
  if (branches.length <= 1) {
    return branches[0] ? (
      <span className="inline-flex items-center gap-1.5 text-sm text-gray-400"><Building2 className="h-4 w-4" /> {branches[0].name}</span>
    ) : null;
  }
  return (
    <label className="inline-flex items-center gap-2 text-sm text-gray-400">
      <Building2 className="h-4 w-4" />
      <select className="input w-auto py-1.5" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Sucursal">
        {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </label>
  );
}
