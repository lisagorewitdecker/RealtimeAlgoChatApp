#!/usr/bin/env node

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS = {
  baseBranch: "development",
  generatedFile: "lib/api-client-react/src/generated/api.schemas.ts",
  compatibilityFile: "lib/api-spec/openapi.yaml",
  workflow: ".github/workflows/api-codegen.yml",
  pollSeconds: 10,
  timeoutSeconds: 900,
  recordFormat: "markdown",
};

const RETRYABLE_GET_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_GET_RETRY_DEADLINE_MS = 30_000;
const DEFAULT_GET_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_GET_RETRY_MAX_DELAY_MS = 2_000;

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

function getResponseHeader(response, name) {
  return (
    response.headers?.get?.(name) ??
    response.headers?.[name] ??
    response.headers?.[name.toLowerCase()] ??
    null
  );
}

function getRetryAfterMs(response, nowMs) {
  const value = getResponseHeader(response, "retry-after");
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

function isRetryableGetResponse(response, nowMs) {
  if (RETRYABLE_GET_STATUS_CODES.has(response.status)) {
    return true;
  }
  return (
    response.status === 403 &&
    (getResponseHeader(response, "x-ratelimit-remaining") === "0" ||
      getRetryAfterMs(response, nowMs) !== null)
  );
}

class GitHubRequestTimeoutError extends GitHubApiError {
  constructor(path) {
    super(`GitHub GET ${path} exceeded its retry deadline`, 408, path);
    this.name = "GitHubRequestTimeoutError";
  }
}

class GitHubTransportError extends Error {
  constructor(cause) {
    super(cause?.message ?? "GitHub request failed");
    this.name = "GitHubTransportError";
    this.cause = cause;
  }
}

class GitHubResponseBodyError extends Error {
  constructor(cause) {
    super(cause?.message ?? "GitHub response body could not be read");
    this.name = "GitHubResponseBodyError";
    this.cause = cause;
  }
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch (error) {
    throw new GitHubResponseBodyError(error);
  }
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw error;
    }
    throw new GitHubResponseBodyError(error);
  }
}

function unwrapRequestError(error) {
  return error instanceof GitHubTransportError ||
    error instanceof GitHubResponseBodyError
    ? error.cause
    : error;
}

export class GitHubClient {
  constructor({
    token,
    apiUrl = "https://api.github.com",
    fetchImpl = fetch,
    sleepImpl = wait,
    nowImpl = Date.now,
    retryDeadlineMs = DEFAULT_GET_RETRY_DEADLINE_MS,
    retryBaseDelayMs = DEFAULT_GET_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = DEFAULT_GET_RETRY_MAX_DELAY_MS,
  }) {
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
    this.nowImpl = nowImpl;
    this.retryDeadlineMs = retryDeadlineMs;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.retryMaxDelayMs = retryMaxDelayMs;
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
  }

