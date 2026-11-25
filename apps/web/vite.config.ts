import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// dev: `npm run dev` (UI on :5173, proxies /api and /mcp to the PRISM server on :7777)
const API = process.env.PRISM_API ?? 'http://127.0.0.1:7777';
export default defineConfig({
  root: resolve(__dirname),
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@prism/core': resolve(__dirname, '../../packages/core/src/index.ts') },
  },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': API, '/mcp': API }, fs: { allow: [resolve(__dirname, '../..')] } },
  build: { outDir: resolve(__dirname, 'dist'), target: 'es2022', chunkSizeWarningLimit: 6000, emptyOutDir: true },
});
