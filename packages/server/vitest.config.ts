import { generateKeyPairSync, randomBytes } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway App key for each run; tests check JWTs with the public half.
const appKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export default defineConfig({
  // selfhost/ has its own tests, which run in Node.
  test: { include: ["test/**/*.test.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // GitHub is never called for real: the tests stub fetch.
        bindings: {
          GITHUB_APP_ID: "5490181",
          GITHUB_APP_PRIVATE_KEY: appKey.privateKey,
          TEST_APP_PUBLIC_KEY: appKey.publicKey,
          STORAGE_KEY: randomBytes(32).toString("base64"),
          GITHUB_CLIENT_ID: "Iv23test",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          GITHUB_WEBHOOK_SECRET: "test-secret",
          TICKET_KEY: "test-ticket-key",
          TICKET_KEY_OLD: "old-ticket-key",
          API_KEY_SECRET: "test-api-key-secret",
          DEBUG_TOKEN: "test-debug-token",
        },
      },
    }),
  ],
});
