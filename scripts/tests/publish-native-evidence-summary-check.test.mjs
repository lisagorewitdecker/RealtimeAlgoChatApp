import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  checkRunName,
  checkRunSummaryLimit,
  checkRunTitle,
  main,
} from "../publish-native-evidence-summary-check.mjs";

function captureStream() {
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

function withCapture(contents, callback) {
  const root = mkdtempSync(join(tmpdir(), "native-summary-check-"));
  const capturePath = join(root, "summary.md");
  writeFileSync(capturePath, contents);
  return Promise.resolve()
    .then(() => callback({ capturePath }))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

const summary = [
  "## Reviewed release revision",
  "- Checked ref: `reviewed-ref`",
  "- Resolved commit SHA: `0123456789abcdef0123456789abcdef01234567`",
  "",
  "## iOS native large-text evidence",
  "- Status: **FAIL**",
  "",
].join("\n");

test("publishes the exact validated summary as a public check run", async () => {
  await withCapture(summary, async ({ capturePath }) => {
    const stdout = captureStream();
    const stderr = captureStream();
    let request;
    const result = await main({
      env: {
        NATIVE_EVIDENCE_SUMMARY_CAPTURE_PATH: capturePath,
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
    const body = JSON.parse(request.options.body);
    assert.equal(body.name, checkRunName);
    assert.equal(body.head_sha, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(body.conclusion, "success");
    assert.equal(body.output.title, checkRunTitle);
    assert.equal(body.output.summary, summary);
    assert.match(stdout.read(), /Published the "Native evidence summary bytes"/);
    assert.equal(stderr.read(), "");
  });
});

test("rejects a capture whose content is larger than the check-run limit", async () => {
  await withCapture(
    `- Resolved commit SHA: \`0123456789abcdef0123456789abcdef01234567\`\n${"x".repeat(checkRunSummaryLimit)}`,
    async ({ capturePath }) => {
      const stdout = captureStream();
      const stderr = captureStream();
      let called = false;
      const result = await main({
        env: {
          NATIVE_EVIDENCE_SUMMARY_CAPTURE_PATH: capturePath,
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_TOKEN: "token",
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
      assert.match(stderr.read(), /exceeds GitHub's 65535-character/);
      assert.equal(stdout.read(), "");
    },
  );
});

test("does not contact GitHub when the resolved checkout SHA is missing", async () => {
  await withCapture(
    "## Reviewed release revision\n- Checked ref: `reviewed-ref`\n",
    async ({ capturePath }) => {
      const stdout = captureStream();
      const stderr = captureStream();
      let called = false;
      const result = await main({
        env: {
          NATIVE_EVIDENCE_SUMMARY_CAPTURE_PATH: capturePath,
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_TOKEN: "token",
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
      assert.match(stderr.read(), /does not contain a valid resolved commit SHA/);
      assert.equal(stdout.read(), "");
    },
  );
});