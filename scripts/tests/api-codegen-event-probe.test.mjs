import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBreakingCompatibilityContent,
  buildStaleGeneratedContent,
  findMatchingWorkflowRun,
  GitHubClient,
  getRequiredFailure,
  parseArgs,
  runProbe,
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

test("stale generated content changes only the checked-in generated file", () => {
  const content = "export const generated = true;\n";
  const stale = buildStaleGeneratedContent(content, "probe-marker");

  assert.match(stale, /export const generated = true;/);
  assert.match(stale, /api-codegen stale-client event probe: probe-marker/);
  assert.equal(stale.endsWith("\n"), true);
});

test("compatibility fixture makes a deterministic API operation breaking", () => {
  const content = "paths:\n  /rooms:\n    post:\n      operationId: createRoom\n";
  const breaking = buildBreakingCompatibilityContent(content);

  assert.match(breaking, /operationId: createRoomHostedProbe/);
  assert.doesNotMatch(breaking, /operationId: createRoom\n/);
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
          "export const generated = true;\noperationId: createRoom\n",
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
