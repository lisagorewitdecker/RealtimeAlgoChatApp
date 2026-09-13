import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findStagedBackupDirectories,
  reportStagedBackupDirectories,
} from "./staged-codegen-backups.mjs";

const workspaceRoot = resolve(
  process.env.API_CODEGEN_CHECK_WORKSPACE ??
    fileURLToPath(new URL("../../..", import.meta.url)),
);

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