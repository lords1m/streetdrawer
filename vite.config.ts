import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['maplibre-gl'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
