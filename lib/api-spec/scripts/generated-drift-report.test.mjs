import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultDriftReportLimits,
  describeGeneratedChange,
  diffLines,
  formatDriftReport,
  formatFileDiff,
  splitLines,
  summarizeGeneratedChange,
} from "./generated-drift-report.mjs";

function numberedLines(count, label = "line") {
  return Array.from({ length: count }, (_, index) => `${label} ${index + 1}`);
}

function fileFromLines(lines) {
  return Buffer.from(`${lines.join("\n")}\n`);
}

function reconstruct(operations) {
  const before = [];
  const after = [];
  for (const { type, line } of operations) {
    if (type !== "insert") {
      before.push(line);
    }
    if (type !== "delete") {
      after.push(line);
    }
  }
  return { before, after };
}

function editCount(operations) {
  return operations.filter(({ type }) => type !== "equal").length;
}

function minimalEditCount(before, after) {
  const table = Array.from({ length: before.length + 1 }, () =>
    new Array(after.length + 1).fill(0),
  );
  for (let i = 1; i <= before.length; i += 1) {
    for (let j = 1; j <= after.length; j += 1) {
      table[i][j] =
        before[i - 1] === after[j - 1]
          ? table[i - 1][j - 1] + 1
          : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return before.length + after.length - 2 * table[before.length][after.length];
}

function createGenerator(seed) {
  let state = seed;
  return (bound) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % bound;
  };
}

test("splitLines keeps every line and marks a missing trailing newline", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\n\nb\n"), ["a", "", "b"]);
  assert.deepEqual(splitLines("a\nb"), [
    "a",
    "b",
    "\\ No newline at end of file",
  ]);
});

test("diffLines produces a minimal edit script that reconstructs both sides", () => {
  assert.deepEqual(diffLines(["a", "b"], ["a", "b"]), [
    { type: "equal", line: "a" },
    { type: "equal", line: "b" },
  ]);
  assert.deepEqual(diffLines(["a", "b", "c"], ["a", "x", "c", "d"]), [
    { type: "equal", line: "a" },
    { type: "delete", line: "b" },
    { type: "insert", line: "x" },
    { type: "equal", line: "c" },
    { type: "insert", line: "d" },
  ]);
  assert.deepEqual(diffLines([], ["only"]), [{ type: "insert", line: "only" }]);
  assert.deepEqual(diffLines(["only"], []), [{ type: "delete", line: "only" }]);

  const random = createGenerator(7);
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const alphabet = 1 + random(4);
    const before = Array.from({ length: random(12) }, () =>
      String.fromCharCode(97 + random(alphabet)),
    );
    const after = Array.from({ length: random(12) }, () =>
      String.fromCharCode(97 + random(alphabet)),
    );
    const operations = diffLines(before, after);
    assert.deepEqual(reconstruct(operations), { before, after });
    assert.equal(
      editCount(operations),
      minimalEditCount(before, after),
      `edit script for ${JSON.stringify({ before, after })} is not minimal`,
    );
  }
});

test("diffLines falls back to a block replacement past the edit distance cap", () => {
  const before = numberedLines(40);
  // Change every other line while keeping the first and last lines intact.
  const after = before.map((line, index) =>
    index > 0 && index < before.length - 1 && index % 2 === 1
      ? `${line} changed`
      : line,
  );
  const operations = diffLines(before, after, 3);
  assert.deepEqual(reconstruct(operations), { before, after });
  assert.ok(
    editCount(operations) > minimalEditCount(before, after),
    "the capped fallback should be a coarser (non-minimal) edit script",
  );
  assert.equal(operations[0].type, "equal", "shared prefix is preserved");
  assert.equal(
    operations[operations.length - 1].type,
    "equal",
    "shared suffix is preserved",
  );
});

