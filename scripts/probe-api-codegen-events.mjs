#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS = {
  baseBranch: "development",
  generatedFile: "lib/api-client-react/src/generated/api.schemas.ts",
  compatibilityFile: "lib/api-spec/openapi.yaml",
  workflow: ".github/workflows/api-codegen.yml",
  pollSeconds: 10,
  timeoutSeconds: 900,
};

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export class GitHubApiError extends Error {
  constructor(message, status, path) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.path = path;
  }
}

function describeResponseBody(body) {
  if (!body) {
    return "";
  }
  const message = body.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
  return message ? `: ${message}` : "";
}

export class GitHubClient {
  constructor({ token, apiUrl = "https://api.github.com", fetchImpl = fetch }) {
    this.fetchImpl = fetchImpl;
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
  }

  async request(path, { method = "GET", body, allowNotFound = false } = {}) {
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 404 && allowNotFound) {
      return null;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new GitHubApiError(
        `GitHub ${method} ${path} failed with HTTP ${response.status}${describeResponseBody(text)}`,
        response.status,
        path,
      );
    }
    return response.status === 204 ? undefined : response.json();
  }

  getRef(repository, ref) {
    return this.request(`/repos/${repository}/git/ref/${encodePath(ref)}`);
  }

  getOptionalRef(repository, ref) {
    return this.request(`/repos/${repository}/git/ref/${encodePath(ref)}`, {
      allowNotFound: true,
    });
  }

  getCommit(repository, sha) {
    return this.request(`/repos/${repository}/git/commits/${sha}`);
  }

  getContent(repository, filePath, ref) {
    return this.request(
      `/repos/${repository}/contents/${filePath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(ref)}`,
    );
  }

  createBlob(repository, content) {
    return this.request(`/repos/${repository}/git/blobs`, {
      method: "POST",
      body: { content, encoding: "base64" },
    });
  }

  createTree(repository, tree, baseTree) {
    return this.request(`/repos/${repository}/git/trees`, {
      method: "POST",
      body: { base_tree: baseTree, tree },
    });
  }

  createCommit(repository, message, tree, parents) {
    return this.request(`/repos/${repository}/git/commits`, {
      method: "POST",
      body: { message, tree, parents },
    });
  }

  createRef(repository, branch, sha) {
    return this.request(`/repos/${repository}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha },
    });
  }

  updateRef(repository, branch, sha) {
    return this.request(
      `/repos/${repository}/git/refs/heads/${encodePath(branch)}`,
      {
        method: "PATCH",
        body: { sha, force: false },
      },
    );
  }

  deleteRef(repository, branch) {
    return this.request(
      `/repos/${repository}/git/refs/heads/${encodePath(branch)}`,
      { method: "DELETE" },
    );
  }

  createPullRequest(repository, title, head, base, body) {
    return this.request(`/repos/${repository}/pulls`, {
      method: "POST",
      body: { title, head, base, body },
    });
  }

  updatePullRequest(repository, number, update) {
    return this.request(`/repos/${repository}/pulls/${number}`, {
      method: "PATCH",
      body: update,
    });
  }

  getPullRequest(repository, number) {
    return this.request(`/repos/${repository}/pulls/${number}`);
  }

  listWorkflowRuns(repository, workflow, branch) {
    const workflowIdentifier = workflow.split("/").at(-1);
    return this.request(
      `/repos/${repository}/actions/workflows/${encodeURIComponent(
        workflowIdentifier,
      )}/runs?event=pull_request&branch=${encodeURIComponent(
        branch,
      )}&per_page=100`,
    );
  }

  getWorkflowRun(repository, runId) {
    return this.request(`/repos/${repository}/actions/runs/${runId}`);
  }

  listJobs(repository, runId) {
    return this.request(
      `/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
    );
  }
}

