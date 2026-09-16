// Guards the Sentry native upload policy that keeps App Store / Play builds
// started without SENTRY_AUTH_TOKEN (Replit's Publish pane via Expo Launch)
// from failing inside @sentry/react-native's Xcode phases, while builds that
// do carry a credential still get the official plugin and its uploads.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const withSentryNativeUpload = require("./withSentryNativeUpload.js");
const { AUTH_TOKEN_ENV, DOTENV_FILE, SENTRY_EXPO_PLUGIN, resolveSentryUploadPolicy } =
  withSentryNativeUpload;

const pluginsDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(pluginsDirectory, "..");
const pluginReference = "./plugins/withSentryNativeUpload.js";
const props = { organization: "example-org", project: "example-project" };

function baseConfig(projectRoot = appDirectory) {
  return { name: "Example", slug: "example", _internal: { projectRoot } };
}

/** Run one registered mod the way prebuild's mod compiler invokes it. */
async function runMod(config, platform, modName) {
  const mod = config.mods?.[platform]?.[modName];
  assert.equal(typeof mod, "function", `${platform}.${modName} mod is registered`);
  return mod({
    ...config,
    modRequest: { projectRoot: config._internal.projectRoot, platform },
    modResults: null,
  });
}

function captureWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  return Promise.resolve()
    .then(run)
    .then((result) => ({ result, warnings }))
    .finally(() => {
      console.warn = original;
    });
}

