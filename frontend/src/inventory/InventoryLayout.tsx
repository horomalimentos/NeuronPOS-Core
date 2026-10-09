import { BookOpen, ClipboardCheck, Boxes, LineChart, Package, ShoppingCart, Truck } from 'lucide-react';
import { NavLink, Navigate, Outlet } from 'react-router-dom';
import BranchSelect from '../pos/BranchSelect';
import { usePosBranch } from '../pos/usePosBranch';
import { useAdmin } from '../restaurant/context';
import type { InvContext } from './context';
import { invCan } from './lib';

/** Pestañas del modulo de inventario y sucursal con la que se trabaja. */
export default function InventoryLayout() {
  const ctx = useAdmin();
  const { branchId, setBranchId, branches } = usePosBranch();
  const role = ctx.me.user.role;
  if (!invCan.staff(role)) return <Navigate to="/admin" replace />;
  const manager = invCan.manage(role);
  const tabs = [
    { to: '/admin/inventario', label: 'Existencias', icon: Boxes, end: true, show: true },
    { to: '/admin/inventario/conteos', label: 'Conteos', icon: ClipboardCheck, end: false, show: true },
    { to: '/admin/inventario/compras', label: 'Compras', icon: ShoppingCart, end: false, show: true },
    { to: '/admin/inventario/insumos', label: 'Insumos', icon: Package, end: false, show: manager },
    { to: '/admin/inventario/recetas', label: 'Recetas', icon: BookOpen, end: false, show: manager },
    { to: '/admin/inventario/proveedores', label: 'Proveedores y áreas', icon: Truck, end: false, show: manager },
    { to: '/admin/inventario/consumo', label: 'Consumo', icon: LineChart, end: false, show: manager },
  ].filter((t) => t.show);
  const inv: InvContext = { ...ctx, branchId, branches, manager };
  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-gray-800">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}
              className={({ isActive }) => `-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition
                ${isActive ? 'border-brand text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>
              <Icon className="h-4 w-4" /> {label}
            </NavLink>
          ))}
        </div>
        <div className="pb-2"><BranchSelect branches={branches} value={branchId} onChange={setBranchId} /></div>
      </div>
      {branchId ? <Outlet context={inv} /> : <p className="text-sm text-gray-500">Primero da de alta una sucursal.</p>}
    </>
  );
}
