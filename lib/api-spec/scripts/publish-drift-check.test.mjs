import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { driftSummaryTitle } from "./drift-summary.mjs";
import { checkRunName, main } from "./publish-drift-check.mjs";

function createWritableCapture() {
  let text = "";
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
        return true;
      },
    },
    read() {
      return text;
    },
  };
}

async function withTemporaryReport(contents, callback) {
  const root = mkdtempSync(join(tmpdir(), "publish-drift-check-"));
  const reportPath = join(root, "drift-report.txt");
  writeFileSync(reportPath, contents);
  try {
    return await callback({ reportPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("publishes a generated-client drift check run", async () => {
  await withTemporaryReport(
    "--- a/file.ts\n+++ b/file.ts\n+drift\n",
    async ({ reportPath }) => {
      const stdout = createWritableCapture();
      const stderr = createWritableCapture();
      let request;
      const result = await main({
        env: {
          API_CODEGEN_DRIFT_REPORT_PATH: reportPath,
          API_CODEGEN_DRIFT_HEAD_SHA: "abc123",
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_TOKEN: "token",
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
        fetchImpl: async (url, options) => {
          request = { url, options };
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                html_url: "https://github.com/owner/repo/runs/check-run",
              }),
          };
        },
      });

      assert.equal(result, 0);
      assert.equal(
        request.url,
        "https://api.github.com/repos/owner/repo/check-runs",
      );
      assert.equal(request.options.method, "POST");
      assert.equal(request.options.headers.Authorization, "Bearer " + "token");
      const body = JSON.parse(request.options.body);
      assert.equal(body.name, checkRunName);
      assert.equal(body.head_sha, "abc123");
      assert.equal(body.conclusion, "failure");
      assert.equal(body.output.title, driftSummaryTitle);
      assert.match(
        body.output.summary,
        /Regenerate with `pnpm --filter @workspace\/api-spec run codegen`/,
      );
      assert.match(
        stdout.read(),
        /Published the "Generated client drift evidence" check run for abc123/,
      );
      assert.equal(stderr.read(), "");
    },
  );
});

test("skips publication when no report file exists", async () => {
  const stdout = createWritableCapture();
  const stderr = createWritableCapture();
  let called = false;

  const result = await main({
    env: {
      API_CODEGEN_DRIFT_REPORT_PATH: join(tmpdir(), "missing-drift-report.txt"),
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_TOKEN: "token",
      GITHUB_SHA: "def456",
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
    fetchImpl: async () => {
      called = true;
      throw new Error("fetch should not run");
    },
  });

  assert.equal(result, 0);
  assert.equal(called, false);
  assert.match(stdout.read(), /nothing to publish/);
  assert.equal(stderr.read(), "");
});

test("reports GitHub API failures", async () => {
  await withTemporaryReport(
    "--- a/file.ts\n+++ b/file.ts\n+drift\n",
    async ({ reportPath }) => {
      const stdout = createWritableCapture();
      const stderr = createWritableCapture();
      const result = await main({
        env: {
          API_CODEGEN_DRIFT_REPORT_PATH: reportPath,
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_TOKEN: "token",
          GITHUB_SHA: "def456",
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
        fetchImpl: async () => ({
          ok: false,
          status: 403,
          text: async () => "forbidden",
        }),
      });

      assert.equal(result, 1);
      assert.equal(stdout.read(), "");
      assert.match(
        stderr.read(),
        /GitHub rejected the generated-client drift evidence check run with status 403: forbidden/,
      );
    },
  );
});

test("reports a missing report path instead of publishing nothing silently", async () => {
  const stdout = createWritableCapture();
  const stderr = createWritableCapture();
  const result = await main({
    env: {
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_TOKEN: "token",
      GITHUB_SHA: "abc123",
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });

  assert.equal(result, 1);
  assert.equal(stdout.read(), "");
  assert.match(stderr.read(), /API_CODEGEN_DRIFT_REPORT_PATH is not set/);
});

test("reports missing GitHub context without contacting the API", async () => {
  await withTemporaryReport(
    "--- a/file.ts\n+++ b/file.ts\n+drift\n",
    async ({ reportPath }) => {
      const stdout = createWritableCapture();
      const stderr = createWritableCapture();
      let called = false;
      const result = await main({
        env: {
          API_CODEGEN_DRIFT_REPORT_PATH: reportPath,
          GITHUB_REPOSITORY: "owner/repo",
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
        fetchImpl: async () => {
          called = true;
          throw new Error("fetch should not run");
        },
      });

      assert.equal(result, 1);
      assert.equal(called, false);
      assert.equal(stdout.read(), "");
      assert.match(
        stderr.read(),
        /GITHUB_TOKEN must be set to publish the generated-client drift evidence/,
      );
    },
  );
});