test("summaries report change kinds with line counts", () => {
  const summaries = [
    describeGeneratedChange(
      "lib/api-zod/src/generated/api.ts",
      fileFromLines(["a", "b", "c"]),
      fileFromLines(["a", "B", "c", "d"]),
    ),
    describeGeneratedChange(
      "lib/api-zod/src/generated/new.ts",
      undefined,
      fileFromLines(["fresh", "file"]),
    ),
    describeGeneratedChange(
      "lib/api-zod/src/generated/old.ts",
      fileFromLines(["gone"]),
      undefined,
    ),
    describeGeneratedChange(
      "lib/api-zod/src/generated/binary.bin",
      Buffer.from([0, 1, 2]),
      Buffer.from([0, 1, 2, 3]),
    ),
    describeGeneratedChange(
      "lib/api-zod/src/generated/bytes.ts",
      Buffer.from([0xff, 0x0a]),
      Buffer.from([0xfe, 0x0a]),
    ),
    describeGeneratedChange(
      "lib/api-zod/src/generated/empty.ts",
      undefined,
      Buffer.alloc(0),
    ),
  ].map(summarizeGeneratedChange);

  assert.deepEqual(summaries, [
    "- lib/api-zod/src/generated/api.ts (modified: +2 -1)",
    "- lib/api-zod/src/generated/new.ts (added: +2)",
    "- lib/api-zod/src/generated/old.ts (removed: -1)",
    "- lib/api-zod/src/generated/binary.bin (modified: binary, 3 → 4 bytes)",
    "- lib/api-zod/src/generated/bytes.ts (modified: byte-level changes only)",
    "- lib/api-zod/src/generated/empty.ts (added: empty file)",
  ]);
});

test("file diffs use unified hunks with context and merged nearby changes", () => {
  const before = numberedLines(30);
  const after = [...before];
  after[9] = "line 10 changed";
  after.splice(12, 0, "inserted after line 12");
  after.splice(27, 1);

  const lines = formatFileDiff(
    describeGeneratedChange(
      "lib/api-client-react/src/generated/api.ts",
      fileFromLines(before),
      fileFromLines(after),
    ),
  );

  assert.deepEqual(lines, [
    "--- a/lib/api-client-react/src/generated/api.ts",
    "+++ b/lib/api-client-react/src/generated/api.ts",
    "@@ -7,9 +7,10 @@",
    " line 7",
    " line 8",
    " line 9",
    "-line 10",
    "+line 10 changed",
    " line 11",
    " line 12",
    "+inserted after line 12",
    " line 13",
    " line 14",
    " line 15",
    "@@ -24,7 +25,6 @@",
    " line 24",
    " line 25",
    " line 26",
    "-line 27",
    " line 28",
    " line 29",
    " line 30",
  ]);
});

test("file diffs describe added, removed, binary, and unchanged-line files", () => {
  assert.deepEqual(
    formatFileDiff(
      describeGeneratedChange(
        "lib/api-zod/src/generated/new.ts",
        undefined,
        fileFromLines(["fresh", "file"]),
      ),
    ),
    [
      "--- /dev/null",
      "+++ b/lib/api-zod/src/generated/new.ts",
      "@@ -0,0 +1,2 @@",
      "+fresh",
      "+file",
    ],
  );
  assert.deepEqual(
    formatFileDiff(
      describeGeneratedChange(
        "lib/api-zod/src/generated/old.ts",
        fileFromLines(["gone"]),
        undefined,
      ),
    ),
    [
      "--- a/lib/api-zod/src/generated/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
    ],
  );
  assert.deepEqual(
    formatFileDiff(
      describeGeneratedChange(
        "lib/api-zod/src/generated/binary.bin",
        Buffer.from([0, 1, 2]),
        Buffer.from([0, 1, 2, 3]),
      ),
    ),
    [
      "--- a/lib/api-zod/src/generated/binary.bin",
      "+++ b/lib/api-zod/src/generated/binary.bin",
      "Binary content differs (3 → 4 bytes).",
    ],
  );
  assert.match(
    formatFileDiff(
      describeGeneratedChange(
        "lib/api-zod/src/generated/bytes.ts",
        Buffer.from([0xff, 0x0a]),
        Buffer.from([0xfe, 0x0a]),
      ),
    ).join("\n"),
    /no line-level differences; the bytes differ/,
  );
  assert.deepEqual(
    formatFileDiff(
      describeGeneratedChange(
        "lib/api-zod/src/generated/trailing.ts",
        Buffer.from("a\nb"),
        Buffer.from("a\nb\n"),
      ),
    ).slice(2),
    ["@@ -1,3 +1,2 @@", " a", " b", "-\\ No newline at end of file"],
  );
});

test("file diffs expose whitespace-only changes and invisible characters", () => {
  const change = describeGeneratedChange(
    "lib/api-zod/src/generated/whitespace.ts",
    Buffer.from("const value =\t1;  \r\nnext\u00a0\r\n"),
    Buffer.from("const value = 1;\nnext\n"),
  );

  assert.equal(change.whitespaceOnly, true);
  assert.equal(
    summarizeGeneratedChange(change),
    "- lib/api-zod/src/generated/whitespace.ts (modified: +2 -2, whitespace-only changes)",
  );
  assert.deepEqual(formatFileDiff(change).slice(2), [
    "Whitespace: · space; ␍ carriage return; ⇥ tab; ⍽ non-breaking space",
    "@@ -1,2 +1,2 @@",
    "-const value =⇥1;··␍  [whitespace-only change]",
    "-next⍽␍  [whitespace-only change]",
    "+const value = 1;  [whitespace-only change]",
    "+next  [whitespace-only change]",
  ]);
});

