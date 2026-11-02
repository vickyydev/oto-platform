import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Box release only: no service worker and no separately cached staff app. */
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'box-display'),
  base: '/display/',
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') }, dedupe: ['react', 'react-dom'] },
  define: { __OTO_DISPLAY_BUILD__: JSON.stringify(process.env.OTO_BOX_BUILD_ID ?? 'development') },
  build: { outDir: path.resolve(import.meta.dirname, 'dist/display'), emptyOutDir: true },
});
