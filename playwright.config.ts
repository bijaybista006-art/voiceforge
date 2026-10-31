import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { AUTH_PORT, E2E_AUTH, PORT } from "./e2e/env";

/**
 * End-to-end tests for the UI. They run against a production build
 * (`npm run build` first) and mock every /api call in the browser, so no
 * database, GPU or network is needed.
 *
 * Two servers: an open one (no login configured, like a fresh deploy — the
 * viewer is the admin) and one with login switched on, to check what a
 * signed-out visitor can reach.
 */

// Use the preinstalled Chromium when Playwright's own download isn't there.
const FALLBACK_CHROMIUM = "/opt/pw-browsers/chromium";
const launchOptions =
  !process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(FALLBACK_CHROMIUM)
    ? { executablePath: FALLBACK_CHROMIUM }
    : {};


export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    launchOptions,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions } }],
  webServer: [
    {
      command: `npx next start -p ${PORT}`,
      url: `http://localhost:${PORT}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ADMIN_PASSWORD: "", SESSION_SECRET: "" },
    },
    {
      command: `npx next start -p ${AUTH_PORT}`,
      url: `http://localhost:${AUTH_PORT}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ADMIN_PASSWORD: E2E_AUTH.password, SESSION_SECRET: E2E_AUTH.secret },
    },
  ],
});
