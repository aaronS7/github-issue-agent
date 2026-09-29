import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: '../dist/ui', emptyOutDir: true },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    allowedHosts: process.env.UI_DEV_HOST ? [process.env.UI_DEV_HOST] : [],
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.UI_API_PORT || '3100'}`, changeOrigin: true } },
  },
});
