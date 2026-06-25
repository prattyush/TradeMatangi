import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [
      'tradematangi.co.in'
    ],
    hmr: {
      protocol: 'wss',
      host: 'tradematangi.co.in/ws',
      clientPort: 443
    },
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'https://tradematangi.co.in/api',
        changeOrigin: true,
      },
      '/ai': {
        target: 'https://tradematangi.co.in/ai',
        changeOrigin: true,
      },
    },
  },
})
