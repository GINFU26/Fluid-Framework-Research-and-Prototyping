import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [react(), wasm()],
  optimizeDeps: {
    exclude: ["@automerge/automerge", "@automerge/automerge-wasm"],
  },
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  server: {
    host: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy: {
      "/ai-proxy": {
        target: "http://localhost:6011",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ai-proxy/, ""),
      },
    },
  },
});
