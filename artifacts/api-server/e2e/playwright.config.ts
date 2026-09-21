import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch:
    /(banned-room|key-reset-recovery|reconnect-delivery|idle-profile-registration|reduce-transparency-tab-bar)\.spec\.ts/,
  outputDir: "../test-results",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /global\.setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env["E2E_CHAT_URL"],
      },
      dependencies: ["setup"],
    },
  ],
});
