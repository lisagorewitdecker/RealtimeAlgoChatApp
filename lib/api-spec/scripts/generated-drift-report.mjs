// Renders a bounded, human-readable unified diff between the generated API
// client files as they existed before regeneration and the freshly generated
// output. It is used by check-generated.mjs to explain drift failures and has
// no dependencies beyond Node.js built-ins.

const noTrailingNewlineMarker = "\\ No newline at end of file";
const binarySampleBytes = 8000;

export const defaultDriftReportLimits = Object.freeze({
  // Lines of unchanged context shown around each change.
  contextLines: 3,
  // Hunk lines (headers and content) rendered per changed file.
  maxLinesPerFile: 200,
  // Total lines rendered for the diff section across every changed file.
  maxTotalLines: 1000,
  // Characters kept from a single line before it is elided.
  maxLineLength: 240,
  // Largest edit script searched exactly; beyond it the changed region is
  // reported as one replaced block so pathological rewrites stay fast.
  maxEditDistance: 2000,
});

function resolveLimits(limits) {
  return { ...defaultDriftReportLimits, ...limits };
}

function isBinary(buffer) {
  return buffer.subarray(0, binarySampleBytes).includes(0);
}

export function splitLines(text) {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  } else {
    lines.push(noTrailingNewlineMarker);
  }
  return lines;
}

// Myers' O(ND) shortest edit script with a trace for backtracking. Returns
// null when the edit distance exceeds maxEditDistance.
function shortestEditScript(before, after, maxEditDistance) {
  const beforeLength = before.length;
  const afterLength = after.length;
  const maxDistance = beforeLength + afterLength;
  if (maxDistance === 0) {
    return [];
  }

  const offset = maxDistance + 1;
  const furthest = new Int32Array(2 * maxDistance + 3);
  const trace = [];
  const limit = Math.min(maxDistance, maxEditDistance);

  for (let distance = 0; distance <= limit; distance += 1) {
    trace.push(furthest.slice(offset - distance - 1, offset + distance + 2));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x;
      if (
        diagonal === -distance ||
        (diagonal !== distance &&
          furthest[offset + diagonal - 1] < furthest[offset + diagonal + 1])
      ) {
        x = furthest[offset + diagonal + 1];
      } else {
        x = furthest[offset + diagonal - 1] + 1;
      }
      let y = x - diagonal;
      while (x < beforeLength && y < afterLength && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      furthest[offset + diagonal] = x;
      if (x >= beforeLength && y >= afterLength) {
        return backtrackEditScript(before, after, trace);
      }
    }
  }

  return null;
}

function backtrackEditScript(before, after, trace) {
  const operations = [];
  let x = before.length;
  let y = after.length;

  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const snapshot = trace[distance];
    const furthestAt = (diagonal) => snapshot[diagonal + distance + 1];
    const diagonal = x - y;
    const previousDiagonal =
      diagonal === -distance ||
      (diagonal !== distance &&
        furthestAt(diagonal - 1) < furthestAt(diagonal + 1))
        ? diagonal + 1
        : diagonal - 1;
    const previousX = furthestAt(previousDiagonal);
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      operations.push({ type: "equal", line: before[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (distance > 0) {
      operations.push(
        x === previousX
          ? { type: "insert", line: after[previousY] }
          : { type: "delete", line: before[previousX] },
      );
    }
    x = previousX;
    y = previousY;
  }

  return operations.reverse();
}

export function diffLines(
  before,
  after,
  maxEditDistance = defaultDriftReportLimits.maxEditDistance,
) {
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const changedBefore = before.slice(prefix, before.length - suffix);
  const changedAfter = after.slice(prefix, after.length - suffix);
  const changedOperations = shortestEditScript(
    changedBefore,
    changedAfter,
    maxEditDistance,
  ) ?? [
    ...changedBefore.map((line) => ({ type: "delete", line })),
    ...changedAfter.map((line) => ({ type: "insert", line })),
  ];

  return [
    ...before.slice(0, prefix).map((line) => ({ type: "equal", line })),
    ...changedOperations,
    ...before
      .slice(before.length - suffix)
      .map((line) => ({ type: "equal", line })),
  ];
}

export function describeGeneratedChange(path, before, after, limits = {}) {
  const { maxEditDistance } = resolveLimits(limits);
  const kind = !before ? "added" : !after ? "removed" : "modified";
  const change = {
    path,
    kind,
    binary: false,
    beforeBytes: before?.length ?? 0,
    afterBytes: after?.length ?? 0,
    insertions: 0,
    deletions: 0,
    operations: [],
  };

  if ((before && isBinary(before)) || (after && isBinary(after))) {
    return { ...change, binary: true };
  }

  const operations = diffLines(
    before ? splitLines(before.toString("utf8")) : [],
    after ? splitLines(after.toString("utf8")) : [],
    maxEditDistance,
  );
  for (const operation of operations) {
    if (operation.type === "insert") {
      change.insertions += 1;
    } else if (operation.type === "delete") {
      change.deletions += 1;
    }
  }
  return { ...change, operations };
}

export function summarizeGeneratedChange(change) {
  const counts = [
    change.insertions > 0 ? `+${change.insertions}` : null,
    change.deletions > 0 ? `-${change.deletions}` : null,
  ].filter(Boolean);
  let detail;
  if (change.binary) {
    detail = `binary, ${change.beforeBytes} → ${change.afterBytes} bytes`;
  } else if (counts.length > 0) {
    detail = counts.join(" ");
  } else if (change.kind === "modified") {
    detail = "byte-level changes only";
  } else {
    detail = "empty file";
  }
  return `- ${change.path} (${change.kind}: ${detail})`;
}

function buildHunks(operations, contextLines) {
  const hunks = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index].type === "equal") {
      continue;
    }
    const start = Math.max(0, index - contextLines);
    const end = Math.min(operations.length, index + contextLines + 1);
    const previous = hunks[hunks.length - 1];
    if (previous && start <= previous.end) {
      previous.end = end;
    } else {
      hunks.push({ start, end });
    }
  }
  return hunks;
}

