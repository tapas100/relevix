import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@relevix/types': resolve(__dirname, '../../libs/types/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Forward API calls to the gateway in dev
      '/v1': {
        target:    'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
