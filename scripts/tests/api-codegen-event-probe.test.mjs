import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildBreakingCompatibilityContent,
  buildStaleGeneratedContent,
  findMatchingWorkflowRun,
  formatMarkdownEvidence,
  GitHubClient,
  getRequiredFailure,
  parseArgs,
  resolveRecordOutput,
  runProbe,
  serializeEvidenceRecord,
  writeEvidenceRecord,
} from "../probe-api-codegen-events.mjs";

test("probe arguments keep the hosted check defaults and accept an output path", () => {
  const { options, showHelp } = parseArgs([
    "--repo",
    "owner/repository",
    "--output",
    "test-results/probe.json",
    "--poll-seconds",
    "2",
    "--timeout-seconds",
    "30",
  ]);

  assert.equal(showHelp, false);
  assert.equal(options.repository, "owner/repository");
  assert.equal(
    options.generatedFile,
    "lib/api-client-react/src/generated/api.schemas.ts",
  );
  assert.equal(options.workflow, ".github/workflows/api-codegen.yml");
  assert.equal(options.compatibilityFile, "lib/api-spec/openapi.yaml");
  assert.equal(options.output, "test-results/probe.json");
  assert.equal(options.pollSeconds, 2);
  assert.equal(options.timeoutSeconds, 30);
});

test("record arguments support dated Markdown/JSON output without implicit replacement", () => {
  const { options } = parseArgs([
    "--record-dir",
    "artifacts/chat-app/docs/api-codegen-event-probes",
    "--record-format",
    "json",
    "--overwrite",
  ]);

  assert.equal(options.recordDir, "artifacts/chat-app/docs/api-codegen-event-probes");
  assert.equal(options.recordFormat, "json");
  assert.equal(options.recordFormatExplicit, true);
  assert.equal(options.overwrite, true);
  assert.equal(
    resolveRecordOutput(options, new Date("2026-09-19T02:40:12.345Z")),
    join(
      process.cwd(),
      "artifacts/chat-app/docs/api-codegen-event-probes/api-codegen-event-probe-20260919T024012Z.json",
    ),
  );
});

test("review records retain links, failed steps, and cleanup confirmations", () => {
  const result = {
    checkedAt: "2026-09-19T02:40:12.345Z",
    repository: "example/repository",
    branch: "api-codegen-probe",
    pullRequest: {
      number: 10,
      url: "https://github.com/example/repository/pull/10",
      merged: false,
    },
    events: [
      {
        event: "edited",
        workflowRun: {
          id: 104,
          url: "https://github.com/example/repository/actions/runs/104",
        },
        job: {
          id: 100,
          name: "Check generated API clients",
          url: "https://github.com/example/repository/actions/runs/104/job/100",
        },
        step: {
          name: "Verify generated API clients",
          conclusion: "failure",
        },
        compatibility: {
          name: "Check API contract compatibility",
          conclusion: "success",
        },
      },
    ],
    cleanup: {
      pullRequestClosed: true,
      branchDeleted: true,
      failures: [],
    },
  };

  const markdown = formatMarkdownEvidence(result);
  assert.match(markdown, /# API generated-client pull-request event probe/);
  assert.match(markdown, /\[#10\]\(https:\/\/github\.com\/example\/repository\/pull\/10\)/);
  assert.match(markdown, /\[#104\]\(https:\/\/github\.com\/example\/repository\/actions\/runs\/104\)/);
  assert.match(markdown, /Verify generated API clients.*failure/);
  assert.match(markdown, /Temporary branch deleted: \*\*confirmed\*\*/);
  assert.doesNotMatch(markdown, /API_BREAKING_CHANGE_/);
  assert.match(serializeEvidenceRecord(result, "json"), /"pullRequest"/);
});

test("evidence records refuse replacement unless overwrite is explicit", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-codegen-event-probe-"));
  const path = join(directory, "record.md");
  const result = {
    checkedAt: "2026-09-19T02:40:12.345Z",
    repository: "example/repository",
    branch: "api-codegen-probe",
    pullRequest: { number: 10, url: "https://example.test/pull/10" },
    events: [],
    cleanup: { pullRequestClosed: true, branchDeleted: true, failures: [] },
  };

  try {
    assert.equal(writeEvidenceRecord(path, result, "markdown"), path);
    assert.throws(
      () => writeEvidenceRecord(path, result, "markdown"),
      /refusing to overwrite existing evidence record/,
    );
    writeEvidenceRecord(path, result, "markdown", true);
    assert.match(readFileSync(path, "utf8"), /confirmed cleanup/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow paths are sent to GitHub as one filename identifier", async () => {
  let requestedUrl;
  const client = new GitHubClient({
    token: "test-token",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return { workflow_runs: [] };
        },
      };
    },
  });

  await client.listWorkflowRuns(
    "owner/repository",
    ".github/workflows/api-codegen.yml",
    "api-codegen-probe",
  );

  assert.equal(
    requestedUrl,
    "https://api.github.com/repos/owner/repository/actions/workflows/api-codegen.yml/runs?event=pull_request&branch=api-codegen-probe&per_page=100",
  );
});

test("safe GET requests retry transient GitHub failures before succeeding", async () => {
  let now = 0;
  let requestCount = 0;
  const delays = [];
  const client = new GitHubClient({
    token: "test-token",
    retryDeadlineMs: 10,
    retryBaseDelayMs: 2,
    retryMaxDelayMs: 4,
    nowImpl: () => now,
    sleepImpl: async (delayMs) => {
      delays.push(delayMs);
      now += delayMs;
    },
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount < 3) {
        return {
          ok: false,
          status: 503,
          async text() {
            return '{"message":"GitHub is temporarily unavailable"}';
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { object: { sha: "base-sha" } };
        },
      };
    },
  });

  assert.deepEqual(
    await client.getRef("owner/repository", "heads/development"),
    { object: { sha: "base-sha" } },
  );
  assert.equal(requestCount, 3);
  assert.deepEqual(delays, [2, 4]);
});

test("safe GET requests retry transient transport failures before succeeding", async () => {
  let now = 0;
  let requestCount = 0;
  const client = new GitHubClient({
    token: "test-token",
    retryDeadlineMs: 10,
    retryBaseDelayMs: 2,
    retryMaxDelayMs: 2,
    nowImpl: () => now,
    sleepImpl: async (delayMs) => {
      now += delayMs;
    },
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        throw new Error("socket hang up");
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { object: { sha: "base-sha" } };
        },
      };
    },
  });

  assert.deepEqual(
    await client.getRef("owner/repository", "heads/development"),
    { object: { sha: "base-sha" } },
  );
  assert.equal(requestCount, 2);
});

