import { resolveCodegenCheckWorkspace } from "./codegen-check-workspace.mjs";
import {
  findStagedBackupDirectories,
  reportStagedBackupDirectories,
} from "./staged-codegen-backups.mjs";

const { workspaceRoot, error: workspaceOverrideError } =
  resolveCodegenCheckWorkspace();
if (workspaceOverrideError) {
  console.error(workspaceOverrideError.message);
  console.error("No generated files were changed.");
  process.exit(1);
}

try {
  const stagedBackupDirectories = findStagedBackupDirectories(workspaceRoot);
  if (stagedBackupDirectories.length > 0) {
    reportStagedBackupDirectories(stagedBackupDirectories);
    process.exit(1);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `Could not check the Git index for generated-client recovery backups: ${message}`,
  );
  process.exit(1);
}