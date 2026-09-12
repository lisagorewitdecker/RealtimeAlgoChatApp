import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";
import { withClerkSetupRetry } from "./clerk-retry.js";

setup.describe.configure({ mode: "serial" });

setup("obtain a Clerk testing token", async () => {
  await withClerkSetupRetry(() => clerkSetup());
});