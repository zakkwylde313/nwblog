import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'stream', 'crypto']
    })
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  define: {
    'process.env': process.env
  },
  envPrefix: ['VITE_', 'FIREBASE_']  // VITE_와 FIREBASE_ 접두사를 가진 환경 변수 허용
}); 