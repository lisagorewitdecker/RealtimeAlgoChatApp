import { Platform } from "react-native";

/** The platforms the Chat App Jest projects run under (see jest.config.js). */
export type TestPlatform = "ios" | "android";

/**
 * The platform react-native resolves to in the current Jest project.
 *
 * The layout suites run once per project, so an expectation that legitimately
 * differs between iOS and Android must be keyed by this value. Any other
 * platform has no project configured and fails loudly rather than picking a
 * default.
 */
export function testPlatform(): TestPlatform {
  if (Platform.OS === "ios" || Platform.OS === "android") {
    return Platform.OS;
  }
  throw new Error(`No Jest project is configured for Platform.OS "${Platform.OS}".`);
}

/** The value expected under the current Jest project's platform. */
export function onTestPlatform<T>(expected: Record<TestPlatform, T>): T {
  return expected[testPlatform()];
}
