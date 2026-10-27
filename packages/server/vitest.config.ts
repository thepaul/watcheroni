import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // GitHub is never called for real: test/auth.test.ts stubs fetch.
        bindings: {
          GITHUB_CLIENT_ID: "Iv23test",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          GITHUB_WEBHOOK_SECRET: "test-secret",
          TICKET_KEY: "test-ticket-key",
          TICKET_KEY_OLD: "old-ticket-key",
          DEBUG_TOKEN: "test-debug-token",
        },
      },
    }),
  ],
});
