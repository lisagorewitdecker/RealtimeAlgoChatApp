import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch:
    /(banned-room|key-reset-recovery|reconnect-delivery|idle-profile-registration)\.spec\.ts/,
  outputDir: "../test-results",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
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