test("mixed content and whitespace changes do not get a whitespace-only summary", () => {
  const change = describeGeneratedChange(
    "lib/api-zod/src/generated/mixed.ts",
    fileFromLines(["const spaced =\t1;", "old value"]),
    fileFromLines(["const spaced = 1;", "new value"]),
  );

  assert.equal(change.whitespaceOnly, false);
  assert.doesNotMatch(summarizeGeneratedChange(change), /whitespace-only/);
  const rendered = formatFileDiff(change).join("\n");
  assert.match(
    rendered,
    /-const spaced =⇥1;  \[whitespace-only change\]/,
  );
  assert.match(rendered, /^-old value$/m);
  assert.match(rendered, /^\+new value$/m);
});

test("whitespace legends explain uncommon markers actually rendered", () => {
  const uncommon = describeGeneratedChange(
    "lib/api-zod/src/generated/uncommon.ts",
    Buffer.from("value\v\f\u2003\n"),
    Buffer.from("value\n"),
  );
  assert.deepEqual(formatFileDiff(uncommon).slice(2), [
    "Whitespace: ␋ vertical tab; ␌ form feed; \\u{2003} U+2003 whitespace",
    "@@ -1 +1 @@",
    "-value␋␌\\u{2003}  [whitespace-only change]",
    "+value  [whitespace-only change]",
  ]);

  const ordinary = formatFileDiff(
    describeGeneratedChange(
      "lib/api-zod/src/generated/ordinary.ts",
      fileFromLines(["old"]),
      fileFromLines(["new"]),
    ),
  ).join("\n");
  assert.doesNotMatch(ordinary, /Whitespace:/);
});

test("long whitespace legends wrap without losing marker explanations", () => {
  const whitespace = "\u2000\u2001\u2002\u2003\u2004\u2005\u2006";
  const lines = formatFileDiff(
    describeGeneratedChange(
      "lib/api-zod/src/generated/many-spaces.ts",
      Buffer.from(`value${whitespace}\n`),
      Buffer.from("value\n"),
    ),
    { maxLineLength: 90 },
  );
  const rendered = lines.join("\n");
  for (let codePoint = 0x2000; codePoint <= 0x2006; codePoint += 1) {
    const hex = codePoint.toString(16);
    assert.match(rendered, new RegExp(`\\\\u\\{${hex}\\} U\\+${hex.toUpperCase()} whitespace`));
  }
  assert.ok(
    lines.filter((line) => line.startsWith("Whitespace:")).length > 1,
    "the legend wraps across bounded lines",
  );
  assert.ok(lines.every((line) => line.length <= 91 || line.startsWith("... ")));
});

