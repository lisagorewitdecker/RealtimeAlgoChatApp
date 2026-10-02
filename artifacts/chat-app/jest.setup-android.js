/* jshint esversion: 6 */

// Listed only by the Android project in jest.config.js.
//
// jest-expo's Android preset makes react-native resolve to its Android
// Platform module, which is what sends every Platform.OS / Platform.select
// branch in the screens down the Android path. If that resolution ever breaks
// (a preset change, a haste platform change), the run labelled "Android" would
// silently re-test iOS, so refuse to run the suite instead.
const { Platform } = require("react-native");

if (Platform.OS !== "android") {
  throw new Error(
    `The Android Jest project resolved react-native's Platform.OS to "${Platform.OS}" instead of "android". ` +
      "Check the jest-expo/android preset in jest.config.js.",
  );
}
