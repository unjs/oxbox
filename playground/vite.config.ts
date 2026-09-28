import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Cross-origin isolation enables SharedArrayBuffer (required by wasi-threads)
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { oxbox: fileURLToPath(new URL("../src/index.ts", import.meta.url)) } },
  server: { headers },
  preview: { headers },
});
