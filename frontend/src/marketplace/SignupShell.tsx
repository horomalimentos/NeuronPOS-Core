import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** Marco de los registros de NeuronPOS Delivery (mas ancho que el login: lleva mapa). */
export default function SignupShell({ icon, title, subtitle, children }: {
  icon: ReactNode; title: string; subtitle: string; children: ReactNode;
}) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-gray-950 px-4 py-8">
      <div className="pointer-events-none absolute -right-40 -top-40 h-96 w-96 rounded-full bg-brand/20 blur-3xl" />
      <div className="relative mx-auto max-w-2xl">
        <Link to="/delivery" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
          <ArrowLeft className="h-4 w-4" /> NeuronPOS Delivery
        </Link>
        <div className="card overflow-hidden shadow-2xl">
          <div className="h-1 bg-gradient-to-r from-brand/70 via-brand to-brand/70" />
          <div className="p-6 sm:p-8">
            <div className="mb-6 flex items-center gap-3">
              <div className="rounded-2xl bg-brand/15 p-3 text-brand">{icon}</div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
                <p className="text-sm text-gray-500">{subtitle}</p>
              </div>
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
