import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    env: {
      SECRETS_FILE: "tests/fixtures/secrets.json",
      PUBLIC_URL: "http://localhost:4310",
      ADMIN_GITHUB_ID: "1000001",
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    fileParallelism: false,
  },
});
