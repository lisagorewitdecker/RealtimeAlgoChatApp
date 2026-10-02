// Renders a bounded, human-readable unified diff between the generated API
// client files as they existed before regeneration and the freshly generated
// output. It is used by check-generated.mjs to explain drift failures and has
// no dependencies beyond Node.js built-ins.

const noTrailingNewlineMarker = "\\ No newline at end of file";
const binarySampleBytes = 8000;
const whitespaceMarkers = Object.freeze({
  space: { symbol: "·", description: "space" },
  tab: { symbol: "⇥", description: "tab" },
  carriageReturn: { symbol: "␍", description: "carriage return" },
  verticalTab: { symbol: "␋", description: "vertical tab" },
  formFeed: { symbol: "␌", description: "form feed" },
  nonBreakingSpace: { symbol: "⍽", description: "non-breaking space" },
});

export const defaultDriftReportLimits = Object.freeze({
  // Lines of unchanged context shown around each change.
  contextLines: 3,
  // Hunk lines (headers and content) rendered per changed file.
  maxLinesPerFile: 200,
  // Total lines rendered for the complete failure, including its heading,
  // file summaries, diff explanation, omission markers, and repair guidance.
  maxTotalLines: 1000,
  // Characters kept from a single line before it is elided.
  maxLineLength: 240,
  // Largest edit script searched exactly; beyond it the changed region is
  // reported as one replaced block so pathological rewrites stay fast.
  maxEditDistance: 2000,
});

function resolveLimits(limits) {
  const resolved = { ...defaultDriftReportLimits, ...limits };
  if (
    !Number.isInteger(resolved.maxTotalLines) ||
    resolved.maxTotalLines < 8
  ) {
    throw new RangeError("maxTotalLines must be an integer of at least 8");
  }
  return resolved;
}

function isBinary(buffer) {
  return buffer.subarray(0, binarySampleBytes).includes(0);
}

function normalizeWhitespace(line) {
  return line.replace(/\s/g, "");
}

function annotateWhitespaceOnlyPairs(operations) {
  for (let start = 0; start < operations.length; start += 1) {
    if (operations[start].type === "equal") {
      continue;
    }
    let end = start;
    while (end < operations.length && operations[end].type !== "equal") {
      end += 1;
    }
    const deletions = operations
      .slice(start, end)
      .filter(({ type }) => type === "delete");
    const insertions = operations
      .slice(start, end)
      .filter(({ type }) => type === "insert");
    const unmatchedInsertions = new Set(insertions);
    for (const deletion of deletions) {
      const insertion = insertions.find(
        (candidate) =>
          unmatchedInsertions.has(candidate) &&
          deletion.line !== candidate.line &&
          normalizeWhitespace(deletion.line) ===
            normalizeWhitespace(candidate.line),
      );
      if (insertion) {
        deletion.whitespaceOnly = true;
        insertion.whitespaceOnly = true;
        unmatchedInsertions.delete(insertion);
      }
    }
    start = end - 1;
  }
  return operations;
}

function isWhitespaceOnlyChange(operations) {
  const deletions = operations
    .filter(({ type }) => type === "delete")
    .map(({ line }) => normalizeWhitespace(line));
  const insertions = operations
    .filter(({ type }) => type === "insert")
    .map(({ line }) => normalizeWhitespace(line));
  return (
    deletions.length > 0 &&
    insertions.length > 0 &&
    deletions.length === insertions.length &&
    deletions.every((line, index) => line === insertions[index])
  );
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

  const operations = annotateWhitespaceOnlyPairs(
    diffLines(
      before ? splitLines(before.toString("utf8")) : [],
      after ? splitLines(after.toString("utf8")) : [],
      maxEditDistance,
    ),
  );
  for (const operation of operations) {
    if (operation.type === "insert") {
      change.insertions += 1;
    } else if (operation.type === "delete") {
      change.deletions += 1;
    }
  }
  return {
    ...change,
    operations,
    whitespaceOnly: kind === "modified" && isWhitespaceOnlyChange(operations),
  };
}

function elidePath(path, maxLength) {
  if (path.length <= maxLength) {
    return path;
  }
  if (maxLength <= 1) {
    return "…".slice(0, maxLength);
  }
  const suffixLength = Math.ceil((maxLength - 1) / 2);
  const prefixLength = maxLength - 1 - suffixLength;
  return `${path.slice(0, prefixLength)}…${path.slice(-suffixLength)}`;
}

