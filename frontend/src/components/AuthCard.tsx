import type { ReactNode } from 'react';

// Tarjeta de login con el mismo look que NeuronPOS (fondo oscuro, barra de color).
export function AuthCard({ title, subtitle, logo, children }: {
  title: string; subtitle?: string; logo?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gray-950 p-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -right-40 -top-40 h-96 w-96 rounded-full bg-brand/20 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-brand/10 blur-3xl" />
      </div>
      <div className="relative w-full max-w-md">
        <div className="card overflow-hidden shadow-2xl">
          <div className="h-1 bg-gradient-to-r from-brand/70 via-brand to-brand/70" />
          <div className="px-8 pb-8 pt-8">
            <div className="mb-8 flex flex-col items-center text-center">
              {logo}
              <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
              {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
