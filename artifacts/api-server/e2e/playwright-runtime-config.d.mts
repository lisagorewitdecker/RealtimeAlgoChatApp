export const runtimeConfigPathVariable: "PLAYWRIGHT_RUNTIME_CONFIG_PATH";
export const runtimeConfigFixtureVariable: "PLAYWRIGHT_RUNTIME_CONFIG_FIXTURE";
export const workspaceRuntimeConfigPath: string;
export function resolveRuntimeConfigPath(
  environment?: NodeJS.ProcessEnv,
): string;