function formatPathLine(prefix, path, suffix, maxLineLength) {
  // Path-bearing report lines use the same extra marker column as diff lines.
  const width = maxLineLength + 1;
  const pathWidth = Math.max(1, width - prefix.length - suffix.length);
  return `${prefix}${elidePath(path, pathWidth)}${suffix}`;
}

export function summarizeGeneratedChange(change, limits = {}) {
  const { maxLineLength } = resolveLimits(limits);
  const counts = [
    change.insertions > 0 ? `+${change.insertions}` : null,
    change.deletions > 0 ? `-${change.deletions}` : null,
  ].filter(Boolean);
  let detail;
  if (change.binary) {
    detail = `binary, ${change.beforeBytes} → ${change.afterBytes} bytes`;
  } else if (counts.length > 0) {
    detail = `${counts.join(" ")}${change.whitespaceOnly ? ", whitespace-only changes" : ""}`;
  } else if (change.kind === "modified") {
    detail = "byte-level changes only";
  } else {
    detail = "empty file";
  }
  return formatPathLine(
    "- ",
    change.path,
    ` (${change.kind}: ${detail})`,
    maxLineLength,
  );
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
    yield {
      text: `@@ -${formatRange(
      beforeCount === 0 ? consumedBefore : consumedBefore + 1,
      beforeCount,
    )} +${formatRange(
      afterCount === 0 ? consumedAfter : consumedAfter + 1,
      afterCount,
      )} @@`,
      markers: new Map(),
    };

    for (; index < end; index += 1) {
      const { type, line, whitespaceOnly } = operations[index];
      const annotation = whitespaceOnly ? "  [whitespace-only change]" : "";
      const rendered = renderInvisibleWhitespace(line);
      yield {
        text: `${prefixes[type]}${rendered.text}${annotation}`,
        markers: rendered.markers,
      };
      consumedBefore += type === "insert" ? 0 : 1;
      consumedAfter += type === "delete" ? 0 : 1;
    }
  }
}

function renderInvisibleWhitespace(line) {
  if (line === noTrailingNewlineMarker) {
    return { text: line, markers: new Map() };
  }
  const markers = new Map();
  const mark = (key) => {
    const marker = whitespaceMarkers[key];
    markers.set(marker.symbol, marker.description);
    return marker.symbol;
  };
  const visibleCharacter = (character) => {
    if (character === " ") return mark("space");
    if (character === "\t") return mark("tab");
    if (character === "\r") return mark("carriageReturn");
    if (character === "\v") return mark("verticalTab");
    if (character === "\f") return mark("formFeed");
    if (character === "\u00a0") return mark("nonBreakingSpace");
    const codePoint = character.codePointAt(0).toString(16).padStart(4, "0");
    const symbol = `\\u{${codePoint}}`;
    markers.set(symbol, `U+${codePoint.toUpperCase()} whitespace`);
    return symbol;
  };
  const visibleTrailingWhitespace = line.replace(
    /[^\S\n]+$/u,
    (whitespace) => [...whitespace].map(visibleCharacter).join(""),
  );
  const text = visibleTrailingWhitespace
    .replace(/\t/g, () => mark("tab"))
    .replace(/\r/g, () => mark("carriageReturn"));
  return { text, markers };
}

function boundLineLength(line, maxLineLength) {
  // The first character is the diff marker; the bound applies to the content.
  const keep = maxLineLength + 1;
  if (line.length <= keep) {
    return line;
  }
  return `${line.slice(0, keep)} …[${line.length - keep} more characters]`;
}

function boundRenderedLine({ text, markers }, maxLineLength) {
  let keep = maxLineLength + 1;
  if (text.length <= keep) {
    return text;
  }
  for (const symbol of markers.keys()) {
    let index = text.indexOf(symbol);
    while (index !== -1) {
      if (index < keep && index + symbol.length > keep) {
        keep = index;
        break;
      }
      index = text.indexOf(symbol, index + symbol.length);
    }
  }
  return `${text.slice(0, keep)} …[${text.length - keep} more characters]`;
}

function wrapWhitespaceLegend(markers, maxLineLength) {
  const prefix = "Whitespace: ";
  const width = maxLineLength + 1;
  const entries = [...markers].map(
    ([symbol, description]) => `${symbol} ${description}`,
  );
  const lines = [];
  for (const entry of entries) {
    const candidate =
      lines.length === 0 ? `${prefix}${entry}` : `${lines.at(-1)}; ${entry}`;
    if (candidate.length <= width || lines.length === 0) {
      if (lines.length === 0) {
        lines.push(candidate);
      } else {
        lines[lines.length - 1] = candidate;
      }
    } else {
      lines.push(`${prefix}${entry}`);
    }
  }
  return lines;
}

