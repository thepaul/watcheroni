import { defineConfig } from "vitest/config";

// selfhost's tests run in Node; the server's own (../vitest.config.ts) run
// in workerd.
export default defineConfig({
  test: { root: import.meta.dirname, include: ["test/**/*.test.ts"] },
});
