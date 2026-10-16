import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", proxy: { "/api": {target: "http://127.0.0.1:3000", ws: true}, "/inline-ui": "http://127.0.0.1:3000" } },
  build: { outDir: "dist/client", manifest: true },
});
