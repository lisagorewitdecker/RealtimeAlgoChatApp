import assert from "node:assert/strict";
import test from "node:test";
import {
  checkExpoGoNativeCompatibility,
  readInstalledInputs,
  resolveExpoGoBuild,
} from "./expo-go-native-compatibility.mjs";

const record = {
  targetExpoGoIosVersion: "57.0.5",
  expoGoIosBuilds: {
    "57.0.5": {
      "react-native-worklets": "0.10.0",
      "react-native-reanimated": "4.5.0",
    },
    "57.0.6": {
      "react-native-worklets": "0.10.1",
      "react-native-reanimated": "4.5.1",
    },
  },
};

const bundledNativeModules = {
  "react-native-worklets": "0.10.1",
  "react-native-reanimated": "4.5.1",
};

function inputs(overrides = {}) {
  return {
    record,
    bundledNativeModules,
    packageJson: {
      devDependencies: {
        "react-native-worklets": "0.10.0",
        "react-native-reanimated": "4.5.0",
      },
      expo: {
        install: { exclude: ["react-native-reanimated", "react-native-worklets"] },
      },
    },
    installedVersions: {
      "react-native-worklets": "0.10.0",
      "react-native-reanimated": "4.5.0",
    },
    ...overrides,
  };
}

test("passes when the pins match the targeted Expo Go build and are excluded from the SDK check", () => {
  const result = checkExpoGoNativeCompatibility(inputs());
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.deviatingPackages, [
    "react-native-worklets",
    "react-native-reanimated",
  ]);
  assert.match(result.summary, /Expo Go iOS 57\.0\.5 native modules \(build 57\.0\.5\)/);
  assert.match(result.summary, /react-native-worklets 0\.10\.0 \(SDK default 0\.10\.1, excluded/);
});

test("fails when the SDK default JavaScript is installed against the older Expo Go native part", () => {
  const result = checkExpoGoNativeCompatibility(
    inputs({
      installedVersions: {
        "react-native-worklets": "0.10.1",
        "react-native-reanimated": "4.5.1",
      },
      packageJson: {
        devDependencies: {
          "react-native-worklets": "0.10.1",
          "react-native-reanimated": "~4.5.1",
        },
      },
    }),
  );
  const text = result.problems.join("\n");
  assert.match(text, /react-native-worklets installed=0\.10\.1 but Expo Go iOS 57\.0\.5 .* embeds 0\.10\.0/);
  assert.match(text, /react-native-reanimated installed=4\.5\.1 but Expo Go iOS 57\.0\.5 .* embeds 4\.5\.0/);
  assert.match(text, /quits during startup/);
  assert.match(text, /declared as "~4\.5\.1"/);
  assert.match(text, /expo\.install\.exclude in package\.json is \[\] but must list exactly .*\[react-native-reanimated, react-native-worklets\]/);
});

test("rejects a range specifier even when the installed version currently matches", () => {
  const result = checkExpoGoNativeCompatibility(
    inputs({
      packageJson: {
        devDependencies: {
          "react-native-worklets": "0.10.0",
          "react-native-reanimated": "^4.5.0",
        },
        expo: { install: { exclude: ["react-native-reanimated", "react-native-worklets"] } },
      },
    }),
  );
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /react-native-reanimated is declared as "\^4\.5\.0"/);
});

test("requires the exclusion list to shrink once a target no longer deviates from the SDK default", () => {
  const retargeted = { ...record, targetExpoGoIosVersion: "57.0.9" };
  assert.equal(resolveExpoGoBuild(retargeted).build, "57.0.6");
  const result = checkExpoGoNativeCompatibility(
    inputs({
      record: retargeted,
      installedVersions: {
        "react-native-worklets": "0.10.1",
        "react-native-reanimated": "4.5.1",
      },
      packageJson: {
        devDependencies: {
          "react-native-worklets": "0.10.1",
          "react-native-reanimated": "4.5.1",
        },
        expo: { install: { exclude: ["react-native-reanimated", "react-native-worklets"] } },
      },
    }),
  );
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /must list exactly .*: \[\]/);
  assert.deepEqual(result.deviatingPackages, []);
});

test("reports a missing installation instead of treating it as compatible", () => {
  const result = checkExpoGoNativeCompatibility(
    inputs({ installedVersions: { "react-native-reanimated": "4.5.0" } }),
  );
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /react-native-worklets installed=missing/);
});

test("refuses a target older than every recorded Expo Go build", () => {
  assert.throws(
    () => resolveExpoGoBuild({ ...record, targetExpoGoIosVersion: "57.0.4" }),
    /no build at or below the targeted Expo Go iOS 57\.0\.4/,
  );
  assert.throws(
    () => resolveExpoGoBuild({ ...record, targetExpoGoIosVersion: "57.0" }),
    /exact x\.y\.z Expo Go iOS version/,
  );
});

test("the checked-in record, package.json and node_modules agree", () => {
  const result = checkExpoGoNativeCompatibility(readInstalledInputs());
  assert.deepEqual(result.problems, []);
});
