import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", proxy: { "/api": {target: "http://127.0.0.1:3000", ws: true}, "/inline-ui": "http://127.0.0.1:3000" } },
  // The iOS app's shared desktop viewer is its own small page, served at /native/computer.
  build: { outDir: "dist/client", manifest: true, rollupOptions: { input: { index: "index.html", nativeComputer: "native-computer.html" } } },
});
