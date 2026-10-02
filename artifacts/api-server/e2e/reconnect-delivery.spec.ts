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
  withClerkRetry,
} from "./clerk-retry.js";
import { ROOM_MESSAGE_HISTORY_LIMIT } from "../src/lib/roomLimits.js";

const chatUrl = process.env["E2E_CHAT_URL"];
const apiUrl = process.env["E2E_API_URL"];
const publishableKey = process.env["CLERK_PUBLISHABLE_KEY"];
const secretKey = process.env["CLERK_SECRET_KEY"];

type DisposableUser = {
  id: string;
  email: string;
  password: string;
  username: string;
};

type SignedInPage = {
  context: BrowserContext;
  page: Page;
  socketFrames: string[];
};

test.afterAll(async () => {
  await pool.end();
});

async function createSignedInPage(
  browser: Browser,
  user: DisposableUser,
  contexts: BrowserContext[],
): Promise<SignedInPage> {
  const context = await browser.newContext();
  contexts.push(context);
  await setupClerkTestingToken({ context });
  const page = await context.newPage();
  const socketFrames: string[] = [];
  page.on("websocket", (webSocket) => {
    webSocket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string") socketFrames.push(payload);
    });
  });
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
  return { context, page, socketFrames };
}

function roomJoinButton(page: Page, roomName: string) {
  const escapedName = roomName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", {
    name: new RegExp(`^Join ${escapedName}, \\d+ online$`),
  });
}

async function sendMessage(page: Page, content: string) {
  await page.getByTestId("room-composer-input").fill(content);
  await page.getByTestId("room-send-button").click();
}

