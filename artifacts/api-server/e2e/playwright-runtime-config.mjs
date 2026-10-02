import { fileURLToPath } from "node:url";

// The Chromium runtime checks read the Replit Nix package contract from the
// workspace .replit. PLAYWRIGHT_RUNTIME_CONFIG_PATH redirects that read to a
// fixture file for the clean-runtime harness and the browser-setup tests, which
// delete their fixtures afterwards. Like the synthetic SONAME fixture, the
// redirect needs its own explicit opt-in: a shell, CI job, or workflow that
// inherits a stale path must neither crash a normal check with ENOENT nor make
// it validate the wrong file. The opt-in stays separate from the contract
// check's fault-injection test mode so each fixture subprocess receives only
// the capability it exercises.
export const runtimeConfigPathVariable = "PLAYWRIGHT_RUNTIME_CONFIG_PATH";
export const runtimeConfigFixtureVariable = "PLAYWRIGHT_RUNTIME_CONFIG_FIXTURE";
export const workspaceRuntimeConfigPath = fileURLToPath(
  new URL("../../../.replit", import.meta.url),
);

export function resolveRuntimeConfigPath(environment = process.env) {
  const fixtureConfigPath = environment[runtimeConfigPathVariable];
  if (environment[runtimeConfigFixtureVariable] === "1" && fixtureConfigPath) {
    return fixtureConfigPath;
  }
  return workspaceRuntimeConfigPath;
}
