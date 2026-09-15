import { createClerkClient } from "@clerk/backend";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { db, pool, roomsTable, userProfilesTable } from "@workspace/db";
import { eq, inArray, or } from "drizzle-orm";
import {
  throwTestAndCleanupFailures,
  withTimeout,
  withClerkRetry,
} from "./clerk-retry.js";

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

const PHASE_TIMEOUTS = {
  authentication: 30_000,
  navigation: 20_000,
  roomState: 15_000,
  clerk: 20_000,
  cleanup: 15_000,
} as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runPhase<T>(
  phase: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await test.step(phase, () =>
      withTimeout(`[banned-room-e2e] ${phase}`, operation(), timeoutMs),
    );
  } catch (error) {
    throw new Error(
      `[banned-room-e2e] ${phase} failed: ${errorText(error)}`,
      { cause: error },
    );
  }
}

async function waitForAuthDestination(
  verificationCode: ReturnType<Page["getByPlaceholder"]>,
  setupName: ReturnType<Page["getByPlaceholder"]>,
  roomList: ReturnType<Page["getByTestId"]>,
): Promise<void> {
  await Promise.any([
    verificationCode.waitFor({
      state: "visible",
      timeout: PHASE_TIMEOUTS.authentication,
    }),
    setupName.waitFor({
      state: "visible",
      timeout: PHASE_TIMEOUTS.authentication,
    }),
    roomList.waitFor({
      state: "visible",
      timeout: PHASE_TIMEOUTS.authentication,
    }),
  ]).catch(() => {
    throw new Error(
      "authentication did not reach verification, profile setup, or room list",
    );
  });
}

async function createSignedInPage(
  browser: Browser,
  user: DisposableUser,
  contexts: BrowserContext[],
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await runPhase(
    "authentication: create browser context",
    PHASE_TIMEOUTS.authentication,
    () => browser.newContext(),
  );
  contexts.push(context);
  await runPhase(
    "authentication: install Clerk testing token",
    PHASE_TIMEOUTS.authentication,
    () => setupClerkTestingToken({ context }),
  );
  const page = await runPhase(
    "authentication: create page",
    PHASE_TIMEOUTS.authentication,
    () => context.newPage(),
  );
  await runPhase(
    "navigation: load sign-in page",
    PHASE_TIMEOUTS.navigation,
    () =>
      page.goto(chatUrl!, {
        timeout: PHASE_TIMEOUTS.navigation,
        waitUntil: "domcontentloaded",
      }),
  );
  await runPhase(
    "authentication: submit credentials",
    PHASE_TIMEOUTS.authentication,
    async () => {
      await page.getByPlaceholder("Email address").fill(user.email);
      await page.getByPlaceholder("Password").fill(user.password);
      await page.getByText("Sign in", { exact: true }).click();
    },
  );
  const verificationCode = page.getByPlaceholder("6-digit code");
  const setupName = page.getByPlaceholder("How should your team know you?");
  const roomList = page.getByTestId("new-room-button");
  await runPhase(
    "authentication: wait for signed-in destination",
    PHASE_TIMEOUTS.authentication,
    () => waitForAuthDestination(verificationCode, setupName, roomList),
  );
  if (await verificationCode.isVisible()) {
    await runPhase(
      "authentication: verify development account",
      PHASE_TIMEOUTS.authentication,
      async () => {
        await verificationCode.fill("424242");
        await page.getByText("Verify", { exact: true }).click();
      },
    );
    await runPhase(
      "authentication: wait after verification",
      PHASE_TIMEOUTS.authentication,
      () =>
        waitForAuthDestination(
          verificationCode,
          setupName,
          roomList,
        ),
    );
  }
  if (await setupName.isVisible()) {
    await runPhase(
      "authentication: complete profile setup",
      PHASE_TIMEOUTS.authentication,
      async () => {
        await setupName.fill(user.username);
        await page.getByText("Enter workspace", { exact: true }).click();
      },
    );
  }
  await runPhase(
    "authentication: confirm room list",
    PHASE_TIMEOUTS.authentication,
    () =>
      roomList.waitFor({
        state: "visible",
        timeout: PHASE_TIMEOUTS.authentication,
      }),
  );
  return { context, page };
}

