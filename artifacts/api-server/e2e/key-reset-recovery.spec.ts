import { createClerkClient } from "@clerk/backend";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  db,
  pool,
  roomsTable,
  roomKeyEnvelopesTable,
  userProfilesTable,
} from "@workspace/db";
import { and, eq, inArray, or } from "drizzle-orm";

const chatUrl = process.env["E2E_CHAT_URL"];
const apiUrl = process.env["E2E_API_URL"];
const publishableKey = process.env["CLERK_PUBLISHABLE_KEY"];
const secretKey = process.env["CLERK_SECRET_KEY"];

type DisposableUser = {
  id: string;
  email: string;
  password: string;
  token: string;
  username: string;
};

async function createSignedInPage(
  browser: Browser,
  user: DisposableUser,
  contexts: BrowserContext[],
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  contexts.push(context);
  await setupClerkTestingToken({ context });
  const page = await context.newPage();
  await page.goto(chatUrl!);
  await page.getByPlaceholder("Email address").fill(user.email);
  await page.getByPlaceholder("Password").fill(user.password);
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
    await setupName.fill(user.username);
    await page.getByText("Enter workspace", { exact: true }).click();
  }
  await roomList.waitFor({ state: "visible" });
  return { context, page };
}

function roomJoinButton(page: Page, roomName: string) {
  const escapedName = roomName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", {
    name: new RegExp(`^Join ${escapedName}, \\d+ online$`),
  });
}

function clerkErrorStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return typeof candidate.status === "number"
    ? candidate.status
    : typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : undefined;
}

