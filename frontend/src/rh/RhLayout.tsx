import { CalendarClock, CalendarRange, Receipt, Settings2, Users } from 'lucide-react';
import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { useAdmin } from '../restaurant/context';
import { rhCan } from './lib';

/** Pestañas de Recursos humanos (admin y gerente). */
export default function RhLayout() {
  const ctx = useAdmin();
  if (!rhCan.manage(ctx.me.user.role)) return <Navigate to="/admin/mi-nomina" replace />;
  const tabs = [
    { to: '/admin/rh', label: 'Empleados', icon: Users, end: true },
    ...(ctx.me.modules.some((m) => m.code === 'turnos' && m.enabled)
      ? [{ to: '/admin/rh/turnos', label: 'Rol de turnos', icon: CalendarRange, end: false }] : []),
    { to: '/admin/rh/asistencia', label: 'Asistencia', icon: CalendarClock, end: false },
    { to: '/admin/rh/nomina', label: 'Nómina', icon: Receipt, end: false },
    { to: '/admin/rh/ajustes', label: 'Configuración', icon: Settings2, end: false },
  ];
  return (
    <>
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-gray-800">
        {tabs.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end}
            className={({ isActive }) => `-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition
              ${isActive ? 'border-brand text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>
            <Icon className="h-4 w-4" /> {label}
          </NavLink>
        ))}
      </div>
      <Outlet context={ctx} />
    </>
  );
}