test("safe GET requests stop retrying when their bounded deadline expires", async () => {
  let now = 0;
  let requestCount = 0;
  const requestTimes = [];
  const delays = [];
  const client = new GitHubClient({
    token: "test-token",
    retryDeadlineMs: 5,
    retryBaseDelayMs: 2,
    retryMaxDelayMs: 2,
    nowImpl: () => now,
    sleepImpl: async (delayMs) => {
      delays.push(delayMs);
      now += delayMs;
    },
    fetchImpl: async () => {
      requestCount += 1;
      requestTimes.push(now);
      return {
        ok: false,
        status: 503,
        async text() {
          return '{"message":"GitHub is temporarily unavailable"}';
        },
      };
    },
  });

  await assert.rejects(
    client.getRef("owner/repository", "heads/development"),
    (error) => {
      assert.equal(error.name, "GitHubApiError");
      assert.equal(error.status, 503);
      assert.match(error.message, /temporarily unavailable/);
      return true;
    },
  );
  assert.equal(requestCount, 3);
  assert.deepEqual(requestTimes, [0, 2, 4]);
  assert.deepEqual(delays, [2, 2, 1]);
});

test("safe GET requests abort a request that remains in flight at the deadline", async () => {
  let aborted = false;
  const client = new GitHubClient({
    token: "test-token",
    retryDeadlineMs: 20,
    fetchImpl: async (_url, requestInit) =>
      new Promise((_resolve, reject) => {
        requestInit.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }),
  });

  await assert.rejects(
    client.getRef("owner/repository", "heads/development"),
    (error) => {
      assert.equal(error.name, "GitHubRequestTimeoutError");
      return true;
    },
  );
  assert.equal(aborted, true);
});

test("safe GET requests keep the deadline active while reading a response body", async () => {
  let bodyAborted = false;
  const client = new GitHubClient({
    token: "test-token",
    retryDeadlineMs: 20,
    fetchImpl: async (_url, requestInit) => ({
      ok: true,
      status: 200,
      async json() {
        return new Promise((_resolve, reject) => {
          requestInit.signal.addEventListener("abort", () => {
            bodyAborted = true;
            reject(new Error("body aborted"));
          });
        });
      },
    }),
  });

  await assert.rejects(
    client.getRef("owner/repository", "heads/development"),
    (error) => {
      assert.equal(error.name, "GitHubRequestTimeoutError");
      return true;
    },
  );
  assert.equal(bodyAborted, true);
});

