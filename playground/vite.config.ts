import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Cross-origin isolation enables SharedArrayBuffer (required by wasi-threads)
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react(), tailwindcss(), nitro({ routeRules: { "/**": { headers } } })],
  resolve: { alias: { oxbox: fileURLToPath(new URL("../src/index.ts", import.meta.url)) } },
  // Vite-served modules/assets (incl. worker scripts) bypass Nitro route rules in dev and preview
  server: { headers },
  preview: { headers },
});
