import {
  runPreviewEvidenceCli,
  savePreviewEvidence,
} from "./save-preview-evidence.mjs";

export function saveIosPreviewEvidence(options = {}) {
  return savePreviewEvidence({ ...options, platform: "ios" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPreviewEvidenceCli("ios").catch((error) => {
    console.error(`iOS preview evidence save failed: ${error.message}`);
    process.exitCode = 1;
  });
}
