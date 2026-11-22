import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const dependency = (path: string) => fileURLToPath(new URL(`./node_modules/${path}`, import.meta.url))
  return {
    // The Android WebView serves the bundle from the app origin root.
    base: '/',
    plugins: [react()],
    define: {
      // The server every API call goes to. Always an absolute https URL in the app: the
      // WebView origin is https://<server.hostname>, so a relative /api would never work.
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(env.VITE_API_BASE_URL ?? ''),
      // Debug builds may talk to a plain-http dev server; release builds never do.
      'import.meta.env.VITE_ALLOW_HTTP': JSON.stringify(env.VITE_ALLOW_HTTP ?? ''),
      __APP_VERSION__: JSON.stringify(env.APP_VERSION ?? pkg.version),
    },
    resolve: {
      // Files under ../shared and ../frontend must resolve the same React and chart copies as mobile/.
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
      host: '127.0.0.1', port: 5176, strictPort: true,
      fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL('..', import.meta.url))] },
    },
    preview: { host: '127.0.0.1', port: 5177, strictPort: true },
    build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 1500 },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      globals: false,
    },
  }
})
