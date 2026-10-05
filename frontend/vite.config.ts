import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En desarrollo /api se manda al backend (puerto 8100). Se conserva el Host
// original (changeOrigin: false) para que el backend resuelva el restaurante
// por subdominio, p. ej. http://horom.localhost:5173
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8100',
        changeOrigin: false,
      },
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});
