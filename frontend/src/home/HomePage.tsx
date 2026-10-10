import {
  ArrowRight, Award, BarChart3, Boxes, BrainCircuit, HeartHandshake, Check, ChefHat, Globe, Mail, MessageCircle, Monitor, ShieldCheck, Smartphone,
  Truck, Users,
} from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { resetBranding } from '../lib/branding';
import { formatMXN } from '../lib/format';
import { setSeo } from '../site/context';
import Demo from './Demo';

/**
 * Pagina principal de neuronpos.app (dominio de la plataforma, sin
 * restaurante): que es NeuronPOS, demo interactivo, modulos con su precio
 * mensual (el que el dueno fija en Panel > Modulos) y contacto.
 */

type Plan = { code: string; name: string; description: string; monthly_price_mxn: string };
type PlansResponse = { modules: Plan[]; trial_days: number };

// Contacto de ventas. Se puede cambiar al compilar (frontend/.env); por
// omision es el WhatsApp de ventas de NeuronPOS.
const WHATSAPP = (import.meta.env.VITE_CONTACT_WHATSAPP || '526566970990').replace(/\D/g, '');
const EMAIL = import.meta.env.VITE_CONTACT_EMAIL || '';
const contactHref = WHATSAPP
  ? `https://wa.me/${WHATSAPP}?text=${encodeURIComponent('Hola, quiero información de NeuronPOS para mi restaurante')}`
  : EMAIL ? `mailto:${EMAIL}?subject=${encodeURIComponent('Quiero NeuronPOS')}` : '';

const MODULE_INFO: Record<string, { Icon: ComponentType<{ className?: string }>; points: string[] }> = {
  pos: { Icon: Monitor, points: ['Mesas, barra y para llevar', 'Pantalla de cocina en tiempo real', 'Cortes de caja y tickets'] },
  reportes: { Icon: BarChart3, points: ['Ventas por día, hora y producto', 'Comparativo contra el periodo anterior', 'Descarga a Excel'] },
  lealtad: { Icon: HeartHandshake, points: ['Clientes con historial de compras', 'Puntos con el nombre de tu programa', 'Canje en caja con código seguro'] },
  inventario: { Icon: Boxes, points: ['Recetas que descuentan insumos al vender', 'Conteos con foto, mermas y faltantes', 'Pedido sugerido y compras por WhatsApp'] },
  landing: { Icon: Globe, points: ['Tu propia dirección web', 'Menú, horarios y sucursales', 'Tus colores y tu logo'] },
  portal: { Icon: Smartphone, points: ['Tus clientes piden desde el celular', 'Pago en línea con tarjeta o al recibir', 'Seguimiento del pedido'] },
  rh: { Icon: Users, points: ['Checador de asistencia', 'Prenómina semanal', 'Expedientes de empleados'] },
  empleado_mes: { Icon: Award, points: ['Votación del equipo', 'Muro de reconocimientos', 'Motiva a tu personal'] },
  domicilios: { Icon: Truck, points: ['Con tus repartidores', 'O con nuestra flotilla', 'Mapa y cortes por repartidor'] },
};

