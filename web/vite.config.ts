import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The terminal talks to the miner over plain HTTP with CORS, rather than through
 * a dev-only proxy, so the same code path runs in development and from a static
 * build. Point it elsewhere with VITE_MINER_URL.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  build: { outDir: "dist", sourcemap: true },
});
