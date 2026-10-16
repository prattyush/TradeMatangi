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
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
});
