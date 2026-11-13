import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5178,
    proxy: {
      "/api": "http://127.0.0.1:4310",
      "/auth": "http://127.0.0.1:4310",
    },
  },
  build: {
    outDir: "dist/web",
    rollupOptions: {
      input: {
        dashboard: fileURLToPath(new URL("./index.html", import.meta.url)),
        demo: fileURLToPath(
          new URL("./docs/rag-flow-demo.html", import.meta.url),
        ),
      },
    },
  },
});
