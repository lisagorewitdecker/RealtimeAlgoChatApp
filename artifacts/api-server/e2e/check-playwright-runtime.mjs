import { chromium } from "@playwright/test";

const setupMessage =
  "Chromium is not ready for API tests. Run the test command from a Replit environment with the Chromium runtime packages declared in .replit, then retry.";

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (error) {
  console.error(`[api-server browser setup] ${setupMessage}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
}