import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  build: {
    target: 'esnext',
    outDir: resolve(__dirname, '.vite/renderer/main_window'),
    emptyOutDir: true
  },
  esbuild: {
    target: 'esnext'
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  }
});
