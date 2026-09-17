/* jshint esversion: 6, node: true */

"use strict";

/**
 * Expo config plugin: apply @sentry/react-native's native build integration
 * only when the build can actually upload to Sentry.
 *
 * `@sentry/react-native/expo` adds Xcode build phases ("Bundle React Native
 * code and images" wrapped in sentry-cli, "Upload Debug Symbols to Sentry")
 * and a Gradle script that run sentry-cli during Release builds. sentry-cli
 * needs SENTRY_AUTH_TOKEN for those uploads; without it the Xcode phase exits
 * non-zero and the App Store archive is aborted. Builds started from Replit's
 * Publish pane (Expo Launch) never receive that token (see replit.md), so this
 * wrapper leaves the upload steps out of the generated native projects when no
 * credential is present and prints a prebuild warning instead of failing the
 * archive. Runtime crash reporting through EXPO_PUBLIC_SENTRY_DSN is unaffected
 * either way.
 *
 * A credential is detected from the SENTRY_AUTH_TOKEN environment variable or
 * from a non-blank SENTRY_AUTH_TOKEN entry in a `.env.sentry-build-plugin`
 * file in the app directory (the dotenv file the Sentry build scripts hand to
 * sentry-cli through SENTRY_DOTENV_PATH). The official plugin's `authToken`
 * prop is rejected: app.json is static and committed, so that prop could only
 * ever hold a committed credential.
 *
 * `organization` and `project` are required: sentry-cli cannot upload without
 * them, and the official plugin only warns when they are missing.
 */
const fs = require("node:fs");
const path = require("node:path");
const { WarningAggregator, withDangerousMod } = require("expo/config-plugins");

const PLUGIN_NAME = "withSentryNativeUpload";
const SENTRY_EXPO_PLUGIN = "@sentry/react-native/expo";
const AUTH_TOKEN_ENV = "SENTRY_AUTH_TOKEN";
const DOTENV_FILE = ".env.sentry-build-plugin";
const REQUIRED_PROPS = ["organization", "project"];
const PLATFORMS = ["ios", "android"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read the SENTRY_AUTH_TOKEN entry of a dotenv file the way sentry-cli's
 * dotenv loader does for the common cases: `KEY=value`, an optional `export `
 * prefix, single or double quotes, and `#` comments. Returns true only when
 * the entry has a non-blank value, so an empty or malformed file does not
 * re-enable upload phases that would then fail the archive.
 */
function dotenvDeclaresAuthToken(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  const entry = new RegExp(`^\\s*(?:export\\s+)?${AUTH_TOKEN_ENV}\\s*=(.*)$`, "m");
  const match = contents.match(entry);
  if (!match) {
    return false;
  }
  let value = match[1].trim();
  const quoted = value.match(/^(["'])(.*)\1$/);
  if (quoted) {
    value = quoted[2];
  } else {
    value = value.replace(/(^|\s)#.*$/, "").trim();
  }
  return value.length > 0;
}

/**
 * Decide whether the generated native projects should include Sentry's upload
 * steps. Returns `{ upload: true, source }` naming the credential that was
 * found, or `{ upload: false, source: null }`.
 */
function resolveSentryUploadPolicy({ env = process.env, projectRoot } = {}) {
  if (isNonEmptyString(env[AUTH_TOKEN_ENV])) {
    return { upload: true, source: `${AUTH_TOKEN_ENV} environment variable` };
  }
  if (
    isNonEmptyString(projectRoot) &&
    dotenvDeclaresAuthToken(path.join(projectRoot, DOTENV_FILE))
  ) {
    return { upload: true, source: `${DOTENV_FILE} file` };
  }
  return { upload: false, source: null };
}

function assertPluginProps(props) {
  for (const key of REQUIRED_PROPS) {
    if (!isNonEmptyString(props?.[key])) {
      throw new Error(
        `${PLUGIN_NAME}: app.json must pass a non-empty "${key}" to this plugin ` +
          `(forwarded to ${SENTRY_EXPO_PLUGIN}); sentry-cli cannot upload without it.`,
      );
    }
  }
  if (props !== null && typeof props === "object" && "authToken" in props) {
    throw new Error(
      `${PLUGIN_NAME}: remove "authToken" from the plugin options in app.json. ` +
        `app.json is committed, so the token must only reach a build through the ` +
        `${AUTH_TOKEN_ENV} environment variable (or an ignored ${DOTENV_FILE} file).`,
    );
  }
}

function loadSentryExpoPlugin() {
  const loaded = require(SENTRY_EXPO_PLUGIN);
  const plugin = loaded?.default ?? loaded?.withSentry ?? loaded;
  if (typeof plugin !== "function") {
    throw new Error(
      `${PLUGIN_NAME}: ${SENTRY_EXPO_PLUGIN} did not export a config plugin function.`,
    );
  }
  return plugin;
}

function skippedUploadWarning(platform) {
  return (
    `${AUTH_TOKEN_ENV} is not set in this build environment, so Sentry's ` +
    `source-map and debug-symbol upload steps were left out of the ${platform} ` +
    "project. Crash reports still use EXPO_PUBLIC_SENTRY_DSN, but JavaScript " +
    "stack traces from this build stay minified in Sentry. Provide " +
    `${AUTH_TOKEN_ENV} to the build (or a ${DOTENV_FILE} file) to enable uploads.`
  );
}

/**
 * Register a no-op mod per platform whose only job is to warn during prebuild.
 * Warning from the mod (rather than at config-evaluation time) keeps the
 * message out of `expo start` / `expo config` output, where no native build
 * happens.
 */
function withSkippedUploadWarning(config) {
  return PLATFORMS.reduce(
    (current, platform) =>
      withDangerousMod(current, [
        platform,
        async (modConfig) => {
          WarningAggregator.addWarningForPlatform(
            platform,
            "@sentry/react-native",
            skippedUploadWarning(platform),
          );
          return modConfig;
        },
      ]),
    config,
  );
}

const withSentryNativeUpload = (config, props) => {
  assertPluginProps(props);
  const policy = resolveSentryUploadPolicy({
    projectRoot: config._internal?.projectRoot,
  });
  if (!policy.upload) {
    return withSkippedUploadWarning(config);
  }
  return loadSentryExpoPlugin()(config, props);
};

module.exports = withSentryNativeUpload;
module.exports.resolveSentryUploadPolicy = resolveSentryUploadPolicy;
module.exports.AUTH_TOKEN_ENV = AUTH_TOKEN_ENV;
module.exports.DOTENV_FILE = DOTENV_FILE;
module.exports.SENTRY_EXPO_PLUGIN = SENTRY_EXPO_PLUGIN;
