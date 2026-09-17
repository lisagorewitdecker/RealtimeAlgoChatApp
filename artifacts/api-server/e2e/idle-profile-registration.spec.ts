import { expect, test, type BrowserContext } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  throwTestAndCleanupFailures,
  withClerkRetry,
} from "./clerk-retry.js";

const chatUrl = process.env["E2E_CHAT_URL"];
const apiUrl = process.env["E2E_API_URL"];
const publishableKey = process.env["CLERK_PUBLISHABLE_KEY"];
const secretKey = process.env["CLERK_SECRET_KEY"];

function isProfilePut(request: { method(): string; url(): string }) {
  return (
    request.method() === "PUT" &&
    new URL(request.url()).pathname === "/api/profile"
  );
}

function isPublicKeyRegistration(request: {
  method(): string;
  url(): string;
  postDataJSON(): unknown;
}) {
  if (!isProfilePut(request)) return false;
  try {
    const body = request.postDataJSON();
    return (
      typeof body === "object" &&
      body !== null &&
      typeof (body as { publicKey?: unknown }).publicKey === "string"
    );
  } catch {
    return false;
  }
}

test("an idle signed-in client registers its public key only once across token refresh", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const controlledFailure = process.env["TASK_264_CONTROLLED_FAILURE"] === "true";
  test.skip(
    !controlledFailure && (!chatUrl || !apiUrl || !publishableKey || !secretKey),
    "E2E_CHAT_URL, E2E_API_URL, and Clerk development keys are required",
  );

  if (controlledFailure) {
    const page = await browser.newPage();
    await page.setContent(
      "<main><h1>Controlled browser evidence fixture</h1><p>Release evidence capture is active.</p></main>",
    );
    await expect(page.getByRole("heading", { name: "Controlled browser evidence fixture" })).toHaveText(
      "Expected release success marker",
    );
    return;
  }

  const { createClerkClient } = await import("@clerk/backend");
  const { setupClerkTestingToken } = await import("@clerk/testing/playwright");
  const { db, pool, userProfilesTable } = await import("@workspace/db");

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const email = `idle-profile-${suffix}+clerk_test@example.com`;
  const password = `E2e-${suffix}-Idle!9`;
  const clerkClient = createClerkClient({ publishableKey, secretKey });
  let userId = "";
  let context: BrowserContext | undefined;
  let testFailure: unknown;

  try {
    const user = await withClerkRetry("create idle profile user", () =>
      clerkClient.users.createUser({
        emailAddress: [email],
        password,
        firstName: "Idle",
        lastName: "Profile",
        skipLegalChecks: true,
        privateMetadata: { purpose: "idle-profile-registration-e2e" },
      }),
    );
    userId = user.id;

    context = await browser.newContext();
    await setupClerkTestingToken({ context });
    const page = await context.newPage();
    const profilePuts: string[] = [];
    const registrations: string[] = [];
    page.on("response", (response) => {
      const request = response.request();
      if (isProfilePut(request)) {
        profilePuts.push(`${response.status()} ${request.postData() ?? ""}`);
      }
      if (isPublicKeyRegistration(request)) {
        registrations.push(`${response.status()} ${request.postData() ?? ""}`);
      }
    });

    await page.goto(chatUrl!);
    await page.getByPlaceholder("Email address").fill(email);
    await page.getByPlaceholder("Password").fill(password);
    await page.getByText("Sign in", { exact: true }).click();

    const verificationCode = page.getByPlaceholder("6-digit code");
    const setupName = page.getByPlaceholder("How should your team know you?");
    const roomList = page.getByTestId("new-room-button");
    await Promise.race([
      verificationCode.waitFor({ state: "visible" }),
      setupName.waitFor({ state: "visible" }),
      roomList.waitFor({ state: "visible" }),
    ]);
    if (await verificationCode.isVisible()) {
      await verificationCode.fill("424242");
      await page.getByText("Verify", { exact: true }).click();
      await Promise.race([
        setupName.waitFor({ state: "visible" }),
        roomList.waitFor({ state: "visible" }),
      ]);
    }
    if (await setupName.isVisible()) {
      await setupName.fill(`Idle ${suffix}`);
      await page.getByText("Enter workspace", { exact: true }).click();
    }
    await roomList.waitFor({ state: "visible" });

    if (process.env.FORCE_BROWSER_EVIDENCE_FAILURE === "1") {
      // Temporary assertion used to verify release browser evidence upload.
      expect("controlled-browser-evidence-failure").toBe("release-ready");
    }
    await expect.poll(() => registrations.length).toBe(1);
    await page.waitForTimeout(2_000);
    const profilePutCountBeforeIdle = profilePuts.length;

    // Clerk refreshes short-lived session tokens on roughly a one-minute
    // cadence. Stay completely idle beyond that boundary so a getToken
    // reference update would reproduce periodic registration traffic.
    await page.waitForTimeout(75_000);
    expect(registrations).toHaveLength(1);
    expect(profilePuts).toHaveLength(profilePutCountBeforeIdle);
  } catch (error) {
    testFailure = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (context) {
      await context.close().catch((error) => cleanupErrors.push(error));
    }
    if (userId) {
      await db
        .delete(userProfilesTable)
        .where(eq(userProfilesTable.userId, userId))
        .catch((error) => cleanupErrors.push(error));
      await withClerkRetry("delete idle profile user", () =>
        clerkClient.users.deleteUser(userId),
      )
        .catch((error) => cleanupErrors.push(error));
    }
    await pool.end().catch((error) => cleanupErrors.push(error));
    throwTestAndCleanupFailures(
      testFailure,
      cleanupErrors,
      "Idle profile E2E cleanup failed",
      "Idle profile verification and cleanup both failed",
    );
  }
});
