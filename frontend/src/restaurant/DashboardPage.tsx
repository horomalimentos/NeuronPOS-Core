import { ArrowRight, CheckCircle2, Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader, StatusBadge } from '../components/ui';
import { formatDate } from '../lib/format';
import { moduleIcon } from '../lib/modules';
import { canManage, useAdmin } from './context';
import TodaySales from './TodaySales';

export default function DashboardPage() {
  const { me } = useAdmin();
  const r = me.restaurant;
  const enabled = me.modules.filter((m) => m.enabled);
  const locked = me.modules.filter((m) => !m.enabled);
  const manager = canManage(me.user.role);
  const links: Record<string, { to: string; label: string }> = {
    pos: { to: '/admin/pos', label: 'Abrir punto de venta' },
    reportes: { to: '/admin/reportes', label: 'Ver reportes' },
    inventario: { to: '/admin/inventario', label: 'Abrir inventario' },
    lealtad: { to: '/admin/clientes', label: 'Ver clientes' },
    monedero: { to: '/admin/clientes', label: 'Ver monederos' },
    rh: manager ? { to: '/admin/rh', label: 'Abrir recursos humanos' } : { to: '/admin/mi-nomina', label: 'Ver mi nómina' },
    empleado_mes: manager ? { to: '/admin/empleado-del-mes', label: 'Ver ranking del mes' } : { to: '/admin/muro', label: 'Ver el muro' },
  };
  if (me.user.role === 'repartidor') links.domicilios = { to: '/repartidor', label: 'Abrir app del repartidor' };
  else if (manager || me.user.role === 'cajero') links.domicilios = { to: '/admin/reparto', label: 'Abrir reparto' };
  if (manager) {
    links.landing = { to: '/admin/sitio', label: 'Editar sitio web' };
    links.portal = { to: '/admin/pedidos-en-linea', label: 'Configurar pedidos' };
  }
  const link = (code: string) => links[code];

  return (
    <>
      <PageHeader
        title={`Hola, ${me.user.name.split(' ')[0]}`}
        subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={r.status} />
          {r.status === 'trial' && r.trial_ends_at && <>Tu prueba termina el {formatDate(r.trial_ends_at)}.</>}</span>}
      />

      {manager && !r.access_error && ['pos', 'reportes'].every((c) => enabled.some((m) => m.code === c)) && <TodaySales me={me} />}

      <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-gray-500">Tus módulos</h2>
      {enabled.length === 0 && <p className="mb-6 text-sm text-gray-500">Todavía no tienes módulos contratados.</p>}
      <div className="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {enabled.map((m) => {
          const Icon = moduleIcon(m.code);
          return (
            <div key={m.code} className="card relative overflow-hidden p-5">
              <div className="absolute inset-x-0 top-0 h-1 bg-brand" />
              <div className="flex items-start justify-between">
                <div className="rounded-xl bg-brand/15 p-2.5 text-brand"><Icon className="h-6 w-6" /></div>
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> Activo</span>
              </div>
              <h3 className="mt-4 font-semibold text-white">{m.name}</h3>
              <p className="mt-1 text-sm text-gray-400">{m.description}</p>
              {link(m.code) ? (
                <Link to={link(m.code)!.to} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-contrast">
                  {link(m.code)!.label} <ArrowRight className="h-3 w-3" />
                </Link>
              ) : <p className="mt-3 text-xs text-gray-600">Disponible próximamente en esta plataforma.</p>}
            </div>
          );
        })}
      </div>

      {locked.length > 0 && (
        <>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-gray-500">Más herramientas para tu restaurante</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {locked.map((m) => {
              const Icon = moduleIcon(m.code);
              return (
                <div key={m.code} className="card border-dashed p-5 opacity-80">
                  <div className="flex items-start justify-between">
                    <div className="rounded-xl bg-gray-800 p-2.5 text-gray-500"><Icon className="h-6 w-6" /></div>
                    <Lock className="h-4 w-4 text-gray-600" />
                  </div>
                  <h3 className="mt-4 font-semibold text-gray-300">{m.name}</h3>
                  <p className="mt-1 text-sm text-gray-500">{m.description}</p>
                  <p className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300">
                    <Lock className="h-3 w-3" /> Contrata este módulo
                  </p>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-gray-600">Para contratar un módulo comunícate con NeuronPOS.</p>
        </>
      )}
    </>
  );
}
