// The Chat App suite runs as two Jest projects.
//
// jest-expo's default preset resolves react-native to its iOS build, so an
// iOS-only run never exercises a Platform.OS / Platform.select branch, an
// Android-only style property (textAlignVertical, elevation) or Android
// keyboard behaviour. No Android emulator or device is reachable from this
// workspace, so the screen and layout suites run a second time under
// jest-expo's Android preset; that run is the only early signal for
// Android-only display regressions.
//
// Run one platform with `jest --selectProjects iOS` or
// `jest --selectProjects Android`; a bare path filter runs the file under
// every project that lists it.
const fs = require("fs");
const path = require("path");

const shared = {
  setupFiles: ["<rootDir>/jest.setup.js"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup-after-env.js"],
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/$1" },
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/scripts/"],
};

// Suites whose assertions describe what is on screen: safe-area padding,
// tab-bar reservation, keyboard avoidance, multiline alignment, system bars.
// Pure logic suites (crypto, sockets, analytics, storage keys) behave the same
// on both platforms and would only add time to the run.
const androidLayoutSuites = [
  "AiPanelLayout",
  "EntryBranding",
  "ForgotPassword",
  "NewRoom",
  "ProfileModeration",
  "Room",
  "Setup",
  "SignIn",
  "SignUp",
  "TabLayout",
];

const androidTestMatch = androidLayoutSuites.map((name) => {
  const file = path.join(__dirname, "__tests__", `${name}.test.tsx`);
  if (!fs.existsSync(file)) {
    // A renamed or removed suite would otherwise silently drop out of the
    // Android run while the iOS project keeps passing.
    throw new Error(
      `jest.config.js: Android layout suite "${name}" was not found at ${file}. ` +
        "Update androidLayoutSuites to match the renamed or removed test file.",
    );
  }
  return `<rootDir>/__tests__/${name}.test.tsx`;
});

module.exports = {
  projects: [
    {
      displayName: { name: "iOS", color: "white" },
      preset: "jest-expo",
      ...shared,
    },
    {
      displayName: { name: "Android", color: "blueBright" },
      preset: "jest-expo/android",
      ...shared,
      // The extra setup file refuses to run if the preset stops resolving
      // react-native to its Android build.
      setupFiles: [...shared.setupFiles, "<rootDir>/jest.setup-android.js"],
      testMatch: androidTestMatch,
    },
  ],
};