function parsePositiveNumber(value, optionName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive number`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  let showHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--help" || argument === "-h") {
      showHelp = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const optionValues = {
      "--repo": "repository",
      "--base": "baseBranch",
      "--generated-file": "generatedFile",
      "--compatibility-file": "compatibilityFile",
      "--workflow": "workflow",
      "--branch": "branch",
      "--output": "output",
    };
    const optionName = optionValues[argument];
    if (optionName) {
      if (!next || next.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      options[optionName] = next;
      index += 1;
      continue;
    }
    if (argument === "--poll-seconds") {
      options.pollSeconds = parsePositiveNumber(next, argument);
      index += 1;
      continue;
    }
    if (argument === "--timeout-seconds") {
      options.timeoutSeconds = parsePositiveNumber(next, argument);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }

  return { options, showHelp };
}

export function buildStaleGeneratedContent(content, marker) {
  const suffix = `// api-codegen stale-client event probe: ${marker}\n`;
  return `${content.replace(/\s*$/, "")}\n\n${suffix}`;
}

export function findMatchingWorkflowRun(
  runs,
  { branch, headSha, pullRequestNumber, after, excludedRunIds = new Set() },
) {
  const afterMs = new Date(after).getTime() - 30_000;
  return (runs ?? [])
    .filter((run) => {
      const pullRequestMatches =
        !run.pull_requests?.length ||
        run.pull_requests.some((pullRequest) => {
          return pullRequest.number === pullRequestNumber;
        });
      return (
        run.event === "pull_request" &&
        run.head_branch === branch &&
        run.head_sha === headSha &&
        pullRequestMatches &&
        !excludedRunIds.has(run.id) &&
        new Date(run.created_at).getTime() >= afterMs
      );
    })
    .sort(
      (left, right) =>
        new Date(left.created_at).getTime() -
        new Date(right.created_at).getTime(),
    )[0];
}

export function getRequiredFailure(run, jobs) {
  const job = (jobs?.jobs ?? []).find(
    (candidate) => candidate.name === "Check generated API clients",
  );
  if (!job) {
    throw new Error(
      `workflow run ${run.id} did not contain the "Check generated API clients" job`,
    );
  }
  const step = (job.steps ?? []).find(
    (candidate) => candidate.name === "Verify generated API clients",
  );
  if (!step) {
    throw new Error(
      `workflow job ${job.id} did not contain the "Verify generated API clients" step`,
    );
  }
  if (step.conclusion !== "failure") {
    throw new Error(
      `workflow run ${run.id} reported "${step.conclusion ?? "no conclusion"}" for Verify generated API clients; expected failure`,
    );
  }
  return {
    job: {
      id: job.id,
      name: job.name,
      url: job.html_url,
      conclusion: job.conclusion,
    },
    step: {
      name: step.name,
      conclusion: step.conclusion,
    },
  };
}

function getCompatibilityResult(jobsResponse, expectedConclusion) {
  const step = jobsResponse.jobs
    ?.flatMap((job) => job.steps ?? [])
    .find(
      (candidate) => candidate.name === "Check API contract compatibility",
    );
  if (!step || step.conclusion !== expectedConclusion) {
    throw new Error(
      `workflow run did not report API compatibility as ${expectedConclusion}`,
    );
  }
  return {
    name: step.name,
    conclusion: step.conclusion,
  };
}

function workflowRunEvidence(event, run, jobsResponse, compatibilityConclusion) {
  return {
    event,
    workflowRun: {
      id: run.id,
      url: run.html_url,
      event: run.event,
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
    },
    ...getRequiredFailure(run, jobsResponse),
    compatibility: getCompatibilityResult(
      jobsResponse,
      compatibilityConclusion,
    ),
  };
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForWorkflowRun(
  client,
  {
    repository,
    workflow,
    branch,
    headSha,
    pullRequestNumber,
    after,
    excludedRunIds,
    timeoutMs,
    pollMs,
  },
) {
  const deadline = Date.now() + timeoutMs;
  let candidate;
  while (Date.now() < deadline) {
    const response = await client.listWorkflowRuns(
      repository,
      workflow,
      branch,
    );
    candidate = findMatchingWorkflowRun(response.workflow_runs, {
      branch,
      headSha,
      pullRequestNumber,
      after,
      excludedRunIds,
    });
    if (candidate) {
      const current = await client.getWorkflowRun(repository, candidate.id);
      if (current.status === "completed") {
        return current;
      }
    }
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `timed out after ${Math.round(timeoutMs / 1000)} seconds waiting for the API codegen workflow run`,
  );
}

function makeBranchName() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `api-codegen-stale-client-probe-${stamp}-${process.pid}`;
}

