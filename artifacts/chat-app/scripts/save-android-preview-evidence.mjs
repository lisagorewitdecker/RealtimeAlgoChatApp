import {
  runPreviewEvidenceCli,
  savePreviewEvidence,
} from "./save-preview-evidence.mjs";

export function saveAndroidPreviewEvidence(options = {}) {
  return savePreviewEvidence({ ...options, platform: "android" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPreviewEvidenceCli("android").catch((error) => {
    console.error(`Android preview evidence save failed: ${error.message}`);
    process.exitCode = 1;
  });
}
