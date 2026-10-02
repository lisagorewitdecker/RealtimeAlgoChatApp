/**
 * Return duplicate decoded property names found within the same JSON object.
 *
 * This deliberately scans the source instead of inspecting JSON.parse output:
 * JSON.parse applies last-value-wins semantics and cannot reveal conflicts
 * after it has constructed the object.
 */
export const MAX_JSON_EVIDENCE_BYTES = 256 * 1024;
export const MAX_JSON_EVIDENCE_DEPTH = 64;

export class JsonEvidenceLimitError extends Error {
  constructor(kind) {
    const message =
      kind === "size"
        ? "JSON evidence exceeds the maximum allowed size."
        : "JSON evidence exceeds the maximum allowed nesting depth.";
    super(message);
    this.name = "JsonEvidenceLimitError";
    this.code =
      kind === "size"
        ? "JSON_EVIDENCE_TOO_LARGE"
        : "JSON_EVIDENCE_TOO_DEEP";
  }
}

export function isJsonEvidenceLimitError(error) {
  return error instanceof JsonEvidenceLimitError;
}

export function assertJsonEvidenceWithinLimits(
  source,
  {
    maxBytes = MAX_JSON_EVIDENCE_BYTES,
  } = {},
) {
  if (Buffer.byteLength(source, "utf8") > maxBytes) {
    throw new JsonEvidenceLimitError("size");
  }
}

export function findDuplicateJsonObjectKeys(
  source,
  {
    maxBytes = MAX_JSON_EVIDENCE_BYTES,
    maxDepth = MAX_JSON_EVIDENCE_DEPTH,
  } = {},
) {
  assertJsonEvidenceWithinLimits(source, { maxBytes });
  let index = 0;
  const duplicates = new Set();

  function skipWhitespace() {
    while (/\s/.test(source[index] ?? "")) index += 1;
  }

  function readString() {
    if (source[index] !== '"') return null;
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
      } else if (source[index] === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          return null;
        }
      } else {
        index += 1;
      }
    }
    return null;
  }

  function scanValue(depth) {
    skipWhitespace();
    if (source[index] === "{" || source[index] === "[") {
      if (depth >= maxDepth) {
        throw new JsonEvidenceLimitError("depth");
      }
      return source[index] === "{"
        ? scanObject(depth + 1)
        : scanArray(depth + 1);
    }
    if (source[index] === '"') return readString() !== null;

    const start = index;
    while (index < source.length && !/[,\]}]/.test(source[index])) {
      index += 1;
    }
    return index > start;
  }

  function scanObject(depth) {
    if (source[index] !== "{") return false;
    const seenKeys = new Set();
    index += 1;
    skipWhitespace();
    if (source[index] === "}") {
      index += 1;
      return true;
    }

    while (index < source.length) {
      skipWhitespace();
      const key = readString();
      if (key === null) return false;
      if (seenKeys.has(key)) duplicates.add(key);
      else seenKeys.add(key);
      skipWhitespace();
      if (source[index] !== ":") return false;
      index += 1;
      if (!scanValue(depth)) return false;
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return true;
      }
      if (source[index] !== ",") return false;
      index += 1;
    }
    return false;
  }

  function scanArray(depth) {
    if (source[index] !== "[") return false;
    index += 1;
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return true;
    }

    while (index < source.length) {
      if (!scanValue(depth)) return false;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return true;
      }
      if (source[index] !== ",") return false;
      index += 1;
    }
    return false;
  }

  if (!scanValue(0)) return [];
  skipWhitespace();
  return index === source.length ? [...duplicates] : [];
}