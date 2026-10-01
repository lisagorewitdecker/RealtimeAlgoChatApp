// Confirms, in a real browser, that the classic tab bar drawn by expo-router's
// vendored react-navigation BottomTabBar turns solid when the in-app Reduce
// transparency switch is on. The Jest suites render stand-ins or stub tab
// state, so a change in how the vendored bar merges `tabBarStyle` or handles
// an undefined `tabBarBackground` only shows up here, against the served
// Expo web bundle (artifacts/chat-app/app/(tabs)/_layout.tsx).
import { createClerkClient } from "@clerk/backend";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { db, pool, userProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  throwTestAndCleanupFailures,
  withClerkRetry,
  withTimeout,
} from "./clerk-retry.js";

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

const PHASE_TIMEOUTS = {
  clerk: 20_000,
  authentication: 30_000,
  navigation: 20_000,
  tabBar: 15_000,
  cleanup: 15_000,
} as const;

// The default palettes in artifacts/chat-app/constants/colors.ts (dark and
// light share these values), written the way Chromium reports them from
// getComputedStyle.
const PALETTE = {
  // `background`, #0E1118: the opaque bar while Reduce transparency is on.
  background: "rgb(14, 17, 24)",
  // `border`, #343D4C: the bar's top border in both states.
  border: "rgb(52, 61, 76)",
  // `tabBarBackground`: the translucent panel web draws behind the tab items
  // while Reduce transparency is off.
  tabBarBackground: "rgba(14, 17, 24, 0.85)",
} as const;
const TRANSPARENT = "rgba(0, 0, 0, 0)";
// The layout pins the web bar to 84pt (StyleSheet.hairlineWidth is 1 on web).
const WEB_TAB_BAR_HEIGHT = "84px";
const WEB_TAB_BAR_BORDER_TOP_WIDTH = "1px";

type TabBarSurface = {
  backgroundColor: string;
  position: string;
  borderTopWidth: string;
  borderTopColor: string;
  height: string;
  surfaceCount: number;
  surfaceBackgroundColor: string | null;
};

const TRANSLUCENT_TAB_BAR: TabBarSurface = {
  backgroundColor: TRANSPARENT,
  position: "absolute",
  borderTopWidth: WEB_TAB_BAR_BORDER_TOP_WIDTH,
  borderTopColor: PALETTE.border,
  height: WEB_TAB_BAR_HEIGHT,
  surfaceCount: 1,
  surfaceBackgroundColor: PALETTE.tabBarBackground,
};

const OPAQUE_TAB_BAR: TabBarSurface = {
  backgroundColor: PALETTE.background,
  position: "absolute",
  borderTopWidth: WEB_TAB_BAR_BORDER_TOP_WIDTH,
  borderTopColor: PALETTE.border,
  height: WEB_TAB_BAR_HEIGHT,
  surfaceCount: 0,
  surfaceBackgroundColor: null,
};

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
      withTimeout(
        `[reduce-transparency-tab-bar-e2e] ${phase}`,
        operation(),
        timeoutMs,
      ),
    );
  } catch (error) {
    throw new Error(
      `[reduce-transparency-tab-bar-e2e] ${phase} failed: ${errorText(error)}`,
      { cause: error },
    );
  }
}

async function waitForAuthDestination(
  verificationCode: Locator,
  setupName: Locator,
  roomList: Locator,
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
): Promise<Page> {
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
      () => waitForAuthDestination(verificationCode, setupName, roomList),
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
  return page;
}

/**
 * The vendored BottomTabBar renders the bar as one element whose children are
 * the `StyleSheet.absoluteFill` layer holding the `tabBarBackground` element
 * and the `role="tablist"` row of tab items, so the bar is the tablist's
 * parent. The layout's translucent panel carries `testID="tab-bar-surface"`.
 */
function classicTabBar(page: Page): Locator {
  return page.getByRole("tablist").locator("xpath=..");
}

