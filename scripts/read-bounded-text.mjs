import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { open } from "node:fs/promises";

import {
  MAX_JSON_EVIDENCE_BYTES,
  JsonEvidenceLimitError,
} from "./find-duplicate-json-object-keys.mjs";

function assertFileSize(size, maxBytes) {
  if (size > maxBytes) {
    throw new JsonEvidenceLimitError("size");
  }
}


export function readBoundedTextFileSync(
  filePath,
  { maxBytes = MAX_JSON_EVIDENCE_BYTES } = {},
) {
  const descriptor = openSync(filePath, "r");
  try {
    assertFileSize(fstatSync(descriptor).size, maxBytes);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      throw new JsonEvidenceLimitError("size");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

export async function readBoundedTextFile(
  filePath,
  { maxBytes = MAX_JSON_EVIDENCE_BYTES } = {},
) {
  const handle = await open(filePath, "r");
  try {
    assertFileSize((await handle.stat()).size, maxBytes);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      throw new JsonEvidenceLimitError("size");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}