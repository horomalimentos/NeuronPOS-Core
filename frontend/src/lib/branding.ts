// Aplica los colores del restaurante como variables CSS que usa Tailwind
// (bg-brand, text-brand, etc.).
const DEFAULT_PRIMARY = '#C8202A';
const DEFAULT_SECONDARY = '#1E1E1E';

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Blanco o negro, lo que se lea mejor sobre el color dado. */
function contrastFor([r, g, b]: [number, number, number]): string {
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '17 24 39' : '255 255 255';
}

export function applyBranding(primary?: string | null, secondary?: string | null) {
  const p = hexToRgb(primary || '') || hexToRgb(DEFAULT_PRIMARY)!;
  const s = hexToRgb(secondary || '') || hexToRgb(DEFAULT_SECONDARY)!;
  const root = document.documentElement.style;
  root.setProperty('--brand-primary', p.join(' '));
  root.setProperty('--brand-secondary', s.join(' '));
  root.setProperty('--brand-contrast', contrastFor(p));
}

export const resetBranding = () => applyBranding(DEFAULT_PRIMARY, DEFAULT_SECONDARY);