function readTabBar(tabBar: Locator): Promise<TabBarSurface> {
  return tabBar.evaluate((bar) => {
    const style = getComputedStyle(bar);
    const surfaces = bar.querySelectorAll('[data-testid="tab-bar-surface"]');
    const surface = surfaces[0];
    return {
      backgroundColor: style.backgroundColor,
      position: style.position,
      borderTopWidth: style.borderTopWidth,
      borderTopColor: style.borderTopColor,
      height: style.height,
      surfaceCount: surfaces.length,
      surfaceBackgroundColor: surface
        ? getComputedStyle(surface).backgroundColor
        : null,
    };
  });
}

test("the classic tab bar turns solid in a browser when Reduce transparency is on", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  test.skip(
    !chatUrl || !apiUrl || !publishableKey || !secretKey,
    "E2E_CHAT_URL, E2E_API_URL, and Clerk development keys are required",
  );

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const email = `reduce-transparency-${suffix}+clerk_test@example.com`;
  const password = `E2e-${suffix}-TabBar!9`;
  const clerkClient = createClerkClient({ publishableKey, secretKey });
  const contexts: BrowserContext[] = [];
  let userId = "";
  let testFailure: unknown;

  try {
    const created = await runPhase(
      "authentication: create profile user",
      PHASE_TIMEOUTS.clerk,
      () =>
        withClerkRetry("create profile user", () =>
          clerkClient.users.createUser({
            emailAddress: [email],
            password,
            firstName: "Tab",
            lastName: "Bar",
            skipLegalChecks: true,
            privateMetadata: { purpose: "reduce-transparency-tab-bar-e2e" },
          }),
        ),
    );
    userId = created.id;

    const page = await createSignedInPage(
      browser,
      { id: userId, email, password, username: `Tab bar ${suffix}` },
      contexts,
    );

    await runPhase(
      "navigation: open the Profile tab",
      PHASE_TIMEOUTS.navigation,
      async () => {
        await page.getByRole("tab", { name: /Profile/ }).click();
        await expect(page.getByTestId("accessibility-settings")).toBeVisible();
      },
    );

    const tabBar = classicTabBar(page);
    // The switch's accessible name carries its state ("Reduce transparency:
    // off" / "on"). react-native-web 0.21 renders `accessibilityState.checked`
    // as no attribute at all (only `aria-checked` maps), so `toBeChecked()`
    // would report "unchecked" in both states.
    const switchOff = page.getByRole("switch", {
      name: "Reduce transparency: off",
      exact: true,
    });
    const switchOn = page.getByRole("switch", {
      name: "Reduce transparency: on",
      exact: true,
    });

    await runPhase(
      "tab bar: translucent surface while Reduce transparency is off",
      PHASE_TIMEOUTS.tabBar,
      async () => {
        await expect(switchOff).toBeVisible();
        await expect(tabBar).toHaveCount(1);
        await expect.poll(() => readTabBar(tabBar)).toEqual(TRANSLUCENT_TAB_BAR);
      },
    );

    await runPhase(
      "tab bar: press the Reduce transparency switch",
      PHASE_TIMEOUTS.tabBar,
      async () => {
        await switchOff.click();
        await expect(switchOn).toBeVisible();
      },
    );

    await runPhase(
      "tab bar: opaque bar while Reduce transparency is on",
      PHASE_TIMEOUTS.tabBar,
      async () => {
        await expect(tabBar).toHaveCount(1);
        await expect.poll(() => readTabBar(tabBar)).toEqual(OPAQUE_TAB_BAR);
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

    if (userId) {
      collectCleanupErrors(
        await Promise.allSettled([
          withTimeout(
            "user profile database cleanup",
            db
              .delete(userProfilesTable)
              .where(eq(userProfilesTable.userId, userId)),
            PHASE_TIMEOUTS.cleanup,
          ),
          withTimeout(
            `Clerk user cleanup for ${userId}`,
            withClerkRetry(`delete user ${userId}`, () =>
              clerkClient.users.deleteUser(userId),
            ),
            PHASE_TIMEOUTS.cleanup,
          ),
        ]),
      );
    }
    collectCleanupErrors(
      await Promise.allSettled([
        withTimeout("database pool cleanup", pool.end(), PHASE_TIMEOUTS.cleanup),
      ]),
    );

    throwTestAndCleanupFailures(
      testFailure,
      cleanupErrors,
      "Reduce transparency tab bar E2E cleanup failed",
      "Reduce transparency tab bar verification and cleanup both failed",
    );
  }
});
