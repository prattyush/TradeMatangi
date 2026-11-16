import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      klinecharts: fileURLToPath(
        new URL("./node_modules/klinecharts", import.meta.url),
      ),
      "react-klinecharts-ui/extensions": fileURLToPath(
        new URL(
          "./node_modules/react-klinecharts-ui/dist/extensions.js",
          import.meta.url,
        ),
      ),
    },
  },
  plugins: [react()],
  // The Games workers (puzzle generators) load their word lists with import(): that needs the ES module format, not the default IIFE.
  worker: { format: "es" },
  // Tests sit beside the code, including the shared Games code that the desktop, website and webapp all use.
  test: { include: ['src/**/*.test.{ts,tsx}', '../shared/games/**/*.test.{ts,tsx}'] },
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
});
