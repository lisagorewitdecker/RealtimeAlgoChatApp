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
import {
  throwTestAndCleanupFailures,
  withClerkRetry,
} from "./clerk-retry.js";

const chatUrl = process.env["E2E_CHAT_URL"];
const apiUrl = process.env["E2E_API_URL"];
const publishableKey = process.env["CLERK_PUBLISHABLE_KEY"];
const secretKey = process.env["CLERK_SECRET_KEY"];
const diagnosticContract =
  process.env["E2E_RECOVERY_DIAGNOSTIC_CONTRACT"] === "1";
const diagnosticCleanupOperation =
  process.env["E2E_RECOVERY_DIAGNOSTIC_CLEANUP"];
const diagnosticPhasesSucceed =
  process.env["E2E_RECOVERY_DIAGNOSTIC_PHASES_SUCCEED"] === "1";
const CONTEXT_CLEANUP_TIMEOUT_MS = diagnosticContract ? 250 : 5_000;
const EXTERNAL_CLEANUP_TIMEOUT_MS = diagnosticContract ? 250 : 10_000;

type DisposableUser = {
  id: string;
  email: string;
  password: string;
  token: string;
  username: string;
};

type SignedInPage = {
  context: BrowserContext;
  page: Page;
};

const PHASE_TIMEOUTS = {
  provisionUsers: 90_000,
  signInAndCreateRoom: 60_000,
  signInAndJoinRoom: 60_000,
  storeEncryptedHistory: 20_000,
  resetMemberKey: 60_000,
  recoverFreshEnvelope: 45_000,
  confirmDecryption: 20_000,
  confirmReloadPersistence: 30_000,
  confirmRoomReentry: 30_000,
} as const;

const RECOVERY_PHASE_NAMES = {
  signInAndCreateRoom: "sign in creator and create encrypted room",
  signInAndJoinRoom: "sign in member and receive initial room key",
  storeEncryptedHistory: "store encrypted history before key reset",
  resetMemberKey: "reset member device key in a second session",
  recoverFreshEnvelope: "recover a fresh room-key envelope after reset",
  confirmDecryption: "decrypt history and a new message with recovered key",
  confirmReloadPersistence: "reload room and reuse recovered key",
  confirmRoomReentry: "leave and reopen room with recovered key",
} as const;
type RecoveryPhaseName =
  (typeof RECOVERY_PHASE_NAMES)[keyof typeof RECOVERY_PHASE_NAMES];
const diagnosticPhaseNames = (
  process.env["E2E_RECOVERY_DIAGNOSTIC_PHASES"] ??
  Object.values(RECOVERY_PHASE_NAMES).join(",")
)
  .split(",")
  .map((phase) => phase.trim())
  .filter(Boolean);