function makeInitialBody(branch, marker) {
  return [
    "This temporary pull request is an automated API generated-client event probe.",
    "",
    `Probe marker: ${marker}`,
    `Probe branch: ${branch}`,
    "",
    "Do not merge this pull request. The probe closes it and deletes its branch after the hosted check is recorded.",
  ].join("\n");
}

function makeEditedBody(initialBody, marker) {
  return [
    initialBody,
    "",
    `Edited-event marker: ${marker}`,
    "API_BREAKING_CHANGE_JUSTIFICATION: Hosted description-edit compatibility probe.",
    "API_BREAKING_CHANGE_MIGRATION_PLAN: Restore the temporary operation identifier after the hosted probe.",
  ].join("\n");
}

export function buildBreakingCompatibilityContent(content) {
  const operation = "operationId: createRoom";
  if (!content.includes(operation)) {
    throw new Error(`expected compatibility fixture operation ${operation}`);
  }
  return content.replace(operation, "operationId: createRoomHostedProbe");
}

async function createProbeCommit(
  client,
  {
    repository,
    parentSha,
    generatedFile,
    generatedContent,
    compatibilityFile,
    compatibilityContent,
    marker,
  },
) {
  const parentCommit = await client.getCommit(repository, parentSha);
  const generatedBlob = await client.createBlob(
    repository,
    Buffer.from(
      buildStaleGeneratedContent(generatedContent, marker),
      "utf8",
    ).toString("base64"),
  );
  const compatibilityBlob = await client.createBlob(
    repository,
    Buffer.from(
      buildBreakingCompatibilityContent(compatibilityContent),
      "utf8",
    ).toString("base64"),
  );
  const tree = await client.createTree(
    repository,
    [
      {
        path: generatedFile,
        mode: "100644",
        type: "blob",
        sha: generatedBlob.sha,
      },
      {
        path: compatibilityFile,
        mode: "100644",
        type: "blob",
        sha: compatibilityBlob.sha,
      },
    ],
    parentCommit.tree.sha,
  );
  return client.createCommit(
    repository,
    `test: stale generated client event probe (${marker})`,
    tree.sha,
    [parentSha],
  );
}

function repositoryFromOptions(options) {
  return (
    options.repository ??
    process.env.GITHUB_REPOSITORY ??
    (() => {
      throw new Error(
        "repository is required; pass --repo OWNER/REPOSITORY or set GITHUB_REPOSITORY",
      );
    })()
  );
}

async function cleanupProbe(client, repository, { branch, pullRequestNumber }) {
  const failures = [];
  let pullRequestClosed = pullRequestNumber === undefined;
  let branchDeleted = false;

  if (pullRequestNumber !== undefined) {
    try {
      await client.updatePullRequest(repository, pullRequestNumber, {
        state: "closed",
      });
      const pullRequest = await client.getPullRequest(
        repository,
        pullRequestNumber,
      );
      pullRequestClosed =
        pullRequest.state === "closed" && pullRequest.merged !== true;
      if (!pullRequestClosed) {
        failures.push(
          `pull request #${pullRequestNumber} was not confirmed closed and unmerged`,
        );
      }
    } catch (error) {
      failures.push(
        `closing pull request #${pullRequestNumber}: ${error.message}`,
      );
    }
  }

  try {
    await client.deleteRef(repository, branch);
    branchDeleted =
      (await client.getOptionalRef(repository, `heads/${branch}`)) === null;
    if (!branchDeleted) {
      failures.push(`branch ${branch} still exists after deletion`);
    }
  } catch (error) {
    failures.push(`deleting branch ${branch}: ${error.message}`);
  }

  return { pullRequestClosed, branchDeleted, failures };
}

