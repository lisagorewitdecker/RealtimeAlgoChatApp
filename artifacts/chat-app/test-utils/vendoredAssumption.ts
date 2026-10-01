/**
 * Shared failure format for the suites that render expo-router's vendored
 * navigation code instead of a stand-in (__tests__/VendoredBottomTabBar.test.tsx
 * for the classic bottom tab bar, __tests__/VendoredNativeTabsView.test.tsx
 * for the iOS 26 native tabs' insets, __tests__/NativeTabBarAppearance.test.tsx
 * for their appearance). Those suites exist so an Expo SDK upgrade that
 * swaps the vendored copy fails loudly; the failure has to say which vendored
 * file changed, which assumption the app relies on, and what to re-verify on
 * a phone before the app code is adjusted to the new behaviour.
 */

/** A vendored file and the behaviour the app relies on it for. */
export type VendoredAssumption = { file: string; claim: string };

/** Verifies a vendored assumption, re-throwing failures in the shared format. */
export type AssumptionCheck = (
  assumption: VendoredAssumption,
  verify: () => void,
) => void;

/**
 * Builds a check that re-throws an assertion failure with the vendored file
 * and the assumption it contradicts in front of Jest's diff, followed by
 * `advice` (what relies on the assumption and what to re-verify). The
 * original code frame is kept.
 */
export function createAssumptionCheck(advice: string): AssumptionCheck {
  return function checkAssumption({ file, claim }, verify) {
    try {
      verify();
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      const stack = error.stack ?? "";
      const firstFrame = stack.search(/\n\s+at\s/);
      const frames = firstFrame === -1 ? "" : stack.slice(firstFrame);
      error.message =
        `Vendored ${file} no longer matches the assumption that ${claim}. ` +
        `${advice}\n\n${error.message}`;
      error.stack = `${error.name}: ${error.message}${frames}`;
      throw error;
    }
  };
}
