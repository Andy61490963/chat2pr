import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4521);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  forbidOnly: !!process.env.CI,
  use: { baseURL, browserName: "chromium", serviceWorkers: "block" },
  webServer: {
    command: `npm run dev:web -- --config e2e/vite.config.ts --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