async function withCleanupTimeout<T>(
  label: string,
  operation: PromiseLike<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function closeContextWithTimeout(
  context: BrowserContext,
  timeoutMs = CONTEXT_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  return withCleanupTimeout(
    "Browser context cleanup",
    context.close(),
    timeoutMs,
  );
}

async function createSignedInPage(
  browser: Browser,
  user: DisposableUser,
  contexts: BrowserContext[],
): Promise<SignedInPage> {
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
    diagnosticContract || !chatUrl || !apiUrl || !publishableKey || !secretKey,
    "E2E_CHAT_URL, E2E_API_URL, and Clerk development keys are required",
  );

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  let roomId = "";
  const roomName = `Key recovery ${suffix}`;

  const historyMessage = `Readable from before reset ${suffix}`;
  const postResetMessage = `Readable after reset ${suffix}`;
  const password = `E2e-${suffix}-Room!9`;
  const clerkClient = createClerkClient({ publishableKey, secretKey });
  const users: DisposableUser[] = [];
  const clerkUserIds: string[] = [];
  const contexts: BrowserContext[] = [];
  let testFailure: unknown;

  try {
    await test.step(
      "provision creator and member accounts",
      async () => {
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
            clerkClient.sessions.createSession({ userId: created.id }),
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
      },
      { timeout: PHASE_TIMEOUTS.provisionUsers },
    );

    let creator!: SignedInPage;
    await test.step(
      RECOVERY_PHASE_NAMES.signInAndCreateRoom,
      async () => {
        creator = await createSignedInPage(browser, users[0]!, contexts);
        await creator.page.getByTestId("new-room-button").click();
        await creator.page.getByTestId("room-name-input").fill(roomName);
        await Promise.all([
          creator.page.waitForURL(/\/room\/[^/?#]+/),
          creator.page.getByTestId("room-submit-button").click(),
        ]);
        roomId = decodeURIComponent(
          new URL(creator.page.url()).pathname
            .split("/")
            .filter(Boolean)
            .at(-1) ?? "",
        );
        expect(roomId).not.toBe("");
      },
      { timeout: PHASE_TIMEOUTS.signInAndCreateRoom },
    );

    let member!: SignedInPage;
    let originalEnvelope!: NonNullable<
      Awaited<ReturnType<typeof readMemberEnvelope>>
    >;
    await test.step(
      RECOVERY_PHASE_NAMES.signInAndJoinRoom,
      async () => {
        member = await createSignedInPage(browser, users[1]!, contexts);
        await roomJoinButton(member.page, roomName).click();
        await expect(
          creator.page.getByTestId("room-participant-count"),
        ).toHaveText("2 people");
        await expect(member.page.getByTestId("room-key-waiting")).toBeHidden();
        await expect
          .poll(() => readMemberEnvelope(roomId, users[1]!.id))
          .toBeTruthy();
        const envelope = await readMemberEnvelope(roomId, users[1]!.id);
        expect(envelope).toBeTruthy();
        originalEnvelope = envelope!;
      },
      { timeout: PHASE_TIMEOUTS.signInAndJoinRoom },
    );

    await test.step(
      RECOVERY_PHASE_NAMES.storeEncryptedHistory,
      async () => {
        await creator.page
          .getByTestId("room-composer-input")
          .fill(historyMessage);
        await creator.page.getByTestId("room-send-button").click();
        await expect(
          member.page.getByText(historyMessage, { exact: true }),
        ).toBeVisible();
      },
      { timeout: PHASE_TIMEOUTS.storeEncryptedHistory },
    );

    let resetSession!: SignedInPage;
    await test.step(
      RECOVERY_PHASE_NAMES.resetMemberKey,
      async () => {
        // Keep the first member session in the room so the reset session's
        // later join takes the explicit user-key-changed recovery path.
        resetSession = await createSignedInPage(
          browser,
          users[1]!,
          contexts,
        );
        await resetSession.page.getByRole("tab", { name: /Profile/ }).click();
        await expect(
          resetSession.page.getByTestId("device-key-status"),
        ).toHaveText("Replaced by another device or session");
        const fingerprint = resetSession.page.getByTestId(
          "device-key-fingerprint",
        );
        const originalFingerprint = await fingerprint.innerText();

        resetSession.page.once("dialog", (dialog) => dialog.accept());
        await resetSession.page.getByTestId("reset-device-key-button").click();
        await expect(
          resetSession.page.getByTestId("device-key-feedback"),
        ).toContainText("New device key created");
        await expect(fingerprint).not.toHaveText(originalFingerprint);
        await expect(
          resetSession.page.getByTestId("device-key-status"),
        ).toHaveText("Registered with your account");

        await resetSession.page.evaluate(
          ({ memberId, recoveredRoomId }) => {
            globalThis.localStorage.removeItem(
              `devstudio_roomkey:${memberId}:${recoveredRoomId}`,
            );
          },
          { memberId: users[1]!.id, recoveredRoomId: roomId },
        );
        await resetSession.page.reload();
        await expect(
          resetSession.page.getByTestId("device-key-status"),
        ).toHaveText("Registered with your account");
      },
      { timeout: PHASE_TIMEOUTS.resetMemberKey },
    );

    await test.step(
      RECOVERY_PHASE_NAMES.recoverFreshEnvelope,
      async () => {
        const recoveryRoomUrl = `${chatUrl}/room/${encodeURIComponent(roomId)}?roomName=${encodeURIComponent(roomName)}`;
        await resetSession.page.goto(recoveryRoomUrl);
        await expect(
          resetSession.page.getByTestId("room-key-waiting"),
        ).toBeHidden({ timeout: 15_000 });
        await expect(
          creator.page.getByTestId("room-participant-count"),
        ).toHaveText("2 people");
        await expect
          .poll(
            async () =>
              (await readMemberEnvelope(roomId, users[1]!.id))?.ciphertext,
          )
          .not.toBe(originalEnvelope.ciphertext);
      },
      { timeout: PHASE_TIMEOUTS.recoverFreshEnvelope },
    );

    await test.step(
      RECOVERY_PHASE_NAMES.confirmDecryption,
      async () => {
        await expect(
          resetSession.page.getByText(historyMessage, { exact: true }),
        ).toBeVisible();
        await expect(
          resetSession.page.getByText("Unable to decrypt this message."),
        ).toHaveCount(0);
        await creator.page
          .getByTestId("room-composer-input")
          .fill(postResetMessage);
        await creator.page.getByTestId("room-send-button").click();
        await expect(
          resetSession.page.getByText(postResetMessage, { exact: true }),
        ).toBeVisible();
        await expect(
          resetSession.page.getByText("Unable to decrypt this message."),
        ).toHaveCount(0);
      },
      { timeout: PHASE_TIMEOUTS.confirmDecryption },
    );

    await test.step(
      RECOVERY_PHASE_NAMES.confirmReloadPersistence,
      async () => {
        await resetSession.page.reload();
        await expect(
          resetSession.page.getByTestId("room-key-waiting"),
        ).toBeHidden({ timeout: 15_000 });
        await expect(
          resetSession.page.getByText(historyMessage, { exact: true }),
        ).toBeVisible();
        await expect(
          resetSession.page.getByText(postResetMessage, { exact: true }),
        ).toBeVisible();
        await expect(
          resetSession.page.getByText("Unable to decrypt this message."),
        ).toHaveCount(0);
      },
      { timeout: PHASE_TIMEOUTS.confirmReloadPersistence },
    );

    await test.step(
      RECOVERY_PHASE_NAMES.confirmRoomReentry,
      async () => {
        await resetSession.page.getByTestId("room-back-button").click();
        const recoveredRoomCard = roomJoinButton(resetSession.page, roomName);
        await expect(recoveredRoomCard).toBeVisible();
        await recoveredRoomCard.click();
        await expect(
          resetSession.page.getByTestId("room-key-waiting"),
        ).toBeHidden({ timeout: 15_000 });
        await expect(
          resetSession.page.getByText(historyMessage, { exact: true }),
        ).toBeVisible();
        await expect(
          resetSession.page.getByText(postResetMessage, { exact: true }),
        ).toBeVisible();
        await expect(
          resetSession.page.getByText("Unable to decrypt this message."),
        ).toHaveCount(0);
      },
      { timeout: PHASE_TIMEOUTS.confirmRoomReentry },
    );
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
      await Promise.allSettled(
        contexts.map((context) => closeContextWithTimeout(context)),
      ),
    );

    const databaseCleanup: Promise<unknown>[] = [];
    if (roomId) {
      databaseCleanup.push(
        withCleanupTimeout(
          "Recovery room-key envelope database cleanup",
          db
            .delete(roomKeyEnvelopesTable)
            .where(eq(roomKeyEnvelopesTable.roomId, roomId)),
          EXTERNAL_CLEANUP_TIMEOUT_MS,
        ),
      );
    }
    databaseCleanup.push(
      withCleanupTimeout(
        "Recovery room database cleanup",
        db
          .delete(roomsTable)
          .where(or(eq(roomsTable.id, roomId), eq(roomsTable.name, roomName))),
        EXTERNAL_CLEANUP_TIMEOUT_MS,
      ),
    );
    if (users.length > 0) {
      databaseCleanup.push(
        withCleanupTimeout(
          "Recovery user-profile database cleanup",
          db.delete(userProfilesTable).where(
            inArray(
              userProfilesTable.userId,
              users.map((user) => user.id),
            ),
          ),
          EXTERNAL_CLEANUP_TIMEOUT_MS,
        ),
      );
    }
    collectCleanupErrors(await Promise.allSettled(databaseCleanup));

    for (const userId of clerkUserIds) {
      try {
        await withCleanupTimeout(
          `Clerk user cleanup for ${userId}`,
          withClerkRetry(`delete user ${userId}`, () =>
            clerkClient.users.deleteUser(userId),
          ),
          EXTERNAL_CLEANUP_TIMEOUT_MS,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    collectCleanupErrors(
      await Promise.allSettled([
        withCleanupTimeout(
          "Recovery database pool shutdown",
          pool.end(),
          EXTERNAL_CLEANUP_TIMEOUT_MS,
        ),
      ]),
    );

    throwTestAndCleanupFailures(
      testFailure,
      cleanupErrors,
      "Key-reset recovery E2E cleanup failed",
      "Key-reset recovery verification and cleanup both failed",
    );
  }
});

const diagnosticActions: Record<
  RecoveryPhaseName,
  (page: Page) => Promise<void>
> = {
  [RECOVERY_PHASE_NAMES.signInAndCreateRoom]: async (page: Page) => {
    await page.route("**/*", () => new Promise<void>(() => {}));
    await page.goto("http://recovery-diagnostic.invalid/");
  },
  [RECOVERY_PHASE_NAMES.signInAndJoinRoom]: async (page: Page) => {
    await page.getByRole("button", { name: "Join diagnostic room" }).click();
  },
  [RECOVERY_PHASE_NAMES.storeEncryptedHistory]: async (page: Page) => {
    await page.getByTestId("room-composer-input").fill("diagnostic history");
  },
  [RECOVERY_PHASE_NAMES.resetMemberKey]: async (page: Page) => {
    await page.getByTestId("reset-device-key-button").click();
  },
  [RECOVERY_PHASE_NAMES.recoverFreshEnvelope]: async (page: Page) => {
    await page.route("**/*", () => new Promise<void>(() => {}));
    await page.goto("http://recovery-diagnostic.invalid/");
  },
  [RECOVERY_PHASE_NAMES.confirmDecryption]: async (page: Page) => {
    await page.getByTestId("room-composer-input").fill("diagnostic");
  },
  [RECOVERY_PHASE_NAMES.confirmReloadPersistence]: async (page: Page) => {
    let requestCount = 0;
    await page.route("http://recovery-diagnostic.invalid/", async (route) => {
      requestCount += 1;
      if (requestCount === 1) {
        await route.fulfill({ body: "recovery diagnostic" });
        return;
      }
      await new Promise<void>(() => {});
    });
    await page.goto("http://recovery-diagnostic.invalid/");
    await page.reload();
  },
  [RECOVERY_PHASE_NAMES.confirmRoomReentry]: async (page: Page) => {
    await page.getByTestId("room-back-button").click();
  },
};

test("reports stalled recovery phases", async ({ browser }) => {
  test.skip(!diagnosticContract, "Only run by the diagnostic contract test");
  test.setTimeout(10_000);

  let context: BrowserContext | undefined;
  const phaseFailures: unknown[] = [];
  try {
    context = await browser.newContext();
    for (const diagnosticPhaseName of diagnosticPhaseNames) {
      const diagnosticAction =
        diagnosticActions[diagnosticPhaseName as RecoveryPhaseName];
      expect(
        diagnosticAction,
        `Unknown recovery diagnostic phase: ${diagnosticPhaseName}`,
      ).toBeDefined();

      let page: Page | undefined;
      try {
        page = await context.newPage();
        await test.step(
          diagnosticPhaseName,
          () =>
            diagnosticPhasesSucceed
              ? Promise.resolve()
              : diagnosticAction!(page!),
          { timeout: 250 },
        );
        if (diagnosticPhasesSucceed) {
          console.info(
            `[key-reset-recovery-e2e] diagnostic phase completed: ${diagnosticPhaseName}`,
          );
        }
      } catch (error) {
        phaseFailures.push(
          new AggregateError(
            [error],
            `Recovery diagnostic phase failed: ${diagnosticPhaseName}`,
          ),
        );
      } finally {
        await page?.close();
      }
    }
  } finally {
    console.info("[key-reset-recovery-e2e] diagnostic cleanup executed");
    const cleanupErrors: unknown[] = [];
    if (context) {
      if (diagnosticCleanupOperation === "browser") {
        const realClose = context.close.bind(context);
        context.close = () => new Promise<void>(() => {});
        const result = await Promise.allSettled([
          closeContextWithTimeout(context),
        ]);
        if (result[0]?.status === "rejected") {
          cleanupErrors.push(result[0].reason);
        }
        context.close = realClose;
      }
      await context.close();
    }
    if (diagnosticCleanupOperation === "database") {
      const result = await Promise.allSettled([
        withCleanupTimeout(
          "Recovery room database cleanup",
          new Promise<void>(() => {}),
          EXTERNAL_CLEANUP_TIMEOUT_MS,
        ),
      ]);
      if (result[0]?.status === "rejected") {
        cleanupErrors.push(result[0].reason);
      }
    }
    if (diagnosticCleanupOperation === "clerk-user") {
      const result = await Promise.allSettled([
        withCleanupTimeout(
          "Clerk user cleanup for diagnostic-user",
          new Promise<void>(() => {}),
          EXTERNAL_CLEANUP_TIMEOUT_MS,
        ),
      ]);
      if (result[0]?.status === "rejected") {
        cleanupErrors.push(result[0].reason);
      }
    }
    if (diagnosticCleanupOperation === "pool") {
      const result = await Promise.allSettled([
        withCleanupTimeout(
          "Recovery database pool shutdown",
          new Promise<void>(() => {}),
          EXTERNAL_CLEANUP_TIMEOUT_MS,
        ),
      ]);
      if (result[0]?.status === "rejected") {
        cleanupErrors.push(result[0].reason);
      }
    }
    const testFailure =
      phaseFailures.length > 0
        ? new AggregateError(
            phaseFailures,
            "Recovery diagnostic phases failed",
          )
        : undefined;
    throwTestAndCleanupFailures(
      testFailure,
      cleanupErrors,
      "Key-reset recovery E2E cleanup failed",
      "Key-reset recovery verification and cleanup both failed",
    );
  }
});