function formatRange(start, count) {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function* hunkLines(operations, hunks) {
  const prefixes = { equal: " ", delete: "-", insert: "+" };
  let consumedBefore = 0;
  let consumedAfter = 0;
  let index = 0;

  for (const { start, end } of hunks) {
    for (; index < start; index += 1) {
      const { type } = operations[index];
      consumedBefore += type === "insert" ? 0 : 1;
      consumedAfter += type === "delete" ? 0 : 1;
    }

    let beforeCount = 0;
    let afterCount = 0;
    for (let cursor = start; cursor < end; cursor += 1) {
      const { type } = operations[cursor];
      beforeCount += type === "insert" ? 0 : 1;
      afterCount += type === "delete" ? 0 : 1;
    }
    yield `@@ -${formatRange(
      beforeCount === 0 ? consumedBefore : consumedBefore + 1,
      beforeCount,
    )} +${formatRange(
      afterCount === 0 ? consumedAfter : consumedAfter + 1,
      afterCount,
    )} @@`;

    for (; index < end; index += 1) {
      const { type, line } = operations[index];
      yield `${prefixes[type]}${line}`;
      consumedBefore += type === "insert" ? 0 : 1;
      consumedAfter += type === "delete" ? 0 : 1;
    }
  }
}

function boundLineLength(line, maxLineLength) {
  // The first character is the diff marker; the bound applies to the content.
  const keep = maxLineLength + 1;
  if (line.length <= keep) {
    return line;
  }
  return `${line.slice(0, keep)} …[${line.length - keep} more characters]`;
}

export function formatFileDiff(change, limits = {}) {
  const { contextLines, maxLinesPerFile, maxLineLength } =
    resolveLimits(limits);
  const lines = [
    `--- ${change.kind === "added" ? "/dev/null" : `a/${change.path}`}`,
    `+++ ${change.kind === "removed" ? "/dev/null" : `b/${change.path}`}`,
  ];

  if (change.binary) {
    lines.push(
      `Binary content differs (${change.beforeBytes} → ${change.afterBytes} bytes).`,
    );
    return lines;
  }

  const hunks = buildHunks(change.operations, contextLines);
  if (hunks.length === 0) {
    lines.push(
      change.kind === "modified"
        ? "(no line-level differences; the bytes differ, e.g. encoding or byte-order mark)"
        : "(empty file)",
    );
    return lines;
  }

  const totalHunkLines = hunks.reduce(
    (sum, { start, end }) => sum + 1 + end - start,
    0,
  );
  let rendered = 0;
  for (const line of hunkLines(change.operations, hunks)) {
    if (rendered >= maxLinesPerFile) {
      lines.push(
        `... ${totalHunkLines - rendered} more diff line(s) omitted for ${change.path} (showing ${rendered} of ${totalHunkLines}; limit ${maxLinesPerFile} per file)`,
      );
      break;
    }
    lines.push(boundLineLength(line, maxLineLength));
    rendered += 1;
  }
  return lines;
}

export function formatDriftReport({ before, after, paths, limits = {} }) {
  const resolvedLimits = resolveLimits(limits);
  const changes = paths.map((path) =>
    describeGeneratedChange(
      path,
      before.get(path),
      after.get(path),
      resolvedLimits,
    ),
  );

  const output = changes.map(summarizeGeneratedChange);
  output.push(
    "",
    `Regeneration diff (a/ = current files, b/ = regenerated output; showing at most ${resolvedLimits.maxLinesPerFile} lines per file and ${resolvedLimits.maxTotalLines} lines in total):`,
  );

  let remaining = resolvedLimits.maxTotalLines;
  for (let index = 0; index < changes.length; index += 1) {
    const fileLines = formatFileDiff(changes[index], resolvedLimits);
    // Each file is preceded by one blank separator line that counts too.
    if (fileLines.length + 1 <= remaining) {
      output.push("", ...fileLines);
      remaining -= fileLines.length + 1;
      continue;
    }

    const shown = Math.max(0, remaining - 1);
    if (shown > 0) {
      output.push("", ...fileLines.slice(0, shown));
    }
    const omittedFiles = changes.length - index - 1;
    output.push(
      `... total diff limit of ${resolvedLimits.maxTotalLines} lines reached; ${fileLines.length - shown} more line(s) of ${changes[index].path} and ${omittedFiles} more changed file(s) omitted (every changed file is listed above).`,
    );
    break;
  }

  return output.join("\n");
}