export async function runProbe(client, options, dependencies = {}) {
  const now = dependencies.now ?? (() => new Date());
  const repository = repositoryFromOptions(options);
  const baseBranch = options.baseBranch ?? DEFAULTS.baseBranch;
  const generatedFile = options.generatedFile ?? DEFAULTS.generatedFile;
  const compatibilityFile =
    options.compatibilityFile ?? DEFAULTS.compatibilityFile;
  const workflow = options.workflow ?? DEFAULTS.workflow;
  const branch = options.branch ?? makeBranchName();
  const marker = `${branch}-${now().toISOString()}`;
  const initialBody = makeInitialBody(branch, marker);
  const state = {
    branchCreated: false,
    pullRequestNumber: undefined,
  };
  let result;
  let probeError;

  try {
    const existingBranch = await client.getOptionalRef(
      repository,
      `heads/${branch}`,
    );
    if (existingBranch) {
      throw new Error(`refusing to reuse existing branch ${branch}`);
    }

    const baseRef = await client.getRef(repository, `heads/${baseBranch}`);
    const baseSha = baseRef.object.sha;
    const generatedSource = await client.getContent(
      repository,
      generatedFile,
      baseBranch,
    );
    const compatibilitySource = await client.getContent(
      repository,
      compatibilityFile,
      baseBranch,
    );
    if (
      Array.isArray(generatedSource) ||
      generatedSource.encoding !== "base64"
    ) {
      throw new Error(`expected ${generatedFile} to be a base64 file response`);
    }
    if (
      Array.isArray(compatibilitySource) ||
      compatibilitySource.encoding !== "base64"
    ) {
      throw new Error(
        `expected ${compatibilityFile} to be a base64 file response`,
      );
    }
    const generatedContent = Buffer.from(
      generatedSource.content.replace(/\s/g, ""),
      "base64",
    ).toString("utf8");
    const compatibilityContent = Buffer.from(
      compatibilitySource.content.replace(/\s/g, ""),
      "base64",
    ).toString("utf8");
    const initialCommit = await createProbeCommit(client, {
      repository,
      parentSha: baseSha,
      generatedFile,
      generatedContent,
      compatibilityFile,
      compatibilityContent,
      marker: `${marker}-opened`,
    });
    await client.createRef(repository, branch, initialCommit.sha);
    state.branchCreated = true;

    const openedAt = now().toISOString();
    const pullRequest = await client.createPullRequest(
      repository,
      `test: API codegen stale-client event probe (${marker})`,
      branch,
      baseBranch,
      initialBody,
    );
    state.pullRequestNumber = pullRequest.number;
    const openedRun = await waitForWorkflowRun(client, {
      repository,
      workflow,
      branch,
      headSha: initialCommit.sha,
      pullRequestNumber: pullRequest.number,
      after: openedAt,
      timeoutMs: options.timeoutSeconds * 1000,
      pollMs: options.pollSeconds * 1000,
    });
    const openedJobs = await client.listJobs(repository, openedRun.id);
    const events = [
      workflowRunEvidence("opened", openedRun, openedJobs, "failure"),
    ];

    const synchronizeAt = now().toISOString();
    const synchronizeCommit = await createProbeCommit(client, {
      repository,
      parentSha: initialCommit.sha,
      generatedFile,
      generatedContent,
      compatibilityFile,
      compatibilityContent,
      marker: `${marker}-synchronize`,
    });
    await client.updateRef(repository, branch, synchronizeCommit.sha);
    const synchronizeRun = await waitForWorkflowRun(client, {
      repository,
      workflow,
      branch,
      headSha: synchronizeCommit.sha,
      pullRequestNumber: pullRequest.number,
      after: synchronizeAt,
      excludedRunIds: new Set(events.map(({ workflowRun }) => workflowRun.id)),
      timeoutMs: options.timeoutSeconds * 1000,
      pollMs: options.pollSeconds * 1000,
    });
    const synchronizeJobs = await client.listJobs(
      repository,
      synchronizeRun.id,
    );
    events.push(
      workflowRunEvidence(
        "synchronize",
        synchronizeRun,
        synchronizeJobs,
        "failure",
      ),
    );

    const reopenedAt = now().toISOString();
    await client.updatePullRequest(repository, pullRequest.number, {
      state: "closed",
    });
    await client.updatePullRequest(repository, pullRequest.number, {
      state: "open",
    });
    const reopenedRun = await waitForWorkflowRun(client, {
      repository,
      workflow,
      branch,
      headSha: synchronizeCommit.sha,
      pullRequestNumber: pullRequest.number,
      after: reopenedAt,
      excludedRunIds: new Set(events.map(({ workflowRun }) => workflowRun.id)),
      timeoutMs: options.timeoutSeconds * 1000,
      pollMs: options.pollSeconds * 1000,
    });
    const reopenedJobs = await client.listJobs(repository, reopenedRun.id);
    events.push(
      workflowRunEvidence("reopened", reopenedRun, reopenedJobs, "failure"),
    );

    const editedAt = now().toISOString();
    await client.updatePullRequest(repository, pullRequest.number, {
      body: makeEditedBody(initialBody, marker),
    });
    const editedRun = await waitForWorkflowRun(client, {
      repository,
      workflow,
      branch,
      headSha: synchronizeCommit.sha,
      pullRequestNumber: pullRequest.number,
      after: editedAt,
      excludedRunIds: new Set(events.map(({ workflowRun }) => workflowRun.id)),
      timeoutMs: options.timeoutSeconds * 1000,
      pollMs: options.pollSeconds * 1000,
    });
    const editedJobs = await client.listJobs(repository, editedRun.id);
    events.push(
      workflowRunEvidence("edited", editedRun, editedJobs, "success"),
    );
    result = {
      repository,
      branch,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.html_url,
        merged: false,
      },
      events,
    };
  } catch (error) {
    probeError = error;
  } finally {
    if (state.branchCreated) {
      const cleanup = await cleanupProbe(client, repository, {
        branch,
        pullRequestNumber: state.pullRequestNumber,
      });
      result = { ...result, cleanup };
      if (cleanup.failures.length > 0) {
        const cleanupError = new Error(
          `probe cleanup was not confirmed: ${cleanup.failures.join("; ")}`,
        );
        probeError = probeError
          ? new AggregateError([probeError, cleanupError], probeError.message)
          : cleanupError;
      }
      if (!cleanup.pullRequestClosed || !cleanup.branchDeleted) {
        const cleanupError = new Error(
          "probe refused to report success because cleanup was not confirmed",
        );
        probeError = probeError
          ? new AggregateError([probeError, cleanupError], probeError.message)
          : cleanupError;
      }
    }
  }

  if (probeError) {
    throw probeError;
  }
  if (!result?.cleanup?.pullRequestClosed || !result.cleanup.branchDeleted) {
    throw new Error(
      "probe refused to report success because cleanup was not confirmed",
    );
  }
  return result;
}

