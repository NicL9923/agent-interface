import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { chunkCycleGuardPlugin } from "./scripts/chunk-cycle-guard-plugin.mjs";

export default defineConfig({
  plugins: [react(), tailwindcss(), chunkCycleGuardPlugin()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", ws: true },
      "/inline-ui": "http://127.0.0.1:3000",
    },
  },
  // The iOS app's shared desktop viewer and system terminal are their own small pages, served at
  // /native/computer and /native/terminal.
  build: {
    outDir: "dist/client",
    manifest: true,
    rolldownOptions: {
      input: {
        index: "index.html",
        nativeComputer: "native-computer.html",
        nativeTerminal: "native-terminal.html",
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 20,
            },
            {
              name: "vendor-markdown",
              test: /[\\/]node_modules[\\/](?:react-markdown|remark-gfm|mdast-[^\\/]+|micromark[^\\/]*|unified|hast-[^\\/]+|unist-[^\\/]+)[\\/]/,
              priority: 15,
            },
          ],
        },
      },
    },
  },
});
