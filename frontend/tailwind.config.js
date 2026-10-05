/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Colores del restaurante, inyectados como variables CSS "R G B"
        // (ver src/lib/branding.ts). En el Panel NeuronPOS son los de la marca.
        brand: 'rgb(var(--brand-primary) / <alpha-value>)',
        'brand-secondary': 'rgb(var(--brand-secondary) / <alpha-value>)',
        'brand-contrast': 'rgb(var(--brand-contrast) / <alpha-value>)',
      },
    },
  },
  plugins: [],
};
