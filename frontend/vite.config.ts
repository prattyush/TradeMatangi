import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const disableHmr = process.env.VITE_DISABLE_HMR === 'true'

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [
      'tradematangi.co.in'
    ],
    hmr: disableHmr ? false : {
      protocol: 'wss',
      host: 'tradematangi.co.in',
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
