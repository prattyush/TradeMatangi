import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'], alias: { 'lightweight-charts': fileURLToPath(new URL('../frontend/node_modules/lightweight-charts', import.meta.url)) } },
  plugins: [react()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
})
