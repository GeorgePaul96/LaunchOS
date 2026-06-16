import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // One process, one realm → a single in-memory PGlite (WASM) instance shared via
    // test/helpers.ts (on globalThis). Spawning many WASM instances exhausts resources and
    // triggers aborts; sharing + TRUNCATE between tests is fast and stable.
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    isolate: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    // PGlite's WASM runtime emits a benign `Aborted()` rejection when the process winds down
    // (after all tests pass). It is a teardown artifact, not a test failure. This flag affects
    // the test runner only — never production code.
    dangerouslyIgnoreUnhandledErrors: true,
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
