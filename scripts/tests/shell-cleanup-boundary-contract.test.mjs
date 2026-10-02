import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const shellTestDirectory = path.join(workspaceRoot, "scripts/tests");

const removeCommandPattern =
  /(?:\brm|"?\$(?:\{(?<bracedName>[A-Za-z_][A-Za-z0-9_]*)\}|(?<plainName>[A-Za-z_][A-Za-z0-9_]*))"?)(?<options>(?:\s+(?:-[A-Za-z]+|--[A-Za-z-]+))+)/g;
const resolvedRmPattern =
  /^(?<name>[A-Za-z_][A-Za-z0-9_]*)=["']?\$\(command -v rm\)["']?\s*$/gm;
const guardDefinitionPattern =
  /^(?<name>[A-Za-z_][A-Za-z0-9_]*)=(?:"[^"\n]*cleanup-must-not-escape-fixtures[^"\n]*"|'[^'\n]*cleanup-must-not-escape-fixtures[^'\n]*')\s*$/m;

function validateCleanupBoundary(source, filename) {
  const resolvedRmNames = new Set(
    [...source.matchAll(resolvedRmPattern)].map((match) => match.groups.name),
  );
  const recursiveCleanup = [...source.matchAll(removeCommandPattern)].find(
    (match) => {
      const variableName = match.groups.bracedName ?? match.groups.plainName;
      if (variableName && !resolvedRmNames.has(variableName)) {
        return false;
      }
      return match.groups.options
          .trim()
          .split(/\s+/)
          .some(
            (option) =>
              option === "--recursive" ||
              (/^-[A-Za-z]+$/.test(option) && /[rR]/.test(option)),
          );
    },
  );
  if (!recursiveCleanup) {
    return;
  }

  const guardDefinition = guardDefinitionPattern.exec(source);
  assert.ok(
    guardDefinition,
    `${filename} recursively deletes fixtures but does not define an adjacent cleanup-must-not-escape-fixtures guard`,
  );

  const guardName = guardDefinition.groups.name.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const guardAssertionPattern = new RegExp(
    String.raw`\[\[\s+!\s+-[ef]\s+"\$\{?${guardName}\}?"\s+\]\]`,
  );
  const sourceAfterFirstCleanup = source.slice(
    recursiveCleanup.index + recursiveCleanup[0].length,
  );
  assert.match(
    sourceAfterFirstCleanup,
    guardAssertionPattern,
    `${filename} recursively deletes fixtures but does not assert its cleanup boundary guard survived after cleanup`,
  );
}

test("cleanup boundary validation allows shell suites without recursive deletion", () => {
  assert.doesNotThrow(() => {
    validateCleanupBoundary(
      `#!/usr/bin/env bash\nrm -f "$test_root/result.txt"\n`,
      "safe.test.sh",
    );
  });
});

test("cleanup boundary validation rejects recursive deletion without a guard", () => {
  assert.throws(
    () => {
      validateCleanupBoundary(
        `#!/usr/bin/env bash\ntrap 'rm -rf "$test_root"' EXIT\n`,
        "unguarded.test.sh",
      );
    },
    /does not define an adjacent cleanup-must-not-escape-fixtures guard/,
  );
});

test("cleanup boundary validation recognizes separately supplied recursive flags", () => {
  assert.throws(
    () => {
      validateCleanupBoundary(
        `#!/usr/bin/env bash\nrm --force -r "$test_root"\n`,
        "separate-options.test.sh",
      );
    },
    /does not define an adjacent cleanup-must-not-escape-fixtures guard/,
  );
});

test("cleanup boundary validation rejects recursive deletion through a resolved rm variable", () => {
  assert.throws(
    () => {
      validateCleanupBoundary(
        [
          "#!/usr/bin/env bash",
          'RM_BIN="$(command -v rm)"',
          'trap \'"$RM_BIN" -rf "$test_parent"\' EXIT',
          "",
        ].join("\n"),
        "resolved-rm.test.sh",
      );
    },
    /does not define an adjacent cleanup-must-not-escape-fixtures guard/,
  );
});

test("cleanup boundary validation rejects a guard that is never asserted", () => {
  assert.throws(
    () => {
      validateCleanupBoundary(
        [
          "#!/usr/bin/env bash",
          'cleanup_guard="$test_parent/cleanup-must-not-escape-fixtures"',
          'rm --recursive "$test_root"',
          "",
        ].join("\n"),
        "unchecked.test.sh",
      );
    },
    /does not assert its cleanup boundary guard survived after cleanup/,
  );
});

test("shell suites with recursive fixture cleanup assert a boundary guard", () => {
  const shellTests = readdirSync(shellTestDirectory)
    .filter((filename) => filename.endsWith(".test.sh"))
    .sort();

  assert.ok(shellTests.length > 0, "expected shell test suites to scan");
  for (const filename of shellTests) {
    validateCleanupBoundary(
      readFileSync(path.join(shellTestDirectory, filename), "utf8"),
      filename,
    );
  }
});