function formatFileDiffDetails(change, limits = {}, includeLegend = true) {
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
    return { lines, markersByLine: lines.map(() => new Map()) };
  }

  const hunks = buildHunks(change.operations, contextLines);
  if (hunks.length === 0) {
    lines.push(
      change.kind === "modified"
        ? "(no line-level differences; the bytes differ, e.g. encoding or byte-order mark)"
        : "(empty file)",
    );
    return { lines, markersByLine: lines.map(() => new Map()) };
  }

  const totalHunkLines = hunks.reduce(
    (sum, { start, end }) => sum + 1 + end - start,
    0,
  );
  const allHunkLines = [...hunkLines(change.operations, hunks)];
  let renderedLines = allHunkLines.slice(0, maxLinesPerFile);
  let boundedRenderedLines = [];
  let renderedMarkers = new Map();
  let legendLines = [];
  while (true) {
    boundedRenderedLines = renderedLines.map((line) => ({
      text: boundRenderedLine(line, maxLineLength),
      markers: line.markers,
    }));
    renderedMarkers = new Map();
    for (const { text, markers } of boundedRenderedLines) {
      for (const [symbol, description] of markers) {
        if (text.includes(symbol)) {
          renderedMarkers.set(symbol, description);
        }
      }
    }
    legendLines = includeLegend
      ? wrapWhitespaceLegend(renderedMarkers, maxLineLength)
      : [];
    const allowedHunkLines = Math.max(
      0,
      maxLinesPerFile - legendLines.length,
    );
    if (renderedLines.length <= allowedHunkLines) {
      break;
    }
    renderedLines = renderedLines.slice(0, allowedHunkLines);
  }
  lines.push(...legendLines);
  const markersByLine = [
    new Map(),
    new Map(),
    ...legendLines.map(() => new Map()),
  ];
  for (const { text } of boundedRenderedLines) {
    lines.push(text);
  }
  markersByLine.push(...boundedRenderedLines.map(({ markers }) => markers));
  const rendered = renderedLines.length + legendLines.length;
  if (renderedLines.length < totalHunkLines) {
    lines.push(
      formatPathLine(
        `... ${totalHunkLines - renderedLines.length} more diff line(s) omitted for `,
        change.path,
        ` (showing ${rendered} of ${totalHunkLines + legendLines.length}; limit ${maxLinesPerFile} per file)`,
        maxLineLength,
      ),
    );
    markersByLine.push(new Map());
  }
  return { lines, markersByLine };
}

function usefulPrefixLength(change, fileLines) {
  if (change.binary || change.operations.every(({ type }) => type === "equal")) {
    return fileLines.length;
  }
  const changedLine = fileLines.findIndex(
    (line, index) =>
      index >= 2 && (line.startsWith("+") || line.startsWith("-")),
  );
  return changedLine === -1 ? fileLines.length : changedLine + 1;
}

function allocateFileLines(changes, fileDetails, budget) {
  const allocations = new Array(changes.length).fill(0);
  const usefulLengths = changes.map((change, index) =>
    usefulPrefixLength(change, fileDetails[index].lines),
  );
  const usefulCost = usefulLengths.reduce(
    (sum, length) => sum + (length > 0 ? length + 1 : 0),
    0,
  );

  if (usefulCost <= budget) {
    for (let index = 0; index < changes.length; index += 1) {
      allocations[index] = usefulLengths[index];
    }
  } else {
    // If every useful excerpt cannot fit, retain deterministic file order and
    // give each reached file as much of its useful prefix as remains.
    let remaining = budget;
    for (let index = 0; index < changes.length && remaining > 1; index += 1) {
      const shown = Math.min(usefulLengths[index], remaining - 1);
      allocations[index] = shown;
      remaining -= shown + 1;
      if (shown < usefulLengths[index]) break;
    }
    return allocations;
  }

  let remaining =
    budget -
    allocations.reduce(
      (sum, length) => sum + (length > 0 ? length + 1 : 0),
      0,
    );
  for (let index = 0; index < changes.length && remaining > 0; index += 1) {
    const available = fileDetails[index].lines.length - allocations[index];
    const added = Math.min(available, remaining);
    allocations[index] += added;
    remaining -= added;
  }
  return allocations;
}

