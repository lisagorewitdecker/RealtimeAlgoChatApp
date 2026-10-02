import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";
import { withClerkSetupRetry } from "./clerk-retry.js";

setup.describe.configure({ mode: "serial" });

setup("obtain a Clerk testing token", async () => {
  setup.setTimeout(45_000);
  setup.skip(
    process.env["E2E_RECOVERY_DIAGNOSTIC_CONTRACT"] === "1",
    "The recovery diagnostic contract does not use Clerk",
  );
  await withClerkSetupRetry(() => clerkSetup());
});
