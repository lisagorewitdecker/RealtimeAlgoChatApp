import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const writerPath = resolve(
  workspaceRoot,
  "artifacts/chat-app/e2e/sentry-source-map/run.sh",
);
const checkerPath = resolve(
  workspaceRoot,
  "scripts/check-native-large-text-evidence.sh",
);
const execFileAsync = promisify(execFile);

function readSource(path) {
  return readFileSync(path, "utf8");
}

function extractWriterKeys(source) {
  const writerBlocks = [
    ...source.matchAll(
      /cat > "\$NATIVE_SMOKE_RESULTS_DIR\/sentry-trigger\.txt" <<EOF\r?\n([\s\S]*?)\r?\nEOF/g,
    ),
  ];
  assert.ok(
    writerBlocks.length > 0,
    `Could not find the sentry-trigger.txt writer block in ${writerPath}. ` +
      "Update this contract test intentionally if the writer format changes.",
  );
  assert.equal(
    writerBlocks.length,
    1,
    `Expected exactly one sentry-trigger.txt writer block in ${writerPath}. ` +
      "Keep one authoritative probe writer so the controlled event and evidence cannot be duplicated.",
  );

  return [...writerBlocks[0][1].matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(
    ([, key]) => key,
  );
}

function extractCheckerKeys(source) {
  const checkerFunctions = [
    ...source.matchAll(
      /sentry_trigger_metadata_errors\(\) \{([\s\S]*?)\n\}\n\nreport_sentry_trigger_metadata_errors/g,
    ),
  ];
  assert.ok(
    checkerFunctions.length > 0,
    `Could not find the Sentry trigger metadata checker function in ${checkerPath}. ` +
      "Update this contract test intentionally if the checker format changes.",
  );
  assert.equal(
    checkerFunctions.length,
    1,
    `Expected exactly one Sentry trigger metadata checker function in ${checkerPath}. ` +
      "Keep one authoritative checker schema so duplicate source cannot drift silently.",
  );
  const checkerFunction = checkerFunctions[0];
  const allowlistBlocks = [
    ...checkerFunction[1].matchAll(
      /if \(\s*key != "[^"]+"\s*(?:&&\s*key != "[^"]+"\s*)+\)\s*\{/g,
    ),
  ];
  assert.equal(
    allowlistBlocks.length,
    1,
    `Expected exactly one explicit Sentry trigger key allowlist in ${checkerPath}. ` +
      "Update this contract test intentionally if the checker format changes.",
  );

  return [
    ...checkerFunction[1].matchAll(/key != "([^"]+)"/g),
  ].map(([, key]) => key);
}

function assertUnique(keys, side) {
  assert.equal(
    new Set(keys).size,
    keys.length,
    `Sentry trigger ${side} declares a duplicate metadata key. ` +
      "Keep the contract fields unique.",
  );
}

test("Sentry trigger writer and checker schemas stay aligned", () => {
  const writerKeys = extractWriterKeys(readSource(writerPath));
  const checkerKeys = extractCheckerKeys(readSource(checkerPath));

  assertUnique(writerKeys, "writer");
  assertUnique(checkerKeys, "checker");
  assert.deepEqual(
    checkerKeys,
    writerKeys,
    "Sentry trigger metadata schema drifted: the writer and checker must " +
      "change together when a field is added, removed, or renamed.",
  );
});

test("native Sentry probe runs Maestro once and writes one trigger record", async () => {
  const tempRoot = await mkdtemp(resolve(tmpdir(), "sentry-trigger-runner-"));
  const stubBin = resolve(tempRoot, "bin");
  const resultsDir = resolve(tempRoot, "results");
  const maestroCountPath = resolve(tempRoot, "maestro-count");
  const catCountPath = resolve(tempRoot, "cat-count");
  const maestroPath = resolve(stubBin, "maestro");
  const catPath = resolve(stubBin, "cat");

  try {
    await mkdir(stubBin);
    await writeFile(maestroCountPath, "0\n");
    await writeFile(catCountPath, "0\n");
    await writeFile(
      maestroPath,
      `#!/usr/bin/env bash
set -euo pipefail
count="$(< "\${MAESTRO_COUNT_FILE}")"
printf '%s\\n' "$((count + 1))" > "\${MAESTRO_COUNT_FILE}"
output=""
while (($# > 0)); do
  if [[ "$1" == "--output" ]]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
[[ -n "$output" ]]
printf '%s\\n' '<testsuite tests="1" failures="0"></testsuite>' > "$output"
`,
      "utf8",
    );
    await writeFile(
      catPath,
      `#!/usr/bin/env bash
set -euo pipefail
count="$(< "\${CAT_COUNT_FILE}")"
printf '%s\\n' "$((count + 1))" > "\${CAT_COUNT_FILE}"
exec /bin/cat "$@"
`,
      "utf8",
    );
    await chmod(maestroPath, 0o755);
    await chmod(catPath, 0o755);

    await execFileAsync("/bin/bash", [writerPath, "ios"], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PATH: `${stubBin}:/usr/bin:/bin`,
        MAESTRO_COUNT_FILE: maestroCountPath,
        CAT_COUNT_FILE: catCountPath,
        NATIVE_SMOKE_APP_ID: "chat-app",
        NATIVE_SMOKE_BUILD_ID: "candidate-ios",
        NATIVE_SMOKE_RESULTS_DIR: resultsDir,
        NATIVE_SENTRY_MARKER: "marker-ios-1234",
      },
    });

    assert.equal(await readFile(maestroCountPath, "utf8"), "1\n");
    assert.equal(await readFile(catCountPath, "utf8"), "1\n");
    assert.equal(
      await readFile(resolve(resultsDir, "sentry-trigger.txt"), "utf8"),
      "platform=ios\ncandidate_build_id=candidate-ios\nmarker=marker-ios-1234\n",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});