function roomJoinButton(page: Page, roomName: string) {
  const escapedName = roomName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", {
    name: new RegExp(`^Join ${escapedName}, \\d+ online$`),
  });
}

function roomParticipantCount(page: Page) {
  return page.getByTestId("room-participant-count");
}

test("an active banned member sees the explanation and sees it again on revisit", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  test.skip(
    !chatUrl || !apiUrl || !publishableKey || !secretKey,
    "E2E_CHAT_URL, E2E_API_URL, and Clerk development keys are required",
  );

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  let roomId = "";
  const roomName = `Ban verification ${suffix}`;
  const password = `E2e-${suffix}-Room!9`;
  const clerkClient = createClerkClient({ publishableKey, secretKey });
  const users: DisposableUser[] = [];
  const clerkUserIds: string[] = [];
  const contexts: BrowserContext[] = [];
  let testFailure: unknown;

  try {
    for (const role of ["owner", "member"] as const) {
      const email = `room-ban-${role}-${suffix}+clerk_test@example.com`;
      const username =
        role === "owner" ? `Owner ${suffix}` : `Member ${suffix}`;
      const created = await runPhase(
        `authentication: create ${role} user`,
        PHASE_TIMEOUTS.clerk,
        () =>
          withClerkRetry(`create ${role} user`, () =>
            clerkClient.users.createUser({
              emailAddress: [email],
              password,
              firstName: role === "owner" ? "Owner" : "Member",
              lastName: "E2E",
              skipLegalChecks: true,
              privateMetadata: { purpose: "banned-room-e2e" },
            }),
          ),
      );
      clerkUserIds.push(created.id);
      const apiSession = await runPhase(
        `authentication: create ${role} session`,
        PHASE_TIMEOUTS.clerk,
        () =>
          withClerkRetry(`create ${role} session`, () =>
            clerkClient.sessions.createSession({
              userId: created.id,
            }),
          ),
      );
      const token = await runPhase(
        `authentication: mint ${role} token`,
        PHASE_TIMEOUTS.clerk,
        () =>
          withClerkRetry(`mint ${role} token`, () =>
            clerkClient.sessions.getToken(apiSession.id, undefined, 300),
          ),
      );
      users.push({
        id: created.id,
        email,
        password,
        token: token.jwt,
        username,
      });
    }

    const owner = await createSignedInPage(browser, users[0]!, contexts);

    await runPhase(
      "navigation: owner creates room",
      PHASE_TIMEOUTS.navigation,
      async () => {
        await owner.page.getByTestId("new-room-button").click();
        await owner.page.getByTestId("room-name-input").fill(roomName);
        await Promise.all([
          owner.page.waitForURL(/\/room\/[^/?#]+/, {
            timeout: PHASE_TIMEOUTS.navigation,
          }),
          owner.page.getByTestId("room-submit-button").click(),
        ]);
      },
    );
    roomId = decodeURIComponent(
      new URL(owner.page.url()).pathname.split("/").filter(Boolean).at(-1) ?? "",
    );
    expect(roomId).not.toBe("");
    await runPhase(
      "room state: owner enters the new room",
      PHASE_TIMEOUTS.roomState,
      () => expect(roomParticipantCount(owner.page)).toHaveText("1 person"),
    );

    const member = await createSignedInPage(browser, users[1]!, contexts);

    await runPhase(
      "navigation: member joins the room",
      PHASE_TIMEOUTS.navigation,
      async () => {
        await expect(roomJoinButton(member.page, roomName)).toBeVisible();
        await roomJoinButton(member.page, roomName).click();
      },
    );
    await runPhase(
      "room state: both members are present",
      PHASE_TIMEOUTS.roomState,
      () => expect(roomParticipantCount(owner.page)).toHaveText("2 people"),
    );

    await runPhase(
      "room state: owner bans the member",
      PHASE_TIMEOUTS.roomState,
      async () => {
        await owner.page.getByTestId("room-users-button").click();
        const banButton = owner.page.getByRole("button", {
          name: /^Ban .+ from this room$/,
        });
        await expect(banButton).toBeVisible();
        owner.page.once("dialog", (dialog) => dialog.accept());
        await banButton.click();
      },
    );

    await runPhase(
      "room state: owner remains moderator",
      PHASE_TIMEOUTS.roomState,
      () =>
        expect(
          owner.page.getByText("Room moderator controls", { exact: true }),
        ).toBeVisible(),
    );

    await runPhase(
      "room state: banned member leaves the owner room",
      PHASE_TIMEOUTS.roomState,
      async () => {
        await expect(roomParticipantCount(owner.page)).toHaveText("1 person");
        await expect(owner.page.getByTestId("banned-room")).toHaveCount(0);
      },
    );

    await runPhase(
      "room state: banned member sees the explanation",
      PHASE_TIMEOUTS.roomState,
      async () => {
        await expect(member.page.getByTestId("banned-room")).toBeVisible();
        await expect(
          member.page.getByText("Banned from room", { exact: true }),
        ).toBeVisible();
        await expect(
          member.page.getByText(
            "A room moderator has banned you from this room.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(roomParticipantCount(member.page)).toHaveCount(0);
      },
    );

    await runPhase(
      "navigation: banned member returns to room list",
      PHASE_TIMEOUTS.navigation,
      async () => {
        await member.page
          .getByText("Return to room list", { exact: true })
          .click();
        await expect(member.page).not.toHaveURL(new RegExp(`/room/${roomId}`));
      },
    );

    await runPhase(
      "navigation: banned member revisits the room",
      PHASE_TIMEOUTS.navigation,
      async () => {
        const visibleRoomCard = roomJoinButton(member.page, roomName);
        await expect(visibleRoomCard).toBeVisible();
        await visibleRoomCard.click();
      },
    );
    await runPhase(
      "room state: banned explanation persists on revisit",
      PHASE_TIMEOUTS.roomState,
      async () => {
        await expect(member.page.getByTestId("banned-room")).toBeVisible();
        await expect(
          member.page.getByText("Banned from room", { exact: true }),
        ).toBeVisible();
        await expect(
          member.page.getByText(
            "A room moderator has banned you from this room.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(roomParticipantCount(member.page)).toHaveCount(0);
      },
    );
  } catch (error) {
    testFailure = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    const collectCleanupErrors = (
      results: PromiseSettledResult<unknown>[],
    ) => {
      for (const result of results) {
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      }
    };

    collectCleanupErrors(
      await Promise.allSettled(
        contexts.map((context, index) =>
          withTimeout(
            `browser context ${index + 1} cleanup`,
            context.close(),
            PHASE_TIMEOUTS.cleanup,
          ),
        ),
      ),
    );

    const databaseCleanup: Promise<unknown>[] = [
      withTimeout(
        "room database cleanup",
        db.delete(roomsTable).where(
          or(eq(roomsTable.id, roomId), eq(roomsTable.name, roomName)),
        ),
        PHASE_TIMEOUTS.cleanup,
      ),
    ];
    if (users.length > 0) {
      databaseCleanup.push(
        withTimeout(
          "user profile database cleanup",
          db.delete(userProfilesTable).where(
            inArray(
              userProfilesTable.userId,
              users.map((user) => user.id),
            ),
          ),
          PHASE_TIMEOUTS.cleanup,
        ),
      );
    }
    collectCleanupErrors(await Promise.allSettled(databaseCleanup));

    collectCleanupErrors(
      await Promise.allSettled(
        clerkUserIds.map((userId) =>
          withTimeout(
            `Clerk user cleanup for ${userId}`,
            withClerkRetry(`delete user ${userId}`, () =>
              clerkClient.users.deleteUser(userId),
            ),
            PHASE_TIMEOUTS.cleanup,
          ),
        ),
      ),
    );
    collectCleanupErrors(
      await Promise.allSettled([
        withTimeout("database pool cleanup", pool.end(), PHASE_TIMEOUTS.cleanup),
      ]),
    );

    throwTestAndCleanupFailures(
      testFailure,
      cleanupErrors,
      "Banned-room E2E cleanup failed",
      "Banned-room verification and cleanup both failed",
    );
  }
});
