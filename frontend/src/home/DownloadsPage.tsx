import { ArrowLeft, BrainCircuit, ChefHat, Download, Monitor, Printer, Smartphone } from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { resetBranding } from '../lib/branding';
import { setSeo } from '../site/context';

/**
 * neuronpos.app/descargas: instaladores de NeuronPOS (punto de venta) y
 * Neuron KDS (cocina) para Windows, Linux y Android. La lista la escribe
 * deploy/instaladores.sh en /api/descargas/index.json.
 */

type Links = { windows: string | null; linux: string | null; android: string | null };
type Index = { version: string; updated_at: string; pos: Links; kds: Links };

const APPS: { key: 'pos' | 'kds'; name: string; Icon: ComponentType<{ className?: string }>; text: string }[] = [
  {
    key: 'pos',
    name: 'NeuronPOS',
    Icon: Monitor,
    text: 'Punto de venta para la caja: imprime tickets, cortes y comandas directo en tus impresoras térmicas y abre el cajón de dinero.',
  },
  {
    key: 'kds',
    name: 'Neuron KDS',
    Icon: ChefHat,
    text: 'Pantalla de cocina a pantalla completa. Si le conectas una impresora, imprime la comanda de cada orden que llega.',
  },
];

const PLATFORMS: { key: keyof Links; label: string; hint: string }[] = [
  { key: 'windows', label: 'Windows', hint: 'Windows 10 u 11 (64 bits)' },
  { key: 'android', label: 'Android', hint: 'Tabletas y celulares con Android 7 o más nuevo' },
  { key: 'linux', label: 'Linux', hint: 'AppImage' },
];

export default function DownloadsPage() {
  const [index, setIndex] = useState<Index | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'empty'>('loading');

  useEffect(() => {
    resetBranding();
    setSeo('Descargas · NeuronPOS', 'Instala NeuronPOS y Neuron KDS en Windows o Android, con impresión directa a impresoras térmicas.');
    fetch('/api/descargas/index.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Index | null) => { setIndex(d); setState(d ? 'ok' : 'empty'); })
      .catch(() => setState('empty'));
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800">
        <div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold text-white">
            <BrainCircuit className="h-7 w-7 text-brand" /> NeuronPOS
          </Link>
          <Link to="/" className="ml-auto inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white">
            <ArrowLeft className="h-4 w-4" /> Inicio
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-12">
        <h1 className="text-3xl font-bold text-white">Descarga las apps</h1>
        <p className="mt-3 max-w-2xl text-gray-400">
          Instálalas en la computadora de la caja o en la pantalla de la cocina. Al abrirlas por primera vez te piden la dirección
          de tu restaurante (por ejemplo <span className="text-gray-200">turestaurante.neuronpos.app</span>) y tus impresoras.
        </p>
        {index?.version && <p className="mt-2 text-sm text-gray-500">Versión {index.version}</p>}

        {state === 'empty' && (
          <div className="card mt-8 p-6 text-gray-300">
            Los instaladores se están preparando. Mientras tanto puedes usar el sistema desde el navegador en
            <span className="text-white"> turestaurante.neuronpos.app/admin</span>.
          </div>
        )}

        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {APPS.map(({ key, name, Icon, text }) => (
            <section key={key} className="card flex flex-col p-6">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/15 text-brand"><Icon className="h-6 w-6" /></span>
                <h2 className="text-xl font-semibold text-white">{name}</h2>
              </div>
              <p className="mt-3 flex-1 text-sm text-gray-400">{text}</p>
              <div className="mt-5 space-y-2">
                {PLATFORMS.map(({ key: p, label, hint }) => {
                  const href = index?.[key]?.[p];
                  return href ? (
                    <a key={p} href={href} className="flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 transition hover:border-brand">
                      {p === 'android' ? <Smartphone className="h-5 w-5 text-gray-400" /> : <Monitor className="h-5 w-5 text-gray-400" />}
                      <span className="flex-1">
                        <span className="block font-medium text-white">{label}</span>
                        <span className="block text-xs text-gray-500">{hint}</span>
                      </span>
                      <Download className="h-5 w-5 text-brand" />
                    </a>
                  ) : state === 'loading' ? (
                    <div key={p} className="h-[62px] animate-pulse rounded-xl bg-gray-900" />
                  ) : null;
                })}
              </div>
            </section>
          ))}
        </div>

        <section className="mt-12 grid gap-6 md:grid-cols-3">
          <div className="card p-5">
            <Printer className="h-6 w-6 text-brand" />
            <h3 className="mt-3 font-semibold text-white">Impresoras</h3>
            <p className="mt-1 text-sm text-gray-400">
              Térmicas de 58 u 80 mm por red (IP, puerto 9100) o USB. En Android también por cable OTG o Bluetooth.
              Se eligen en la app con el ícono de impresora o con Ctrl + coma.
            </p>
          </div>
          <div className="card p-5">
            <Smartphone className="h-6 w-6 text-brand" />
            <h3 className="mt-3 font-semibold text-white">Android</h3>
            <p className="mt-1 text-sm text-gray-400">
              Al abrir el .apk, Android pide permiso para instalar apps de esta fuente: acéptalo una sola vez.
              La app te avisa cuando hay versión nueva.
            </p>
          </div>
          <div className="card p-5">
            <Monitor className="h-6 w-6 text-brand" />
            <h3 className="mt-3 font-semibold text-white">Windows</h3>
            <p className="mt-1 text-sm text-gray-400">
              Si Windows muestra "Windows protegió su PC", da clic en "Más información" y luego en "Ejecutar de todas formas".
              Las actualizaciones se instalan solas.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