test("a live reconnect replays each message once and preserves later server order", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  test.skip(
    !chatUrl || !apiUrl || !publishableKey || !secretKey,
    "E2E_CHAT_URL, E2E_API_URL, and Clerk development keys are required",
  );

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const roomName = `Reconnect delivery ${suffix}`;
  const password = `E2e-${suffix}-Reconnect!9`;
  const beforeReconnect = `Before reconnect ${suffix}`;
  const afterReconnectFirst = `After reconnect first ${suffix}`;
  const afterReconnectSecond = `After reconnect second ${suffix}`;
  const longGapMessages = Array.from(
    { length: 81 },
    (_, index) => `Long gap ${String(index + 1).padStart(2, "0")} ${suffix}`,
  );
  const clerkClient = createClerkClient({ publishableKey, secretKey });
  const users: DisposableUser[] = [];
  const contexts: BrowserContext[] = [];
  let roomId = "";
  let testFailure: unknown;

  try {
    for (const role of ["creator", "member"] as const) {
      const username =
        role === "creator" ? `Creator ${suffix}` : `Member ${suffix}`;
      const email = `reconnect-${role}-${suffix}+clerk_test@example.com`;
      const created = await withClerkRetry(`create ${role} user`, () =>
        clerkClient.users.createUser({
          emailAddress: [email],
          password,
          firstName: role === "creator" ? "Creator" : "Member",
          lastName: "E2E",
          skipLegalChecks: true,
          privateMetadata: { purpose: "reconnect-delivery-e2e" },
        }),
      );
      users.push({ id: created.id, email, password, username });
    }

    const creator = await createSignedInPage(browser, users[0]!, contexts);
    await creator.page.getByTestId("new-room-button").click();
    await creator.page.getByTestId("room-name-input").fill(roomName);
    await Promise.all([
      creator.page.waitForURL(/\/room\/[^/?#]+/),
      creator.page.getByTestId("room-submit-button").click(),
    ]);
    roomId = decodeURIComponent(
      new URL(creator.page.url()).pathname.split("/").filter(Boolean).at(-1) ?? "",
    );
    expect(roomId).not.toBe("");

    const member = await createSignedInPage(browser, users[1]!, contexts);
    await roomJoinButton(member.page, roomName).click();
    await expect(creator.page.getByTestId("room-participant-count")).toHaveText(
      "2 people",
    );
    await expect(member.page.getByTestId("room-key-waiting")).toBeHidden({
      timeout: 15_000,
    });

    const memberJoinedRow = creator.page.getByText(/ joined$/, { exact: true });
    await expect(memberJoinedRow).toHaveCount(1);
    await sendMessage(creator.page, beforeReconnect);
    await expect(
      member.page.getByText(beforeReconnect, { exact: true }),
    ).toHaveCount(1);

    await member.context.setOffline(true);
    await expect(creator.page.getByTestId("room-participant-count")).toHaveText(
      "1 person",
    );
    for (const content of [
      afterReconnectFirst,
      ...longGapMessages,
      afterReconnectSecond,
    ]) {
      await sendMessage(creator.page, content);
    }
    await member.context.setOffline(false);
    await expect(creator.page.getByTestId("room-participant-count")).toHaveText(
      "2 people",
      { timeout: 20_000 },
    );
    await expect(member.page.getByTestId("room-key-waiting")).toBeHidden();

    // The logical list count covers the existing two rows, the disconnect
    // system row, and all 83 missed text messages. This verifies full replay
    // and deduplication without relying on virtualized off-screen DOM rows.
    await expect(member.page.getByTestId("room-message-list")).toHaveAttribute(
      "aria-label",
      "86 messages",
    );
    const second = member.page.getByText(afterReconnectSecond, { exact: true });
    await expect(second).toHaveCount(1);
    const lastLongGapMessage = member.page.getByText(longGapMessages.at(-1)!, {
      exact: true,
    });
    await expect(lastLongGapMessage).toHaveCount(1);
    await expect(member.page.getByTestId("room-message-gap-warning")).toHaveCount(0);
    await expect
      .poll(async () => {
        const [lastGapBox, secondBox] = await Promise.all([
          lastLongGapMessage.boundingBox(),
          second.boundingBox(),
        ]);
        return lastGapBox && secondBox ? lastGapBox.y < secondBox.y : false;
      })
      .toBe(true);
  } catch (error) {
    testFailure = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    const collectCleanupErrors = (results: PromiseSettledResult<unknown>[]) => {
      for (const result of results) {
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      }
    };
    collectCleanupErrors(
      await Promise.allSettled(contexts.map((context) => context.close())),
    );
    collectCleanupErrors(
      await Promise.allSettled([
        db
          .delete(roomsTable)
          .where(or(eq(roomsTable.id, roomId), eq(roomsTable.name, roomName))),
        users.length
          ? db
              .delete(userProfilesTable)
              .where(inArray(userProfilesTable.userId, users.map((user) => user.id)))
          : Promise.resolve(),
      ]),
    );
    for (const user of users) {
      await withClerkRetry(`delete user ${user.id}`, () =>
        clerkClient.users.deleteUser(user.id),
      ).catch((error) => cleanupErrors.push(error));
    }
    throwTestAndCleanupFailures(
      testFailure,
      cleanupErrors,
      "Reconnect delivery E2E cleanup failed",
      "Reconnect delivery verification and cleanup both failed",
    );
  }
});

test("a live reconnect warns when the last-seen message is outside retained history", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  test.skip(
    !chatUrl || !apiUrl || !publishableKey || !secretKey,
    "E2E_CHAT_URL, E2E_API_URL, and Clerk development keys are required",
  );

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const roomName = `Reconnect gap ${suffix}`;
  const password = `E2e-${suffix}-Reconnect!9`;
  const beforeReconnect = `Before retained gap ${suffix}`;
  // Cross the server's retained-history boundary by exactly one message so
  // this check remains a gap test when the retention window changes.
  const missedMessageCount = ROOM_MESSAGE_HISTORY_LIMIT + 1;
  const missedMessages = Array.from(
    { length: missedMessageCount },
    (_, index) => `Retained gap ${String(index + 1).padStart(3, "0")} ${suffix}`,
  );
  const newestMessage = missedMessages.at(-1)!;
  const clerkClient = createClerkClient({ publishableKey, secretKey });
  const users: DisposableUser[] = [];
  const contexts: BrowserContext[] = [];
  let roomId = "";
  let testFailure: unknown;

  try {
    for (const role of ["creator", "member"] as const) {
      const username =
        role === "creator" ? `Creator ${suffix}` : `Member ${suffix}`;
      const email = `reconnect-gap-${role}-${suffix}+clerk_test@example.com`;
      const created = await withClerkRetry(`create ${role} user`, () =>
        clerkClient.users.createUser({
          emailAddress: [email],
          password,
          firstName: role === "creator" ? "Creator" : "Member",
          lastName: "E2E",
          skipLegalChecks: true,
          privateMetadata: { purpose: "reconnect-delivery-e2e" },
        }),
      );
      users.push({ id: created.id, email, password, username });
    }

    const creator = await createSignedInPage(browser, users[0]!, contexts);
    await creator.page.getByTestId("new-room-button").click();
    await creator.page.getByTestId("room-name-input").fill(roomName);
    await Promise.all([
      creator.page.waitForURL(/\/room\/[^/?#]+/),
      creator.page.getByTestId("room-submit-button").click(),
    ]);
    roomId = decodeURIComponent(
      new URL(creator.page.url()).pathname.split("/").filter(Boolean).at(-1) ?? "",
    );
    expect(roomId).not.toBe("");

    const member = await createSignedInPage(browser, users[1]!, contexts);
    await roomJoinButton(member.page, roomName).click();
    await expect(creator.page.getByTestId("room-participant-count")).toHaveText(
      "2 people",
    );
    await expect(member.page.getByTestId("room-key-waiting")).toBeHidden({
      timeout: 15_000,
    });

    await sendMessage(creator.page, beforeReconnect);
    await expect(
      member.page.getByText(beforeReconnect, { exact: true }),
    ).toHaveCount(1);

    await member.context.setOffline(true);
    await expect(creator.page.getByTestId("room-participant-count")).toHaveText(
      "1 person",
    );
    for (const content of missedMessages) {
      await sendMessage(creator.page, content);
    }

    await member.page.evaluate(() => {
      const observedWindow = window as Window & {
        reconnectGapWarningText?: string;
      };
      const recordVisibleWarning = () => {
        const warning = document.querySelector(
          '[data-testid="room-message-gap-warning"]',
        );
        if (warning instanceof HTMLElement && warning.getClientRects().length > 0) {
          observedWindow.reconnectGapWarningText = warning.innerText;
        }
      };
      new MutationObserver(recordVisibleWarning).observe(document.body, {
        childList: true,
        subtree: true,
      });
      recordVisibleWarning();
    });
    await member.context.setOffline(false);
    await expect
      .poll(
        () =>
          member.socketFrames.some(
            (frame) =>
              frame.includes('"room-joined"') &&
              frame.includes('"replayGap":true'),
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect
      .poll(() =>
        member.page.evaluate(
          () =>
            (
              window as Window & {
                reconnectGapWarningText?: string;
              }
            ).reconnectGapWarningText ?? "",
        ),
      )
      .toContain("Some messages could not be recovered");
    await expect(member.page.getByText(newestMessage, { exact: true })).toHaveCount(
      1,
    );
    const gapWarning = member.page.getByTestId("room-message-gap-warning");
    await expect(gapWarning).toBeVisible();
    await expect(gapWarning).toContainText(
      "This device was disconnected longer than the room history kept for reconnects.",
    );
    await gapWarning.getByTestId("room-message-gap-dismiss").click();
    await expect(gapWarning).toHaveCount(0);
  } catch (error) {
    testFailure = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    const collectCleanupErrors = (results: PromiseSettledResult<unknown>[]) => {
      for (const result of results) {
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      }
    };
    collectCleanupErrors(
      await Promise.allSettled(contexts.map((context) => context.close())),
    );
    collectCleanupErrors(
      await Promise.allSettled([
        db
          .delete(roomsTable)
          .where(or(eq(roomsTable.id, roomId), eq(roomsTable.name, roomName))),
        users.length
          ? db
              .delete(userProfilesTable)
              .where(inArray(userProfilesTable.userId, users.map((user) => user.id)))
          : Promise.resolve(),
      ]),
    );
    for (const user of users) {
      await withClerkRetry(`delete user ${user.id}`, () =>
        clerkClient.users.deleteUser(user.id),
      ).catch((error) => cleanupErrors.push(error));
    }
    throwTestAndCleanupFailures(
      testFailure,
      cleanupErrors,
      "Reconnect gap E2E cleanup failed",
      "Reconnect gap verification and cleanup both failed",
    );
  }
});