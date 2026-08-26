/**
 * Populate `process.env` from a `.env` file, if one exists.
 *
 * This is the counterpart to env.ts, not an exception to it: that module remains
 * the only place that *reads* configuration. This one only fills the environment
 * in beforehand, and knows nothing about what any variable means.
 *
 * Call it from entry points *before* `loadConfig()`, and from nowhere else.
 * Library code must never load files as a side effect of being imported, and
 * tests construct their configuration explicitly, so neither should reach this.
 *
 * Uses Node's built-in loader rather than a dependency. Two properties of it
 * matter here:
 *
 *   - **Real environment variables win.** A value already present in
 *     `process.env` is not overwritten by the file, so a deployment's injected
 *     secrets cannot be clobbered by a stray `.env`, and a one-off
 *     `KEY=... npm run ...` override still works.
 *   - **A missing file is not an error.** Running without a `.env` is the normal
 *     case in production, where configuration arrives from the environment.
 */

/** The default file name, relative to the working directory. */
const DEFAULT_ENV_FILE = ".env";

export function loadEnvFile(path: string = DEFAULT_ENV_FILE): void {
  // Added in Node 20.12. The engines floor is 20.11, so a build one patch
  // release short of it should degrade to environment-only configuration
  // rather than crashing at startup.
  if (typeof process.loadEnvFile !== "function") return;

  try {
    process.loadEnvFile(path);
  } catch {
    // Absent or unreadable: configuration comes from the environment instead,
    // and loadConfig() will report anything genuinely missing with far better
    // detail than a file-not-found could.
  }
}