test("safe GET requests retry a transient response-body failure", async () => {
  let now = 0;
  let requestCount = 0;
  const client = new GitHubClient({
    token: "test-token",
    retryDeadlineMs: 10,
    retryBaseDelayMs: 2,
    retryMaxDelayMs: 2,
    nowImpl: () => now,
    sleepImpl: async (delayMs) => {
      now += delayMs;
    },
    fetchImpl: async () => {
      requestCount += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          if (requestCount === 1) {
            throw new Error("response stream reset");
          }
          return { object: { sha: "base-sha" } };
        },
      };
    },
  });

  assert.deepEqual(
    await client.getRef("owner/repository", "heads/development"),
    { object: { sha: "base-sha" } },
  );
  assert.equal(requestCount, 2);
});

test("safe GET requests do not retry semantic JSON parsing failures", async () => {
  let requestCount = 0;
  const client = new GitHubClient({
    token: "test-token",
    retryDeadlineMs: 10,
    sleepImpl: async () => {
      throw new Error("semantic parsing failures must not retry");
    },
    fetchImpl: async () => {
      requestCount += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          throw new SyntaxError("Unexpected token");
        },
      };
    },
  });

  await assert.rejects(
    client.getRef("owner/repository", "heads/development"),
    SyntaxError,
  );
  assert.equal(requestCount, 1);
});

test("safe GET requests retry a rate-limited 403 but not an ordinary 403", async () => {
  let now = 0;
  let requestCount = 0;
  const client = new GitHubClient({
    token: "test-token",
    retryDeadlineMs: 10,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
    nowImpl: () => now,
    sleepImpl: async (delayMs) => {
      now += delayMs;
    },
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: false,
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
          async text() {
            return '{"message":"API rate limit exceeded"}';
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { object: { sha: "base-sha" } };
        },
      };
    },
  });

  await client.getRef("owner/repository", "heads/development");
  assert.equal(requestCount, 2);

  const ordinaryForbiddenClient = new GitHubClient({
    token: "test-token",
    retryDeadlineMs: 10,
    sleepImpl: async () => {
      throw new Error("ordinary 403 responses must not be retried");
    },
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async text() {
        return '{"message":"Resource not accessible"}';
      },
    }),
  });

  await assert.rejects(
    ordinaryForbiddenClient.getRef("owner/repository", "heads/development"),
    /HTTP 403: Resource not accessible/,
  );
});

test("mutating requests are not retried after transient GitHub failures", async () => {
  let requestCount = 0;
  const client = new GitHubClient({
    token: "test-token",
    sleepImpl: async () => {
      throw new Error("mutating requests must not sleep for retries");
    },
    fetchImpl: async () => {
      requestCount += 1;
      return {
        ok: false,
        status: 503,
        async text() {
          return '{"message":"GitHub is temporarily unavailable"}';
        },
      };
    },
  });

  await assert.rejects(
    client.createRef("owner/repository", "probe", "commit-sha"),
    /HTTP 503: GitHub is temporarily unavailable/,
  );
  assert.equal(requestCount, 1);
});

test("stale generated content changes only the checked-in generated file", () => {
  const content = "export const generated = true;\n";
  const stale = buildStaleGeneratedContent(content, "probe-marker");

  assert.match(stale, /export const generated = true;/);
  assert.match(stale, /api-codegen stale-client event probe: probe-marker/);
  assert.equal(stale.endsWith("\n"), true);
});

test("compatibility fixture makes a deterministic API operation breaking", () => {
  const content = [
    "components:",
    "  schemas:",
    "    createRoom:",
    "      type: string",
    "paths:",
    "  /other:",
    "    post:",
    "      operationId: createRoom",
    "  /rooms:",
    "    post:",
    "      operationId: createRoom",
    "",
  ].join("\n");
  const breaking = buildBreakingCompatibilityContent(content);
  assert.match(
    breaking,
    /\/rooms:\n {4}post:\n {6}operationId: createRoomHostedProbe/,
  );
  assert.match(breaking, /\/rooms:\n {4}post:\n {6}operationId: createRoomHostedProbe/);
  assert.match(breaking, /\/other:\n {4}post:\n {6}operationId: createRoom/);
});

