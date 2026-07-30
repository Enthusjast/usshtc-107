import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ command }) => ({
  plugins: [
    {
      name: 'environment-csp',
      transformIndexHtml(html) {
        const connectSource = command === 'serve'
          ? "'self' ws://localhost:5173"
          : "'self'";
        return html.replace('__CSP_CONNECT_SRC__', connectSource);
      },
    },
    react(),
    tailwindcss(),
  ],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
}));