describe("withSentryNativeUpload", () => {
  const savedToken = process.env[AUTH_TOKEN_ENV];

  before(() => {
    delete process.env[AUTH_TOKEN_ENV];
  });

  afterEach(() => {
    delete process.env[AUTH_TOKEN_ENV];
  });

  after(() => {
    if (savedToken === undefined) {
      delete process.env[AUTH_TOKEN_ENV];
    } else {
      process.env[AUTH_TOKEN_ENV] = savedToken;
    }
  });

  test("leaves the upload steps out and warns during prebuild when no credential exists", async () => {
    const config = withSentryNativeUpload(baseConfig(), props);

    assert.equal(
      config._internal.pluginHistory?.["@sentry/react-native"],
      undefined,
      "the official Sentry plugin must not run without a credential",
    );
    for (const platform of ["ios", "android"]) {
      const mods = config.mods[platform];
      assert.deepEqual(
        Object.keys(mods),
        ["dangerous"],
        `${platform} only carries the warning mod, no Xcode/Gradle changes`,
      );
    }

    const { warnings } = await captureWarnings(async () => {
      await runMod(config, "ios", "dangerous");
      await runMod(config, "android", "dangerous");
    });
    assert.equal(warnings.length, 2, "one prebuild warning per platform");
    for (const warning of warnings) {
      assert.match(warning, new RegExp(AUTH_TOKEN_ENV));
      assert.match(warning, /left out/);
      assert.match(warning, /EXPO_PUBLIC_SENTRY_DSN/);
    }
    assert.match(warnings[0], /ios/);
    assert.match(warnings[1], /android/);
  });

  test("does not warn while the config is merely evaluated (expo start / expo config)", async () => {
    const { warnings } = await captureWarnings(() =>
      withSentryNativeUpload(baseConfig(), props),
    );
    assert.deepEqual(warnings, []);
  });

  test(`applies the official Sentry plugin when ${AUTH_TOKEN_ENV} is present`, async () => {
    process.env[AUTH_TOKEN_ENV] = "test-token-value";

    const { result: config, warnings } = await captureWarnings(() =>
      withSentryNativeUpload(baseConfig(), props),
    );

    assert.deepEqual(warnings, [], "complete props produce no Sentry plugin warning");
    assert.ok(
      config._internal.pluginHistory?.["@sentry/react-native"],
      "the official plugin ran once",
    );
    assert.equal(typeof config.mods.ios.xcodeproj, "function", "Xcode phases are added");
    assert.equal(typeof config.mods.ios.dangerous, "function", "ios sentry.properties is written");
    assert.equal(
      typeof config.mods.android.appBuildGradle,
      "function",
      "sentry.gradle is applied",
    );
    assert.equal(
      typeof config.mods.android.dangerous,
      "function",
      "android sentry.properties is written",
    );
  });

  test(`treats a ${DOTENV_FILE} file as a credential only when it declares a token`, () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "sentry-upload-policy-"));
    const dotenvPath = path.join(projectRoot, DOTENV_FILE);
    const policy = () => resolveSentryUploadPolicy({ env: {}, projectRoot });
    const skipped = { upload: false, source: null };
    const enabled = { upload: true, source: `${DOTENV_FILE} file` };
    try {
      assert.deepEqual(policy(), skipped, "no file");

      const skippedContents = [
        "",
        "SENTRY_ORG=example-org\n",
        `${AUTH_TOKEN_ENV}=\n`,
        `${AUTH_TOKEN_ENV}=   \n`,
        `${AUTH_TOKEN_ENV}=""\n`,
        `# ${AUTH_TOKEN_ENV}=commented-out\n`,
        `${AUTH_TOKEN_ENV}= # only a comment\n`,
        `NOT_${AUTH_TOKEN_ENV}=placeholder\n`,
      ];
      for (const contents of skippedContents) {
        writeFileSync(dotenvPath, contents);
        assert.deepEqual(policy(), skipped, JSON.stringify(contents));
      }

      const enabledContents = [
        `${AUTH_TOKEN_ENV}=placeholder\n`,
        `SENTRY_ORG=example-org\n${AUTH_TOKEN_ENV}=placeholder # trailing comment\n`,
        `export ${AUTH_TOKEN_ENV}="placeholder"\n`,
        `  ${AUTH_TOKEN_ENV} = 'placeholder'\n`,
      ];
      for (const contents of enabledContents) {
        writeFileSync(dotenvPath, contents);
        assert.deepEqual(policy(), enabled, JSON.stringify(contents));
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("ignores a blank environment token", () => {
    assert.deepEqual(
      resolveSentryUploadPolicy({ env: { [AUTH_TOKEN_ENV]: "   " }, projectRoot: appDirectory }),
      { upload: false, source: null },
    );
    assert.deepEqual(
      resolveSentryUploadPolicy({ env: { [AUTH_TOKEN_ENV]: "value" }, projectRoot: appDirectory }),
      { upload: true, source: `${AUTH_TOKEN_ENV} environment variable` },
    );
  });

  test("rejects a missing organization or project instead of deferring to build-time env", () => {
    assert.throws(
      () => withSentryNativeUpload(baseConfig(), { project: "example-project" }),
      /"organization"/,
    );
    assert.throws(
      () => withSentryNativeUpload(baseConfig(), { organization: "example-org", project: " " }),
      /"project"/,
    );
  });

  test("rejects an authToken plugin option because app.json is committed", () => {
    for (const authToken of ["inline-token", ""]) {
      assert.throws(
        () => withSentryNativeUpload(baseConfig(), { ...props, authToken }),
        /remove "authToken"/,
      );
    }
  });
});

describe("app.json Sentry plugin wiring", () => {
  const { expo } = JSON.parse(readFileSync(path.join(appDirectory, "app.json"), "utf8"));
  const plugins = expo.plugins ?? [];
  const pluginName = (entry) => (Array.isArray(entry) ? entry[0] : entry);

  test("routes the Sentry native integration through the upload policy plugin", () => {
    const entry = plugins.find((candidate) => pluginName(candidate) === pluginReference);
    assert.ok(entry, `app.json lists ${pluginReference}`);
    assert.ok(existsSync(path.join(appDirectory, pluginReference)));
    const [, options] = entry;
    assert.equal(typeof options?.organization, "string");
    assert.notEqual(options.organization.trim(), "");
    assert.equal(typeof options?.project, "string");
    assert.notEqual(options.project.trim(), "");
  });

  test("never lists @sentry/react-native's plugin directly, which would bypass the policy", () => {
    const direct = plugins
      .map(pluginName)
      .filter((name) => name === "@sentry/react-native" || name.startsWith(`${SENTRY_EXPO_PLUGIN}`));
    assert.deepEqual(direct, []);
  });
});

describe("sentry-cli resolution for the native build scripts", () => {
  // @sentry/react-native's Xcode and Gradle scripts locate sentry-cli with
  // `require.resolve('@sentry/cli/package.json')` from the app directory. With
  // pnpm's isolated node_modules that only works when the app declares
  // @sentry/cli itself, pinned to the version @sentry/react-native expects.
  test("@sentry/cli is declared by the app at @sentry/react-native's exact version", () => {
    const appManifest = JSON.parse(readFileSync(path.join(appDirectory, "package.json"), "utf8"));
    const sentryReactNative = require("@sentry/react-native/package.json");
    const expected = sentryReactNative.dependencies["@sentry/cli"];

    assert.match(expected, /^\d+\.\d+\.\d+$/, "@sentry/react-native pins an exact sentry-cli");
    assert.equal(appManifest.devDependencies["@sentry/cli"], expected);
  });

  test("@sentry/cli resolves from the app directory", () => {
    const resolved = require.resolve("@sentry/cli/package.json", { paths: [appDirectory] });
    const installed = JSON.parse(readFileSync(resolved, "utf8"));
    const sentryReactNative = require("@sentry/react-native/package.json");
    assert.equal(installed.version, sentryReactNative.dependencies["@sentry/cli"]);
    assert.ok(existsSync(path.join(path.dirname(resolved), "bin", "sentry-cli")));
  });
});
