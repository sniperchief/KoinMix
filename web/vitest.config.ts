import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    // Threads, and Vitest 2 rather than 4: on this machine Vitest 4 workers time
    // out before starting, in both pools, when the project path contains a space
    // ("KoinMix Terminal") — it URL-encodes the space into the worker path. The
    // miner package runs Vitest 2 here without trouble, so the versions match.
    // Threads also sidesteps the empty-ComSpec problem that breaks forks on
    // Windows; see the README note.
    pool: "threads",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
  },
});
