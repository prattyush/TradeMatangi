import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const dependency = (path: string) => fileURLToPath(new URL(`./node_modules/${path}`, import.meta.url))
  return {
    base: '/webapp/',
    plugins: [react()],
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(env.VITE_API_BASE_URL ?? ''),
      'import.meta.env.VITE_AI_HELPER_URL': JSON.stringify(env.VITE_AI_HELPER_URL ?? ''),
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        react: dependency('react'),
        'react-dom': dependency('react-dom'),
        klinecharts: dependency('klinecharts'),
        'lightweight-charts': dependency('lightweight-charts'),
        'react-klinecharts-ui/extensions': dependency('react-klinecharts-ui/dist/extensions.js'),
      },
    },
    server: {
      host: '127.0.0.1', port: 5174, strictPort: true,
      fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL('..', import.meta.url))] },
      proxy: {
        '/api': { target: env.WEBAPP_API_PROXY ?? 'http://127.0.0.1:8700', changeOrigin: true },
        '/ai': { target: env.WEBAPP_AI_PROXY ?? 'http://127.0.0.1:8701', changeOrigin: true },
      },
    },
    preview: { host: '127.0.0.1', port: 5174, strictPort: true },
  }
})
