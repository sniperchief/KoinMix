import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    /**
     * Vitest's default `forks` pool spawns workers via child_process, which
     * hangs indefinitely on Windows shells where `ComSpec` is unset. The suite
     * is pure and has no cross-test global state, so threads are a safe and
     * notably faster fit.
     */
    pool: "threads",
  },
});
