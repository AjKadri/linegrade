import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: the UI runs on :5173 and proxies /api to the Express server on :8787.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { outDir: 'dist', sourcemap: false },
});
