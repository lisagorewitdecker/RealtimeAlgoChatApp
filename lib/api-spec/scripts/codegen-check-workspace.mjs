import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testWorkspaceFlag = "--enable-test-workspace";
const workspaceOverrideEnvironmentVariable = "API_CODEGEN_CHECK_WORKSPACE";
const productionWorkspaceRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

export function resolveCodegenCheckWorkspace({
  argv = process.argv,
  env = process.env,
} = {}) {
  const testWorkspaceEnabled = argv.includes(testWorkspaceFlag);
  const inheritedWorkspace = env[workspaceOverrideEnvironmentVariable];
  const configuredWorkspace = testWorkspaceEnabled
    ? inheritedWorkspace
    : undefined;

  if (inheritedWorkspace && !testWorkspaceEnabled) {
    return {
      workspaceRoot: productionWorkspaceRoot,
      error: new Error(
        `Refusing ${workspaceOverrideEnvironmentVariable} without the explicit ${testWorkspaceFlag} test subprocess opt-in.`,
      ),
    };
  }

  return {
    workspaceRoot: resolve(configuredWorkspace ?? productionWorkspaceRoot),
    error: undefined,
  };
}