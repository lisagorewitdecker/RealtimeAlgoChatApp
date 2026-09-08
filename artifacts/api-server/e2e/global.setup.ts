import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

setup.describe.configure({ mode: "serial" });

setup("obtain a Clerk testing token", async () => {
  await clerkSetup();
});