test("whitespace legends stay within per-file and total output budgets", () => {
  const path = "lib/api-zod/src/generated/whitespace.ts";
  const before = new Map([[path, fileFromLines(["old\t", "second"])]]);
  const after = new Map([[path, fileFromLines(["new", "changed"])]]);
  const change = describeGeneratedChange(path, before.get(path), after.get(path));

  const fileLines = formatFileDiff(change, { maxLinesPerFile: 3 });
  assert.deepEqual(fileLines.slice(2), [
    "Whitespace: ⇥ tab",
    "@@ -1,2 +1,2 @@",
    "-old⇥",
    `... 3 more diff line(s) omitted for ${path} (showing 3 of 6; limit 3 per file)`,
  ]);

  const report = formatDriftReport({
    before,
    after,
    paths: [path],
    limits: { maxLinesPerFile: 3, maxTotalLines: 4 },
  });
  const diffLines = report.split("\n").slice(
    report.split("\n").findIndex((line) => line.startsWith("Regeneration diff")) + 1,
  );
  assert.equal(diffLines.length, 5);
  assert.doesNotMatch(
    diffLines.join("\n"),
    /Whitespace:/,
    "the report does not spend its budget explaining a marker it cannot show",
  );
  assert.match(diffLines.at(-1), /total diff limit of 4 lines reached/);

  const boundaryReport = formatDriftReport({
    before,
    after,
    paths: [path],
    limits: { maxLinesPerFile: 3, maxTotalLines: 5 },
  });
  assert.match(
    boundaryReport,
    /Whitespace: ⇥ tab/,
    "a marker at the budget boundary cannot make legend selection oscillate",
  );
  assert.doesNotMatch(boundaryReport, /^-old⇥$/m);

  const hiddenMarker = formatFileDiff(
    describeGeneratedChange(
      path,
      fileFromLines([`${"x".repeat(40)}\t`]),
      fileFromLines(["changed"]),
    ),
    { maxLineLength: 10 },
  ).join("\n");
  assert.doesNotMatch(
    hiddenMarker,
    /Whitespace:/,
    "markers removed by line-length elision are not advertised",
  );

  const atomicMarker = formatFileDiff(
    describeGeneratedChange(
      path,
      fileFromLines([`${"x".repeat(8)}\u2003`]),
      fileFromLines(["changed"]),
    ),
    { maxLineLength: 10 },
  ).join("\n");
  assert.doesNotMatch(atomicMarker, /\\u\{20 \…/);
  assert.doesNotMatch(atomicMarker, /Whitespace:/);
});

test("drift reports consolidate repeated and file-specific whitespace markers", () => {
  const paths = ["first.ts", "second.ts", "third.ts"];
  const before = new Map([
    ["first.ts", fileFromLines(["one\t", "one more"])],
    ["second.ts", fileFromLines(["two\t", "two more"])],
    ["third.ts", fileFromLines(["three\u00a0", "three more"])],
  ]);
  const after = new Map([
    ["first.ts", fileFromLines(["one", "changed one"])],
    ["second.ts", fileFromLines(["two", "changed two"])],
    ["third.ts", fileFromLines(["three", "changed three"])],
  ]);

  const report = formatDriftReport({
    before,
    after,
    paths,
    limits: { maxLinesPerFile: 5, maxTotalLines: 28 },
  });
  const lines = report.split("\n");
  assert.equal(
    lines.filter((line) => line.startsWith("Whitespace:")).length,
    1,
  );
  assert.match(report, /Whitespace: ⇥ tab; ⍽ non-breaking space/);
  assert.equal((report.match(/^-one⇥  /gm) ?? []).length, 1);
  assert.equal((report.match(/^-two⇥  /gm) ?? []).length, 1);
  assert.match(report, /^-three⍽  /m);
  assert.doesNotMatch(
    report,
    /Whitespace: ⇥ tab[\s\S]*Whitespace: ⇥ tab/,
  );
});

test("file diffs are bounded per file while counts stay exact", () => {
  const change = describeGeneratedChange(
    "lib/api-client-react/src/generated/api.ts",
    fileFromLines(numberedLines(500)),
    fileFromLines(numberedLines(500, "regenerated")),
  );
  assert.equal(change.insertions, 500);
  assert.equal(change.deletions, 500);

  const lines = formatFileDiff(change, { maxLinesPerFile: 20 });
  // Two file headers, twenty hunk lines, one truncation marker.
  assert.equal(lines.length, 23);
  assert.equal(lines[2], "@@ -1,500 +1,500 @@");
  assert.equal(
    lines[lines.length - 1],
    "... 981 more diff line(s) omitted for lib/api-client-react/src/generated/api.ts (showing 20 of 1001; limit 20 per file)",
  );
  assert.equal(
    formatFileDiff(change).length,
    defaultDriftReportLimits.maxLinesPerFile + 3,
  );

  const exact = formatFileDiff(change, { maxLinesPerFile: 1001 });
  assert.equal(exact.length, 1003);
  assert.doesNotMatch(
    exact[exact.length - 1],
    /omitted/,
    "no marker is added when the diff fits exactly",
  );
});

test("file diffs elide overly long lines", () => {
  const lines = formatFileDiff(
    describeGeneratedChange(
      "lib/api-zod/src/generated/api.ts",
      fileFromLines(["short", "x".repeat(300), "short"]),
      fileFromLines(["short", "y".repeat(300), "short"]),
    ),
    { maxLineLength: 50 },
  );
  assert.deepEqual(lines.slice(2), [
    "@@ -1,3 +1,3 @@",
    " short",
    `-${"x".repeat(50)} …[250 more characters]`,
    `+${"y".repeat(50)} …[250 more characters]`,
    " short",
  ]);
});

test("drift reports list every changed file and honor the total line budget", () => {
  const before = new Map([
    [
      "lib/api-client-react/src/generated/api.ts",
      fileFromLines(numberedLines(60)),
    ],
    ["lib/api-zod/src/generated/api.ts", fileFromLines(numberedLines(60))],
    [
      "lib/api-zod/src/index.ts",
      fileFromLines(["export * from './generated/api';"]),
    ],
  ]);
  const after = new Map([
    [
      "lib/api-client-react/src/generated/api.ts",
      fileFromLines(numberedLines(60, "regenerated")),
    ],
    [
      "lib/api-zod/src/generated/api.ts",
      fileFromLines(numberedLines(60, "regenerated")),
    ],
    [
      "lib/api-zod/src/generated/newSchema.ts",
      fileFromLines(["export const schema = 1;"]),
    ],
  ]);
  const paths = [
    "lib/api-client-react/src/generated/api.ts",
    "lib/api-zod/src/generated/api.ts",
    "lib/api-zod/src/generated/newSchema.ts",
    "lib/api-zod/src/index.ts",
  ];

  const full = formatDriftReport({ before, after, paths });
  assert.match(
    full,
    /^- lib\/api-client-react\/src\/generated\/api\.ts \(modified: \+60 -60\)$/m,
  );
  assert.match(
    full,
    /^- lib\/api-zod\/src\/generated\/newSchema\.ts \(added: \+1\)$/m,
  );
  assert.match(full, /^- lib\/api-zod\/src\/index\.ts \(removed: -1\)$/m);
  assert.match(full, /a\/ = current files, b\/ = regenerated output/);
  assert.match(
    full,
    /^\+\+\+ b\/lib\/api-zod\/src\/generated\/newSchema\.ts$/m,
  );
  assert.match(full, /^\+export const schema = 1;$/m);
  assert.match(
    full,
    /^--- a\/lib\/api-zod\/src\/index\.ts\n\+\+\+ \/dev\/null$/m,
  );
  assert.doesNotMatch(full, /total diff limit/);

  const bounded = formatDriftReport({
    before,
    after,
    paths,
    limits: { maxLinesPerFile: 50, maxTotalLines: 70 },
  });
  const boundedLines = bounded.split("\n");
  const diffStart = boundedLines.findIndex((line) =>
    line.startsWith("Regeneration diff"),
  );
  // Summary lines for every file are always present, even when truncated.
  for (const path of paths) {
    assert.ok(
      boundedLines.some((line) => line.startsWith(`- ${path} (`)),
      `${path} is listed in the summary`,
    );
  }
  assert.equal(
    boundedLines.length - diffStart - 1,
    71,
    "the diff section is the total budget plus one truncation marker",
  );
  assert.equal(
    boundedLines[boundedLines.length - 1],
    "... total diff limit of 70 lines reached; 48 more line(s) across 1 changed file(s) omitted (every changed file is listed above).",
  );
});

test("drift reports reserve a concrete change from later files", () => {
  const paths = ["large.ts", "small-one.ts", "small-two.ts", "binary.bin", "empty.ts"];
  const before = new Map([
    ["large.ts", fileFromLines(numberedLines(100))],
    ["small-one.ts", fileFromLines(["old one"])],
    ["small-two.ts", fileFromLines(["old two"])],
    ["binary.bin", Buffer.from([0, 1])],
  ]);
  const after = new Map([
    ["large.ts", fileFromLines(numberedLines(100, "regenerated"))],
    ["small-one.ts", fileFromLines(["new one"])],
    ["small-two.ts", fileFromLines(["new two"])],
    ["binary.bin", Buffer.from([0, 1, 2])],
    ["empty.ts", Buffer.alloc(0)],
  ]);

  const report = formatDriftReport({
    before,
    after,
    paths,
    limits: { maxLinesPerFile: 50, maxTotalLines: 34 },
  });

  assert.match(report, /^-line 1$/m);
  assert.match(report, /^-old one$/m);
  assert.match(report, /^-old two$/m);
  assert.match(report, /Binary content differs \(2 → 3 bytes\)\./);
  assert.match(report, /^\+\+\+ b\/empty\.ts\n\(empty file\)$/m);
  assert.match(
    report,
    /total diff limit of 34 lines reached; 40 more line\(s\) across 3 changed file\(s\) omitted/,
  );
  const diffStart = report
    .split("\n")
    .findIndex((line) => line.startsWith("Regeneration diff"));
  assert.equal(
    report.split("\n").length - diffStart - 1,
    35,
    "the diff section remains the total budget plus one truncation marker",
  );
});