export default function HomePage() {
  const [plans, setPlans] = useState<PlansResponse | null>(null);

  useEffect(() => {
    resetBranding();
    setSeo(
      'NeuronPOS · Punto de venta y pedidos en línea para restaurantes',
      'Punto de venta, sitio web, pedidos en línea, nómina y domicilios para tu restaurante. Paga solo los módulos que usas.',
    );
    api<PlansResponse>('/public/plans', { noRedirect: true }).then(setPlans).catch(() => setPlans(null));
  }, []);

  const cta = contactHref
    ? <a href={contactHref} target="_blank" rel="noreferrer" className="btn-brand !px-6 !py-3">Quiero NeuronPOS <ArrowRight className="h-4 w-4" /></a>
    : <a href="#demo" className="btn-brand !px-6 !py-3">Probar el demo <ArrowRight className="h-4 w-4" /></a>;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="sticky top-0 z-40 border-b border-gray-800/80 bg-gray-950/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <a href="#inicio" className="flex items-center gap-2 font-semibold text-white">
            <BrainCircuit className="h-7 w-7 text-brand" /> NeuronPOS
          </a>
          <nav className="ml-auto hidden items-center gap-6 text-sm text-gray-400 md:flex">
            <a href="#funciones" className="hover:text-white">Funciones</a>
            <a href="#demo" className="hover:text-white">Demo</a>
            <a href="#precios" className="hover:text-white">Precios</a>
            <Link to="/descargas" className="hover:text-white">Descargas</Link>
          </nav>
          <Link to="/admin/login" className="ml-auto rounded-full border border-gray-700 px-4 py-2 text-sm text-gray-200 hover:border-gray-500 md:ml-0">
            Entrar
          </Link>
        </div>
      </header>

      <section id="inicio" className="relative overflow-hidden">
        <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-brand/20 blur-3xl" />
        <div className="relative mx-auto max-w-4xl px-4 pb-16 pt-20 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-gray-800 bg-gray-900 px-3 py-1 text-xs text-gray-300">
            <ChefHat className="h-3.5 w-3.5 text-brand" /> Hecho por restauranteros, para restauranteros
          </span>
          <h1 className="mt-6 text-4xl font-bold leading-tight text-white sm:text-5xl">
            Todo tu restaurante en un solo sistema
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-gray-400">
            Punto de venta, pantalla de cocina, tu propio sitio web con pedidos en línea, nómina y domicilios.
            Contratas solo los módulos que necesitas y pagas mes a mes.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {cta}
            <a href="#precios" className="inline-flex items-center rounded-full border border-gray-700 px-6 py-3 text-sm font-semibold text-gray-200 hover:border-gray-500">
              Ver precios
            </a>
          </div>
          {plans && <p className="mt-4 text-sm text-gray-500">{plans.trial_days} días de prueba sin costo.</p>}
        </div>
      </section>

      <section id="funciones" className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="text-center text-3xl font-bold text-white">Lo que incluye</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-gray-400">Cada módulo funciona solo o junto con los demás: una venta en línea llega directo a la cocina y al corte de caja.</p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(plans?.modules || FALLBACK).map((m) => {
            const info = MODULE_INFO[m.code];
            const Icon = info?.Icon || BrainCircuit;
            return (
              <div key={m.code} className="card p-5">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand/15 text-brand"><Icon className="h-6 w-6" /></span>
                <h3 className="mt-4 text-lg font-semibold text-white">{m.name}</h3>
                <p className="mt-1 text-sm text-gray-400">{m.description}</p>
                {info && (
                  <ul className="mt-3 space-y-1.5 text-sm text-gray-300">
                    {info.points.map((p) => <li key={p} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />{p}</li>)}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section id="demo" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-16">
        <h2 className="text-center text-3xl font-bold text-white">Pruébalo aquí mismo</h2>
        <p className="mx-auto mb-8 mt-3 max-w-2xl text-center text-gray-400">
          Cobra una venta en el punto de venta o haz un pedido como cliente, y mira cómo llega a la cocina y a tus ventas del día.
          Son datos de ejemplo: no se guarda nada.
        </p>
        <Demo />
      </section>

      <section id="precios" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-16">
        <h2 className="text-center text-3xl font-bold text-white">Precios por módulo</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-gray-400">Sin contratos largos. Elige los módulos, paga cada mes con tarjeta y agrega o quita cuando quieras.</p>
        <PriceCalculator modules={plans?.modules || FALLBACK} trialDays={plans?.trial_days} />
        <p className="mt-4 text-center text-sm text-gray-500">Precios en pesos mexicanos.</p>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="grid gap-6 md:grid-cols-3">
          {[
            { n: '1', t: 'Elige tus módulos', d: 'Arma tu plan con lo que tu restaurante necesita hoy.' },
            { n: '2', t: 'Te damos tu dirección', d: 'Tu sitio queda en turestaurante.neuronpos.app, o en tu propio dominio.' },
            { n: '3', t: 'Empieza a vender', d: 'Da de alta tu menú, tus sucursales y tu personal, y abre caja.' },
          ].map((s) => (
            <div key={s.n} className="card p-5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand font-bold text-brand-contrast">{s.n}</span>
              <h3 className="mt-3 font-semibold text-white">{s.t}</h3>
              <p className="mt-1 text-sm text-gray-400">{s.d}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 flex items-center justify-center gap-2 text-sm text-gray-500">
          <ShieldCheck className="h-4 w-4" /> Los datos de cada restaurante están separados y solo tu equipo puede verlos.
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-20 pt-8 text-center">
        <div className="rounded-3xl border border-gray-800 bg-gradient-to-br from-brand/20 to-gray-900 px-6 py-12">
          <h2 className="text-3xl font-bold text-white">¿Listo para probarlo en tu restaurante?</h2>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {cta}
            {WHATSAPP && EMAIL && (
              <a href={`mailto:${EMAIL}`} className="inline-flex items-center gap-2 rounded-full border border-gray-700 px-6 py-3 text-sm text-gray-200"><Mail className="h-4 w-4" /> {EMAIL}</a>
            )}
          </div>
          {WHATSAPP && <p className="mt-4 inline-flex items-center gap-1.5 text-sm text-gray-400"><MessageCircle className="h-4 w-4" /> Te respondemos por WhatsApp</p>}
        </div>
      </section>

      <footer className="border-t border-gray-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-gray-500">
          <span className="inline-flex items-center gap-1.5"><BrainCircuit className="h-4 w-4" /> © {new Date().getFullYear()} NeuronPOS</span>
          <span className="flex gap-4">
            <Link to="/descargas" className="hover:text-gray-300">Descargar apps</Link>
            <Link to="/admin/login" className="hover:text-gray-300">Entrar a mi restaurante</Link>
            <Link to="/panel" className="hover:text-gray-300">Panel</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

const DEFAULT_PICK = ['pos', 'landing', 'portal'];

/** Lista de modulos con casillas: el visitante arma su plan y ve el total al mes. */
function PriceCalculator({ modules, trialDays }: { modules: Plan[]; trialDays?: number }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(DEFAULT_PICK));
  const toggle = (code: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });
  const priced = modules.filter((m) => Number(m.monthly_price_mxn) > 0);
  const total = modules.filter((m) => picked.has(m.code)).reduce((s, m) => s + Number(m.monthly_price_mxn), 0);
  const allTotal = priced.reduce((s, m) => s + Number(m.monthly_price_mxn), 0);
  const allPicked = priced.length > 0 && priced.every((m) => picked.has(m.code));

  return (
    <div className="mx-auto mt-10 max-w-3xl overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
      <div className="divide-y divide-gray-800">
        {modules.map((m) => {
          const price = Number(m.monthly_price_mxn);
          const on = picked.has(m.code);
          return (
            <label key={m.code} className={`flex cursor-pointer items-center gap-4 px-5 py-4 transition ${on ? 'bg-brand/5' : 'hover:bg-gray-800/40'}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(m.code)} className="h-5 w-5 shrink-0 accent-[rgb(var(--brand-primary))]" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-white">{m.name}</p>
                <p className="text-sm text-gray-500">{m.description}</p>
              </div>
              <p className="shrink-0 text-right">
                {price > 0
                  ? <><span className="text-lg font-semibold text-white">{formatMXN(price)}</span><span className="text-sm text-gray-500"> /mes</span></>
                  : <span className="text-sm text-gray-400">Pregunta por el precio</span>}
              </p>
            </label>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-gray-800 bg-gray-950/60 px-5 py-5">
        <div className="flex-1">
          <p className="text-sm text-gray-400">Tu plan ({picked.size} {picked.size === 1 ? 'módulo' : 'módulos'})</p>
          <p className="text-3xl font-bold text-white">{formatMXN(total)}<span className="text-base font-normal text-gray-500"> /mes</span></p>
          {trialDays ? <p className="mt-1 text-sm text-gray-500">Los primeros {trialDays} días son gratis.</p> : null}
        </div>
        {allTotal > 0 && !allPicked && (
          <button type="button" onClick={() => setPicked(new Set(modules.map((m) => m.code)))}
            className="rounded-full border border-gray-700 px-5 py-2.5 text-sm font-semibold text-gray-200 hover:border-gray-500">
            Ver todo incluido · {formatMXN(allTotal)}
          </button>
        )}
      </div>
    </div>
  );
}

// Si la API no responde, la pagina se muestra igual con el catalogo base.
const FALLBACK: Plan[] = [
  { code: 'pos', name: 'Punto de venta', description: 'POS para tomar órdenes, cobrar y hacer cortes de caja.', monthly_price_mxn: '0' },
  { code: 'landing', name: 'Sitio web', description: 'Página web del restaurante con menú, ubicación y contacto.', monthly_price_mxn: '0' },
  { code: 'portal', name: 'Portal de clientes', description: 'Portal de clientes y pedidos en línea.', monthly_price_mxn: '0' },
  { code: 'rh', name: 'Recursos humanos', description: 'Asistencia, prenómina y expedientes.', monthly_price_mxn: '0' },
  { code: 'empleado_mes', name: 'Empleado del mes', description: 'Reconocimiento y votación del empleado del mes.', monthly_price_mxn: '0' },
  { code: 'domicilios', name: 'Domicilios', description: 'Entregas con repartidores propios o con nuestra flotilla.', monthly_price_mxn: '0' },
];