function usage() {
  return `Usage:
  GITHUB_TOKEN=... GITHUB_REPOSITORY=OWNER/REPOSITORY \\
    node scripts/probe-api-codegen-events.mjs [options]

Creates a temporary stale generated-client pull request, emits an edited event,
validates all four configured pull-request events, records each failed
verification step and job URL, and closes/deletes all temporary resources before
succeeding.

Options:
  --repo OWNER/REPOSITORY       Repository (defaults to GITHUB_REPOSITORY)
  --base BRANCH                 Base branch (default: development)
  --generated-file PATH         Generated file to make stale
  --compatibility-file PATH     OpenAPI file to make temporarily breaking
  --workflow PATH               Workflow file (default: .github/workflows/api-codegen.yml)
  --branch NAME                 Temporary branch name
  --poll-seconds N              Poll interval (default: 10)
  --timeout-seconds N           Timeout for each hosted run (default: 900)
  --output PATH                 Write the successful JSON record to this file
  --dry-run                     Print the plan without calling GitHub
  --help                        Show this help
`;
}

async function main() {
  const { options, showHelp } = parseArgs(process.argv.slice(2));
  if (showHelp) {
    console.log(usage());
    return;
  }
  const repository = repositoryFromOptions(options);
  const branch = options.branch ?? makeBranchName();
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          repository,
          branch,
          baseBranch: options.baseBranch,
          generatedFile: options.generatedFile,
          compatibilityFile: options.compatibilityFile,
          workflow: options.workflow,
          cleanup: "close pull request and confirm branch deletion",
        },
        null,
        2,
      ),
    );
    return;
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN or GH_TOKEN is required");
  }
  const client = new GitHubClient({
    token,
    apiUrl: process.env.GITHUB_API_URL,
  });
  const result = await runProbe(client, { ...options, repository, branch });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    const outputPath = resolve(options.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized, { encoding: "utf8", mode: 0o600 });
  }
  console.log(serialized);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`API codegen event probe failed: ${error.message}`);
    process.exitCode = 1;
  });
}