test("compatibility fixture rejects malformed YAML before probing for /rooms", () => {
  assert.throws(
    () => buildBreakingCompatibilityContent("paths:\n  /rooms:\n    post:\n      [\n"),
    /invalid compatibility fixture YAML:/,
  );
});

test("matching workflow runs are bound to the branch, head, pull request, and event time", () => {
  const runs = [
    {
      id: 1,
      event: "pull_request",
      head_branch: "api-codegen-probe",
      head_sha: "sha",
      created_at: "2026-09-17T10:00:00.000Z",
      pull_requests: [{ number: 10 }],
    },
    {
      id: 2,
      event: "pull_request",
      head_branch: "api-codegen-probe",
      head_sha: "sha",
      created_at: "2026-09-17T10:05:00.000Z",
      pull_requests: [{ number: 11 }],
    },
  ];

  const match = findMatchingWorkflowRun(runs, {
    branch: "api-codegen-probe",
    headSha: "sha",
    pullRequestNumber: 10,
    after: "2026-09-17T10:01:00.000Z",
  });

  assert.equal(match, undefined);
  assert.equal(
    findMatchingWorkflowRun(runs, {
      branch: "api-codegen-probe",
      headSha: "sha",
      pullRequestNumber: 11,
      after: "2026-09-17T10:04:00.000Z",
    }).id,
    2,
  );
});

test("required evidence is the generated-client step failure and its job URL", () => {
  const evidence = getRequiredFailure(
    { id: 42 },
    {
      jobs: [
        {
          id: 100,
          name: "Check generated API clients",
          html_url:
            "https://github.com/example/repository/actions/runs/42/job/100",
          conclusion: "failure",
          steps: [
            {
              name: "Verify generated API clients",
              conclusion: "failure",
            },
          ],
        },
      ],
    },
  );

  assert.deepEqual(evidence, {
    job: {
      id: 100,
      name: "Check generated API clients",
      url: "https://github.com/example/repository/actions/runs/42/job/100",
      conclusion: "failure",
    },
    step: {
      name: "Verify generated API clients",
      conclusion: "failure",
    },
  });
});

