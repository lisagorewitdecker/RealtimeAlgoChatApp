import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const backupDirectoryPrefix = ".api-codegen-check-";

export function findStagedBackupDirectories(workspaceRoot) {
  if (!existsSync(join(workspaceRoot, ".git"))) {
    return [];
  }

  const result = spawnSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `git exited with status ${result.status}`,
    );
  }

  return [
    ...new Set(
      result.stdout
        .split("\0")
        .filter(Boolean)
        .map((path) => path.split("/")[0])
        .filter((path) => path.startsWith(backupDirectoryPrefix)),
    ),
  ].sort();
}

export function reportStagedBackupDirectories(
  stagedBackupDirectories,
  {
    heading = "Refusing to continue because generated-client recovery backup directories are staged:",
  } = {},
) {
  console.error(heading);
  for (const directory of stagedBackupDirectories) {
    console.error(`- ${directory}`);
  }
  console.error(
    "These folders may contain the only recovery copy of local generated-client edits. Review and recover any needed files, then remove the backup folders from the workspace and Git staging before re-running this check.",
  );
}