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

function roomParticipantCount(page: Page) {
  return page.getByTestId("room-participant-count");
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
      const delayMs = 1_000 * 2 ** attempt;
      console.info(
        `[banned-room-e2e] ${phase} returned ${status}; retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
      await new Promise((resolve) =>
        setTimeout(resolve, 1_000 * 2 ** attempt),
      );
    }
  }
  throw lastError;
}

test("an active banned member sees the explanation and sees it again on revisit", async ({
  browser,
}) => {
  test.setTimeout(180_000);
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
      const created = await withClerkRetry(`create ${role} user`, () =>
        clerkClient.users.createUser({
          emailAddress: [email],
          password,
          firstName: role === "owner" ? "Owner" : "Member",
          lastName: "E2E",
          skipLegalChecks: true,
          privateMetadata: { purpose: "banned-room-e2e" },
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

    const owner = await createSignedInPage(browser, users[0]!, contexts);

    await owner.page.getByTestId("new-room-button").click();
    await owner.page.getByTestId("room-name-input").fill(roomName);
    await Promise.all([
      owner.page.waitForURL(/\/room\/[^/?#]+/),
      owner.page.getByTestId("room-submit-button").click(),
    ]);
    roomId = decodeURIComponent(
      new URL(owner.page.url()).pathname.split("/").filter(Boolean).at(-1) ?? "",
    );
    expect(roomId).not.toBe("");
    await expect(roomParticipantCount(owner.page)).toHaveText("1 person");

    const member = await createSignedInPage(browser, users[1]!, contexts);

    await expect(roomJoinButton(member.page, roomName)).toBeVisible();
    await roomJoinButton(member.page, roomName).click();
    await expect(roomParticipantCount(owner.page)).toHaveText("2 people");

    await owner.page.getByTestId("room-users-button").click();
    const banButton = owner.page.getByRole("button", {
      name: /^Ban .+ from this room$/,
    });
    await expect(banButton).toBeVisible();
    owner.page.once("dialog", (dialog) => dialog.accept());
    await banButton.click();

    await expect(
      owner.page.getByText("Room moderator controls", { exact: true }),
    ).toBeVisible(
    );

    await expect(roomParticipantCount(owner.page)).toHaveText("1 person");
    await expect(owner.page.getByTestId("banned-room")).toHaveCount(0);

    await expect(member.page.getByTestId("banned-room")).toBeVisible();
    await expect(
      member.page.getByText("Banned from room", { exact: true }),
    ).toBeVisible();
    await expect(
      member.page.getByText("A room moderator has banned you from this room.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(roomParticipantCount(member.page)).toHaveCount(0);

    await member.page.getByText("Return to room list", { exact: true }).click();
    await expect(member.page).not.toHaveURL(new RegExp(`/room/${roomId}`));

    const visibleRoomCard = roomJoinButton(member.page, roomName);
    await expect(visibleRoomCard).toBeVisible();
    await visibleRoomCard.click();
    await expect(member.page.getByTestId("banned-room")).toBeVisible();
    await expect(
      member.page.getByText("Banned from room", { exact: true }),
    ).toBeVisible();
    await expect(
      member.page.getByText("A room moderator has banned you from this room.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(roomParticipantCount(member.page)).toHaveCount(0);
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
      await Promise.allSettled(contexts.map((context) => context.close())),
    );

    const databaseCleanup: Promise<unknown>[] = [
      db
        .delete(roomsTable)
        .where(
          or(eq(roomsTable.id, roomId), eq(roomsTable.name, roomName)),
        ),
    ];
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
          ? "Banned-room E2E cleanup failed"
          : "Banned-room verification and cleanup both failed",
      );
    }
  }

  if (testFailure !== undefined) throw testFailure;
});