export function formatFileDiff(change, limits = {}) {
  return formatFileDiffDetails(change, limits).lines;
}

export function formatDriftReport({
  before,
  after,
  paths,
  limits = {},
  heading = "Generated API drift detected after regeneration:",
  repairInstruction =
    "Run `pnpm --filter @workspace/api-spec run codegen` and commit the generated output.",
}) {
  const resolvedLimits = resolveLimits(limits);
  const changes = paths.map((path) =>
    describeGeneratedChange(
      path,
      before.get(path),
      after.get(path),
      resolvedLimits,
    ),
  );

  const summaryLines = changes.map((change) =>
    summarizeGeneratedChange(change, resolvedLimits),
  );
  const output = [
    heading,
    "",
  ];
  const fixedTail = [
    "",
    `Regeneration diff (a/ = current files, b/ = regenerated output; showing at most ${resolvedLimits.maxLinesPerFile} lines per file within the ${resolvedLimits.maxTotalLines}-line complete failure limit):`,
    "",
    repairInstruction,
  ];
  const summaryBudget = Math.max(
    0,
    // Reserve one line for the complete-report omission marker. When the
    // report fits, that unused line simply remains available to diff content.
    resolvedLimits.maxTotalLines - output.length - fixedTail.length - 1,
  );
  const shownSummaryCount =
    summaryLines.length <= summaryBudget
      ? summaryLines.length
      : Math.max(0, summaryBudget - 1);
  output.push(...summaryLines.slice(0, shownSummaryCount));
  if (shownSummaryCount < summaryLines.length) {
    output.push(
      `... ${summaryLines.length - shownSummaryCount} more changed file summary line(s) omitted (showing first ${shownSummaryCount} of ${summaryLines.length} changed files).`,
    );
  }
  output.push(...fixedTail.slice(0, 2));

  const fileDetails = changes.map((change) =>
    formatFileDiffDetails(change, resolvedLimits, false),
  );
  let legendLines = [];
  let allocations = [];
  const seenLegends = new Set();
  while (true) {
    seenLegends.add(legendLines.join("\n"));
    allocations = allocateFileLines(
      changes,
      fileDetails,
      Math.max(
        0,
        resolvedLimits.maxTotalLines -
          output.length -
          2 -
          legendLines.length -
          (legendLines.length > 0 ? 1 : 0) -
          1,
      ),
    );
    const shownMarkers = new Map();
    for (let index = 0; index < changes.length; index += 1) {
      const { lines: fileLines, markersByLine } = fileDetails[index];
      const shown = allocations[index];
      if (shown > 0) {
        for (let lineIndex = 0; lineIndex < shown; lineIndex += 1) {
          for (const [symbol, description] of markersByLine[lineIndex]) {
            if (fileLines[lineIndex].includes(symbol)) {
              shownMarkers.set(symbol, description);
            }
          }
        }
      }
    }
    const nextLegendLines = wrapWhitespaceLegend(
      shownMarkers,
      resolvedLimits.maxLineLength,
    );
    if (
      nextLegendLines.length === legendLines.length &&
      nextLegendLines.every((line, index) => line === legendLines[index])
    ) {
      legendLines = nextLegendLines;
      break;
    }
    if (seenLegends.has(nextLegendLines.join("\n"))) {
      // A marker exactly at the budget boundary can alternate between being
      // shown without a legend and hidden when its legend reserves a line.
      // Keep the legend-reserving state so no rendered marker is unexplained.
      break;
    }
    legendLines = nextLegendLines;
  }

  if (legendLines.length > 0) {
    output.push("", ...legendLines);
  }
  let omittedLines = 0;
  let omittedFiles = 0;
  for (let index = 0; index < changes.length; index += 1) {
    const fileLines = fileDetails[index].lines;
    const shown = allocations[index];
    if (shown > 0) {
      output.push("", ...fileLines.slice(0, shown));
    }
    if (shown < fileLines.length) {
      omittedLines += fileLines.length - shown;
      omittedFiles += 1;
    }
  }
  if (omittedFiles > 0) {
    output.push(
      `... complete generated-drift failure limit of ${resolvedLimits.maxTotalLines} lines reached; ${omittedLines} more diff line(s) across ${omittedFiles} changed file(s) omitted.`,
    );
  }

  output.push("", repairInstruction);
  return output.join("\n");
}
