import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const publisherPath = fileURLToPath(
  new URL("./publish-drift-check.mjs", import.meta.url),
);
const token = "test-only-check-publishing-token";
const changedPath = "lib/api-client-react/src/generated/api.schemas.ts";
const report = [
  "Generated API drift detected after regeneration:",
  "",
  `- ${changedPath} (modified: +1 -1)`,
  "",
  `--- a/${changedPath}`,
  `+++ b/${changedPath}`,
  "@@ -1 +1 @@",
  "-export const stale = true;",
  "+export const stale = false;",
  "",
  "Run `pnpm --filter @workspace/api-spec run codegen` and commit the generated output.",
].join("\n");

async function withApi(handler, run) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      handler(response);
    });
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

const runFile = promisify(execFile);

// The publisher must run without blocking this process's event loop, because
// the fixture API server answering its request runs here.
async function runPublisher(environment) {
  const env = { ...process.env, ...environment };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete env[name];
    }
  }
  try {
    const { stdout, stderr } = await runFile(process.execPath, [publisherPath], {
      env,
      encoding: "utf8",
    });
    return { status: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    return {
      status: error.code ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

async function withReportFile(contents, run) {
  const directory = mkdtempSync(join(tmpdir(), "api-codegen-publish-"));
  const reportPath = join(directory, "api-codegen-drift-report.txt");
  if (contents !== undefined) {
    writeFileSync(reportPath, contents);
  }
  try {
    return await run(reportPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("publishes the drift evidence as a check run reviewers can open", async () => {
  await withApi(
    (response) => {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: 1,
          html_url: "https://github.test/checks/1",
        }),
      );
    },
    async (apiUrl, requests) => {
      const result = await withReportFile(`${report}\n`, (reportPath) =>
        runPublisher({
          API_CODEGEN_DRIFT_REPORT_PATH: reportPath,
          API_CODEGEN_DRIFT_HEAD_SHA: "1234567890abcdef",
          GITHUB_API_URL: apiUrl,
          GITHUB_REPOSITORY: "owner/repository",
          GITHUB_TOKEN: token,
          GITHUB_SHA: undefined,
        }),
      );

      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /https:\/\/github\.test\/checks\/1/);
      assert.doesNotMatch(result.output, new RegExp(token));

      assert.equal(requests.length, 1);
      const [request] = requests;
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/repos/owner/repository/check-runs");
      assert.equal(request.authorization, `Bearer ${token}`);

      const payload = JSON.parse(request.body);
      assert.equal(payload.head_sha, "1234567890abcdef");
      assert.equal(payload.conclusion, "failure");
      assert.equal(payload.output.title, "Generated API drift detected");
      assert.ok(
        payload.output.summary.includes(changedPath),
        "the summary must name the changed generated path",
      );
      assert.ok(
        payload.output.summary.includes(
          "pnpm --filter @workspace/api-spec run codegen",
        ),
        "the summary must contain the regeneration command",
      );
      assert.match(payload.output.summary, /```diff\n/);
      assert.ok(
        payload.output.summary.includes("@@ -1 +1 @@"),
        "the summary must contain the bounded report",
      );
    },
  );
});

test("does nothing when the verification step failed without drift", async () => {
  await withApi(
    (response) => {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end("{}");
    },
    async (apiUrl, requests) => {
      const result = await withReportFile(undefined, (reportPath) =>
        runPublisher({
          API_CODEGEN_DRIFT_REPORT_PATH: reportPath,
          API_CODEGEN_DRIFT_HEAD_SHA: "1234567890abcdef",
          GITHUB_API_URL: apiUrl,
          GITHUB_REPOSITORY: "owner/repository",
          GITHUB_TOKEN: token,
        }),
      );

      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /nothing to publish/);
      assert.equal(requests.length, 0);
    },
  );
});

test("fails loudly when GitHub rejects the check run", async () => {
  await withApi(
    (response) => {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "Resource not accessible" }));
    },
    async (apiUrl) => {
      const result = await withReportFile(`${report}\n`, (reportPath) =>
        runPublisher({
          API_CODEGEN_DRIFT_REPORT_PATH: reportPath,
          API_CODEGEN_DRIFT_HEAD_SHA: "1234567890abcdef",
          GITHUB_API_URL: apiUrl,
          GITHUB_REPOSITORY: "owner/repository",
          GITHUB_TOKEN: token,
        }),
      );

      assert.notEqual(result.status, 0);
      assert.match(result.output, /status 403: .*Resource not accessible/);
      assert.doesNotMatch(result.output, new RegExp(token));
    },
  );
});

test("reports a missing report path instead of publishing nothing silently", async () => {
  const result = await runPublisher({
    API_CODEGEN_DRIFT_REPORT_PATH: undefined,
    GITHUB_REPOSITORY: "owner/repository",
    GITHUB_TOKEN: token,
    GITHUB_SHA: "1234567890abcdef",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.output, /API_CODEGEN_DRIFT_REPORT_PATH is not set/);
});

test("reports missing GitHub context without contacting the API", async () => {
  const result = await withReportFile(`${report}\n`, (reportPath) =>
    runPublisher({
      API_CODEGEN_DRIFT_REPORT_PATH: reportPath,
      API_CODEGEN_DRIFT_HEAD_SHA: "1234567890abcdef",
      GITHUB_REPOSITORY: "owner/repository",
      GITHUB_TOKEN: undefined,
    }),
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.output,
    /GITHUB_TOKEN must be set to publish the generated-client drift evidence\./,
  );
});