  async fetchWithDeadline(
    url,
    requestInit,
    deadlineAt,
    path,
    consumeResponse,
  ) {
    if (deadlineAt === undefined) {
      const response = await this.fetchImpl(url, requestInit);
      return consumeResponse(response);
    }

    const remainingMs = deadlineAt - this.nowImpl();
    if (remainingMs <= 0) {
      throw new GitHubRequestTimeoutError(path);
    }

    const controller = new AbortController();
    let timer;
    const fetchPromise = Promise.resolve()
      .then(() =>
        this.fetchImpl(url, { ...requestInit, signal: controller.signal }),
      )
      .catch((error) => {
        throw new GitHubTransportError(error);
      })
      .then((response) => consumeResponse(response));
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GitHubRequestTimeoutError(path));
      }, remainingMs);
    });
    try {
      return await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  async waitBeforeRetry(deadlineAt, attempt, retryAfterMs = null) {
    const remainingMs = deadlineAt - this.nowImpl();
    if (remainingMs <= 0) {
      return false;
    }
    const backoffMs = Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * 2 ** attempt,
    );
    const delayMs = Math.min(
      remainingMs,
      Math.max(backoffMs, retryAfterMs ?? 0),
    );
    if (delayMs <= 0) {
      return false;
    }
    await this.sleepImpl(delayMs);
    return this.nowImpl() < deadlineAt;
  }

  async request(
    path,
    { method = "GET", body, allowNotFound = false, deadlineAt } = {},
  ) {
    const safeGet = method === "GET";
    const retryDeadline = safeGet
      ? (deadlineAt ?? this.nowImpl() + this.retryDeadlineMs)
      : undefined;
    let attempt = 0;

    while (true) {
      if (safeGet && this.nowImpl() >= retryDeadline) {
        throw new GitHubRequestTimeoutError(path);
      }
      const requestInit = {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      };
      let outcome;
      const consumeResponse = async (response) => {
        if (response.status === 404 && allowNotFound) {
          return { kind: "value", value: null };
        }
        if (!response.ok) {
          return {
            kind: "http-error",
            response,
            text: await readResponseText(response),
          };
        }
        return {
          kind: "value",
          value:
            response.status === 204
              ? undefined
              : await readResponseJson(response),
        };
      };
      try {
        outcome = await this.fetchWithDeadline(
          `${this.apiUrl}${path}`,
          requestInit,
          retryDeadline,
          path,
          consumeResponse,
        );
      } catch (error) {
        if (
          !safeGet ||
          (!(error instanceof GitHubTransportError) &&
            !(error instanceof GitHubResponseBodyError)) ||
          error instanceof GitHubRequestTimeoutError ||
          this.nowImpl() >= retryDeadline
        ) {
          throw unwrapRequestError(error);
        }
        if (!(await this.waitBeforeRetry(retryDeadline, attempt))) {
          throw unwrapRequestError(error);
        }
        attempt += 1;
        continue;
      }

      if (outcome.kind === "value") {
        return outcome.value;
      }
      if (outcome.kind === "http-error") {
        const { response, text } = outcome;
        const shouldRetry =
          safeGet &&
          isRetryableGetResponse(response, this.nowImpl()) &&
          this.nowImpl() < retryDeadline;
        if (shouldRetry) {
          const retryAfterMs = getRetryAfterMs(response, this.nowImpl());
          if (
            await this.waitBeforeRetry(
              retryDeadline,
              attempt,
              retryAfterMs,
            )
          ) {
            attempt += 1;
            continue;
          }
        }
        throw new GitHubApiError(
          `GitHub ${method} ${path} failed with HTTP ${response.status}${describeResponseBody(text)}`,
          response.status,
          path,
        );
      }
      throw new Error("GitHub request returned an unknown response outcome");
    }
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

  listWorkflowRuns(repository, workflow, branch, options = {}) {
    const workflowIdentifier = workflow.split("/").at(-1);
    return this.request(
      `/repos/${repository}/actions/workflows/${encodeURIComponent(
        workflowIdentifier,
      )}/runs?event=pull_request&branch=${encodeURIComponent(
        branch,
      )}&per_page=100`,
      options,
    );
  }

  getWorkflowRun(repository, runId, options = {}) {
    return this.request(`/repos/${repository}/actions/runs/${runId}`, options);
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
    if (argument === "--overwrite") {
      options.overwrite = true;
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
      "--record-output": "recordOutput",
      "--record-dir": "recordDir",
      "--record-format": "recordFormat",
    };
    const optionName = optionValues[argument];
    if (optionName) {
      if (!next || next.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      options[optionName] = next;
      if (optionName === "recordFormat") {
        options.recordFormatExplicit = true;
      }
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

function formatRecordTimestamp(value) {
  return value
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function validateRecordFormat(format) {
  if (format !== "markdown" && format !== "json") {
    throw new Error(`record format must be "markdown" or "json"`);
  }
  return format;
}

function recordFormatForPath(path, requestedFormat) {
  if (requestedFormat) {
    return validateRecordFormat(requestedFormat);
  }
  return extname(path).toLowerCase() === ".json" ? "json" : "markdown";
}

function markdownLink(label, url) {
  return url ? `[${label}](${url})` : label;
}

export function formatMarkdownEvidence(result) {
  const lines = [
    "# API generated-client pull-request event probe",
    "",
    "**Result: PASS — the hosted probe captured four pull-request events and confirmed cleanup.**",
    "",
    "This record contains reviewable GitHub metadata only. It does not include the",
    "temporary pull-request description or its declaration values.",
    "",
    "## Metadata",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Checked at (UTC) | ${result.checkedAt ?? "Not recorded"} |`,
    `| Repository | \`${result.repository}\` |`,
    `| Probe branch | \`${result.branch}\` |`,
    `| Probe pull request | ${markdownLink(`#${result.pullRequest.number}`, result.pullRequest.url)} (closed unmerged) |`,
    "",
    "## Acceptance result",
    "",
    "| Event | Workflow run | Check-generated job | Failed step | Compatibility |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const event of result.events ?? []) {
    lines.push(
      `| ${event.event} | ${markdownLink(`#${event.workflowRun.id}`, event.workflowRun.url)} | ${markdownLink(`${event.job.name} (#${event.job.id})`, event.job.url)} | \`${event.step.name}\`: **${event.step.conclusion}** | \`${event.compatibility.name}\`: **${event.compatibility.conclusion}** |`,
    );
  }

  lines.push(
    "",
    "## Cleanup",
    "",
    `- Pull request closed without merging: **${result.cleanup?.pullRequestClosed === true ? "confirmed" : "not confirmed"}**.`,
    `- Temporary branch deleted: **${result.cleanup?.branchDeleted === true ? "confirmed" : "not confirmed"}**.`,
    `- Cleanup failures: **${result.cleanup?.failures?.length ? result.cleanup.failures.join("; ") : "none"}**.`,
    "",
  );
  return lines.join("\n");
}

export function serializeEvidenceRecord(result, format) {
  const validatedFormat = validateRecordFormat(format);
  return validatedFormat === "json"
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${formatMarkdownEvidence(result)}\n`;
}

function writeSafely(path, content, overwrite) {
  mkdirSync(dirname(path), { recursive: true });
  if (!overwrite) {
    try {
      writeFileSync(path, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(
          `refusing to overwrite existing evidence record ${path}; pass --overwrite to replace it`,
        );
      }
      throw error;
    }
    return;
  }

  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      // Best effort cleanup; preserve the original error.
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file was either never created or was already removed.
    }
    throw error;
  }
}

export function writeEvidenceRecord(path, result, format, overwrite = false) {
  const outputPath = resolve(path);
  writeSafely(
    outputPath,
    serializeEvidenceRecord(result, format),
    overwrite,
  );
  return outputPath;
}

export function resolveRecordOutput(options, checkedAt) {
  if (options.recordOutput && options.recordDir) {
    throw new Error("--record-output and --record-dir cannot be used together");
  }
  if (options.recordOutput) {
    return resolve(options.recordOutput);
  }
  if (options.recordDir) {
    const format = validateRecordFormat(options.recordFormat);
    return resolve(
      join(
        options.recordDir,
        `api-codegen-event-probe-${formatRecordTimestamp(checkedAt)}.${format === "json" ? "json" : "md"}`,
      ),
    );
  }
  return undefined;
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
  const job = jobsResponse.jobs?.find(
    (candidate) => candidate.name === "Check generated API clients",
  );
  const step = job?.steps?.find(
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
      { deadlineAt: deadline },
    );
    candidate = findMatchingWorkflowRun(response.workflow_runs, {
      branch,
      headSha,
      pullRequestNumber,
      after,
      excludedRunIds,
    });
    if (candidate) {
      const current = await client.getWorkflowRun(repository, candidate.id, {
        deadlineAt: deadline,
      });
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
  const checkedAt = now().toISOString();
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
      checkedAt,
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
  --output PATH                 Write the successful JSON result to this file
  --record-output PATH          Write a reviewable Markdown or JSON evidence record
  --record-dir DIR              Write a UTC-dated evidence record inside DIR
  --record-format FORMAT        markdown or json (default: markdown for --record-dir)
  --overwrite                   Allow replacing an existing output or evidence record
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
          recordOutput: options.recordOutput,
          recordDir: options.recordDir,
          recordFormat: options.recordFormat,
          overwrite: options.overwrite === true,
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
    writeSafely(resolve(options.output), serialized, options.overwrite === true);
  }
  const recordPath = resolveRecordOutput(options, new Date(result.checkedAt));
  if (recordPath) {
    const recordFormat = recordFormatForPath(
      recordPath,
      options.recordFormatExplicit ? options.recordFormat : undefined,
    );
    writeEvidenceRecord(
      recordPath,
      result,
      recordFormat,
      options.overwrite === true,
    );
    console.error(`Wrote API codegen event evidence record: ${recordPath}`);
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