async function withClerkRetry<T>(
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = clerkErrorStatus(error);
      const retryable =
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504;
      if (!retryable || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function deleteClerkUserWithRetry(
  clerkClient: ReturnType<typeof createClerkClient>,
  userId: string,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await clerkClient.users.deleteUser(userId);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function readMemberEnvelope(roomId: string, userId: string) {
  const [envelope] = await db
    .select({
      ciphertext: roomKeyEnvelopesTable.ciphertext,
      senderPublicKey: roomKeyEnvelopesTable.senderPublicKey,
    })
    .from(roomKeyEnvelopesTable)
    .where(
      and(
        eq(roomKeyEnvelopesTable.roomId, roomId),
        eq(roomKeyEnvelopesTable.userId, userId),
      ),
    );
  return envelope;
}

test("a member recovers a live encrypted room after resetting their device key", async ({
  browser,
}) => {
  // Two independent Clerk sign-ins plus Expo's cold browser bundle can take
  // longer than the banned-room path before the recovery assertions begin.
  test.setTimeout(270_000);
  test.skip(
    !chatUrl || !apiUrl || !publishableKey || !secretKey,
    "E2E_CHAT_URL, E2E_API_URL, and Clerk development keys are required",
  );

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  let roomId = "";
  const roomName = `Key recovery ${suffix}`;
  const message = `Readable after reset ${suffix}`;
  const password = `E2e-${suffix}-Room!9`;
  const clerkClient = createClerkClient({ publishableKey, secretKey });
  const users: DisposableUser[] = [];
  const clerkUserIds: string[] = [];
  const contexts: BrowserContext[] = [];
  let testFailure: unknown;

  try {
    console.info("[key-reset-recovery-e2e] provisioning users");
    for (const role of ["creator", "member"] as const) {
      const email = `key-reset-${role}-${suffix}+clerk_test@example.com`;
      const username =
        role === "creator" ? `Creator ${suffix}` : `Member ${suffix}`;
      const created = await withClerkRetry(`create ${role} user`, () =>
        clerkClient.users.createUser({
          emailAddress: [email],
          password,
          firstName: role === "creator" ? "Creator" : "Member",
          lastName: "E2E",
          skipLegalChecks: true,
          privateMetadata: { purpose: "key-reset-recovery-e2e" },
        }),
      );
      clerkUserIds.push(created.id);
      const apiSession = await withClerkRetry(`create ${role} session`, () =>
        clerkClient.sessions.createSession({
          userId: created.id,
        }),
      );
      const token = await withClerkRetry(`mint ${role} token`, () =>
        clerkClient.sessions.getToken(apiSession.id, undefined, 300),
      );
      users.push({
        id: created.id,
        email,
        password,
        token: token.jwt,
        username,
      });
    }

    console.info("[key-reset-recovery-e2e] creating encrypted room");
    const creator = await createSignedInPage(browser, users[0]!, contexts);
    await creator.page.getByTestId("new-room-button").click();
    await creator.page.getByTestId("room-name-input").fill(roomName);
    await Promise.all([
      creator.page.waitForURL(/\/room\/[^/?#]+/),
      creator.page.getByTestId("room-submit-button").click(),
    ]);
    roomId = decodeURIComponent(
      new URL(creator.page.url()).pathname.split("/").filter(Boolean).at(-1) ??
        "",
    );
    expect(roomId).not.toBe("");

    console.info("[key-reset-recovery-e2e] joining member");
    const member = await createSignedInPage(browser, users[1]!, contexts);
    await roomJoinButton(member.page, roomName).click();
    await expect(creator.page.getByTestId("room-participant-count")).toHaveText(
      "2 people",
    );
    await expect(member.page.getByTestId("room-key-waiting")).toBeHidden();

    await expect
      .poll(() => readMemberEnvelope(roomId, users[1]!.id))
      .toBeTruthy();
    const originalEnvelope = await readMemberEnvelope(roomId, users[1]!.id);
    expect(originalEnvelope).toBeTruthy();

    console.info(
      "[key-reset-recovery-e2e] resetting member key from a second session",
    );
    // Keep the first member session in the room. The server must retain this
    // account's presence, so the reset session's later join produces the
    // explicit user-key-changed path rather than a user-left/user-joined pair.
    const resetSession = await createSignedInPage(
      browser,
      users[1]!,
      contexts,
    );
    await resetSession.page.getByRole("tab", { name: /Profile/ }).click();
    await expect(resetSession.page.getByTestId("device-key-status")).toHaveText(
      "Replaced by another device or session",
    );
    const fingerprint = resetSession.page.getByTestId(
      "device-key-fingerprint",
    );
    const originalFingerprint = await fingerprint.innerText();

    resetSession.page.once("dialog", (dialog) => dialog.accept());
    await resetSession.page.getByTestId("reset-device-key-button").click();
    await expect(
      resetSession.page.getByTestId("device-key-feedback"),
    ).toContainText(
      "New device key created",
    );
    await expect(fingerprint).not.toHaveText(originalFingerprint);
    await expect(resetSession.page.getByTestId("device-key-status")).toHaveText(
      "Registered with your account",
    );

    // Remove any room key inherited through browser state and reload to clear
    // the provider's in-memory copy. Recovery must depend on a fresh envelope
    // encrypted to the replacement device identity.
    await resetSession.page.evaluate(
      ({ memberId, recoveredRoomId }) => {
        globalThis.localStorage.removeItem(
          `devstudio_roomkey:${memberId}:${recoveredRoomId}`,
        );
      },
      { memberId: users[1]!.id, recoveredRoomId: roomId },
    );
    await resetSession.page.reload();
    await expect(resetSession.page.getByTestId("device-key-status")).toHaveText(
      "Registered with your account",
    );

    console.info("[key-reset-recovery-e2e] waiting for a fresh envelope");
    const recoveryRoomUrl = `${chatUrl}/room/${encodeURIComponent(roomId)}?roomName=${encodeURIComponent(roomName)}`;
    await resetSession.page.goto(recoveryRoomUrl);
    await expect(resetSession.page.getByTestId("room-key-waiting")).toBeHidden({
      timeout: 15_000,
    });
    await expect(creator.page.getByTestId("room-participant-count")).toHaveText(
      "2 people",
    );

    await expect
      .poll(
        async () =>
          (await readMemberEnvelope(roomId, users[1]!.id))?.ciphertext,
      )
      .not.toBe(originalEnvelope!.ciphertext);

    console.info("[key-reset-recovery-e2e] confirming message decryption");
    await creator.page.getByTestId("room-composer-input").fill(message);
    await creator.page.getByTestId("room-send-button").click();
    await expect(
      resetSession.page.getByText(message, { exact: true }),
    ).toBeVisible();
    await expect(
      resetSession.page.getByText("Unable to decrypt this message."),
    ).toHaveCount(0);
  } catch (error) {
    testFailure = error;
  } finally {
    console.info("[key-reset-recovery-e2e] cleaning up");
    const cleanupErrors: unknown[] = [];
    const collectCleanupErrors = (results: PromiseSettledResult<unknown>[]) => {
      for (const result of results) {
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      }
    };

    collectCleanupErrors(
      await Promise.allSettled(contexts.map((context) => context.close())),
    );

    const databaseCleanup: Promise<unknown>[] = [];
    if (roomId) {
      databaseCleanup.push(
        db
          .delete(roomKeyEnvelopesTable)
          .where(eq(roomKeyEnvelopesTable.roomId, roomId)),
      );
    }
    databaseCleanup.push(
      db
        .delete(roomsTable)
        .where(or(eq(roomsTable.id, roomId), eq(roomsTable.name, roomName))),
    );
    if (users.length > 0) {
      databaseCleanup.push(
        db.delete(userProfilesTable).where(
          inArray(
            userProfilesTable.userId,
            users.map((user) => user.id),
          ),
        ),
      );
    }
    collectCleanupErrors(await Promise.allSettled(databaseCleanup));

    for (const userId of clerkUserIds) {
      try {
        await deleteClerkUserWithRetry(clerkClient, userId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    collectCleanupErrors(await Promise.allSettled([pool.end()]));

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        testFailure === undefined
          ? cleanupErrors
          : [testFailure, ...cleanupErrors],
        testFailure === undefined
          ? "Key-reset recovery E2E cleanup failed"
          : "Key-reset recovery verification and cleanup both failed",
      );
    }
  }

  if (testFailure !== undefined) throw testFailure;
});