test("a successful probe confirms cleanup before returning its hosted evidence", async () => {
  const updates = [];
  let commitCount = 0;
  const runTimes = "2026-09-17T10:00:00.000Z";
  const runs = [
    {
      id: 101,
      event: "pull_request",
      head_branch: "api-codegen-probe",
      head_sha: "commit-sha",
      created_at: runTimes,
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/example/repository/actions/runs/101",
      pull_requests: [{ number: 10 }],
    },
    {
      id: 102,
      event: "pull_request",
      head_branch: "api-codegen-probe",
      head_sha: "synchronize-sha",
      created_at: runTimes,
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/example/repository/actions/runs/102",
      pull_requests: [{ number: 10 }],
    },
    {
      id: 103,
      event: "pull_request",
      head_branch: "api-codegen-probe",
      head_sha: "synchronize-sha",
      created_at: runTimes,
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/example/repository/actions/runs/103",
      pull_requests: [{ number: 10 }],
    },
    {
      id: 104,
      event: "pull_request",
      head_branch: "api-codegen-probe",
      head_sha: "synchronize-sha",
      created_at: runTimes,
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/example/repository/actions/runs/104",
      pull_requests: [{ number: 10 }],
    },
  ];
  const client = {
    async getOptionalRef() {
      return null;
    },
    async getRef() {
      return { object: { sha: "base-sha" } };
    },
    async getCommit() {
      return { tree: { sha: "base-tree" } };
    },
    async getContent() {
      return {
        encoding: "base64",
        content: Buffer.from(
          "paths:\n  /rooms:\n    post:\n      operationId: createRoom\n",
        ).toString("base64"),
      };
    },
    async createBlob() {
      return { sha: "blob-sha" };
    },
    async createTree() {
      return { sha: "tree-sha" };
    },
    async createCommit() {
      commitCount += 1;
      return {
        sha: commitCount === 1 ? "commit-sha" : "synchronize-sha",
      };
    },
    async createRef() {},
    async updateRef() {},
    async createPullRequest() {
      return {
        number: 10,
        html_url: "https://github.com/example/repository/pull/10",
      };
    },
    async listWorkflowRuns() {
      return { workflow_runs: runs };
    },
    async getWorkflowRun(_repository, id) {
      return runs.find((run) => run.id === id);
    },
    async listJobs(_repository, runId) {
      return {
        jobs: [
          {
            id: 100,
            name: "Check generated API clients",
            html_url: `https://github.com/example/repository/actions/runs/${runId}/job/100`,
            conclusion: "failure",
            steps: [
              {
                name: "Verify generated API clients",
                conclusion: "failure",
              },
              {
                name: "Check API contract compatibility",
                conclusion: runId === 104 ? "success" : "failure",
              },
            ],
          },
        ],
      };
    },
    async updatePullRequest(_repository, number, update) {
      updates.push({ number, update });
    },
    async getPullRequest() {
      return { state: "closed", merged: false };
    },
    async deleteRef() {},
  };

  const result = await runProbe(
    client,
    {
      repository: "example/repository",
      branch: "api-codegen-probe",
      timeoutSeconds: 1,
      pollSeconds: 0.001,
    },
    {
      now: () => new Date(runTimes),
    },
  );

  assert.deepEqual(
    result.events.map((event) => [event.event, event.workflowRun.id]),
    [
      ["opened", 101],
      ["synchronize", 102],
      ["reopened", 103],
      ["edited", 104],
    ],
  );
  assert.ok(
    result.events.every((event) => event.step.conclusion === "failure"),
  );
  assert.deepEqual(
    result.events.map((event) => event.compatibility.conclusion),
    ["failure", "failure", "failure", "success"],
  );
  assert.equal(result.events[2].workflowRun.headSha, "synchronize-sha");
  assert.equal(
    result.events[3].workflowRun.headSha,
    result.events[2].workflowRun.headSha,
  );
  const serializedEvidence = JSON.stringify(result);
  assert.doesNotMatch(serializedEvidence, /API_BREAKING_CHANGE_/);
  assert.doesNotMatch(serializedEvidence, /Edited-event marker/);
  assert.doesNotMatch(serializedEvidence, /Hosted description-edit/);
  assert.ok(result.events.every((event) => event.job.url.endsWith("/job/100")));
  assert.equal(updates.length, 4);
  assert.deepEqual(updates[0], {
    number: 10,
    update: { state: "closed" },
  });
  assert.deepEqual(updates[1], {
    number: 10,
    update: { state: "open" },
  });
  assert.equal(updates[2].number, 10);
  assert.match(updates[2].update.body, /Edited-event marker:/);
  assert.deepEqual(updates[3], {
    number: 10,
    update: { state: "closed" },
  });
  assert.deepEqual(result.cleanup, {
    pullRequestClosed: true,
    branchDeleted: true,
    failures: [],
  });
});

test("an API outage during polling still runs cleanup after the probe fails", async () => {
  const updates = [];
  const deletedBranches = [];
  let optionalRefCalls = 0;
  const client = {
    async getOptionalRef() {
      optionalRefCalls += 1;
      return null;
    },
    async getRef() {
      return { object: { sha: "base-sha" } };
    },
    async getCommit() {
      return { tree: { sha: "base-tree" } };
    },
    async getContent() {
      return {
        encoding: "base64",
        content: Buffer.from(
          "paths:\n  /rooms:\n    post:\n      operationId: createRoom\n",
        ).toString("base64"),
      };
    },
    async createBlob() {
      return { sha: "blob-sha" };
    },
    async createTree() {
      return { sha: "tree-sha" };
    },
    async createCommit() {
      return { sha: "commit-sha" };
    },
    async createRef() {},
    async createPullRequest() {
      return {
        number: 10,
        html_url: "https://github.com/example/repository/pull/10",
      };
    },
    async listWorkflowRuns() {
      throw new Error(
        "GitHub GET workflow runs failed with HTTP 503: service unavailable",
      );
    },
    async updatePullRequest(_repository, number, update) {
      updates.push({ number, update });
    },
    async getPullRequest() {
      return { state: "closed", merged: false };
    },
    async deleteRef(_repository, branch) {
      deletedBranches.push(branch);
    },
  };

  await assert.rejects(
    runProbe(
      client,
      {
        repository: "example/repository",
        branch: "api-codegen-probe",
        timeoutSeconds: 1,
        pollSeconds: 0.001,
      },
      {
        now: () => new Date("2026-09-17T10:00:00.000Z"),
      },
    ),
    /HTTP 503: service unavailable/,
  );

  assert.deepEqual(updates, [
    {
      number: 10,
      update: { state: "closed" },
    },
  ]);
  assert.deepEqual(deletedBranches, ["api-codegen-probe"]);
  assert.equal(optionalRefCalls, 2);
});
