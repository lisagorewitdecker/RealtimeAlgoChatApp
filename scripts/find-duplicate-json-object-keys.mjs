/**
 * Return duplicate decoded property names found within the same JSON object.
 *
 * This deliberately scans the source instead of inspecting JSON.parse output:
 * JSON.parse applies last-value-wins semantics and cannot reveal conflicts
 * after it has constructed the object.
 */
export function findDuplicateJsonObjectKeys(source) {
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

  function scanValue() {
    skipWhitespace();
    if (source[index] === "{") return scanObject();
    if (source[index] === "[") return scanArray();
    if (source[index] === '"') return readString() !== null;

    const start = index;
    while (index < source.length && !/[,\]}]/.test(source[index])) {
      index += 1;
    }
    return index > start;
  }

  function scanObject() {
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
      if (!scanValue()) return false;
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

  function scanArray() {
    if (source[index] !== "[") return false;
    index += 1;
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return true;
    }

    while (index < source.length) {
      if (!scanValue()) return false;
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

  if (!scanValue()) return [];
  skipWhitespace();
  return index === source.length ? [...duplicates] : [];
}