import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  buildDriftSummary,
  checkRunSummaryLimit,
  driftSummaryTitle,
} from "./drift-summary.mjs";

export const checkRunName = "Generated client drift evidence";

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeLine(stream, message) {
  stream.write(`${message}\n`);
}

function readRequiredEnvironment(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(
      `${name} must be set to publish the generated-client drift evidence.`,
    );
  }
  return value;
}

export async function main({
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const reportPath = env.API_CODEGEN_DRIFT_REPORT_PATH;
  if (!reportPath) {
    writeLine(
      stderr,
      "API_CODEGEN_DRIFT_REPORT_PATH is not set, so there is no generated-client drift report to publish.",
    );
    return 1;
  }

  if (!existsSync(reportPath)) {
    writeLine(
      stdout,
      `No generated-client drift report at ${reportPath}; nothing to publish.`,
    );
    return 0;
  }

  let report;
  try {
    report = readFileSync(reportPath, "utf8").trimEnd();
  } catch (error) {
    writeLine(
      stderr,
      `Could not read the generated-client drift report at ${reportPath}: ${describeError(error)}`,
    );
    return 1;
  }

  if (report.length === 0) {
    writeLine(
      stdout,
      `The generated-client drift report at ${reportPath} is empty; nothing to publish.`,
    );
    return 0;
  }

  let repository;
  let token;
  let headSha;
  try {
    repository = readRequiredEnvironment(env, "GITHUB_REPOSITORY");
    token = readRequiredEnvironment(env, "GITHUB_TOKEN");
    headSha =
      env.API_CODEGEN_DRIFT_HEAD_SHA ?? readRequiredEnvironment(env, "GITHUB_SHA");
  } catch (error) {
    writeLine(stderr, describeError(error));
    return 1;
  }

  if (typeof fetchImpl !== "function") {
    writeLine(
      stderr,
      "fetch is not available to publish the generated-client drift evidence.",
    );
    return 1;
  }

  const apiUrl = (env.GITHUB_API_URL || "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  const summary = buildDriftSummary(report, { limit: checkRunSummaryLimit });

  let response;
  try {
    response = await fetchImpl(`${apiUrl}/repos/${repository}/check-runs`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        name: checkRunName,
        head_sha: headSha,
        status: "completed",
        conclusion: "failure",
        output: { title: driftSummaryTitle, summary },
      }),
    });
  } catch (error) {
    writeLine(
      stderr,
      `Could not reach GitHub to publish the generated-client drift evidence: ${describeError(error)}`,
    );
    return 1;
  }

  const body = await response.text().catch(() => "");
  if (!response.ok) {
    writeLine(
      stderr,
      `GitHub rejected the generated-client drift evidence check run with status ${response.status}: ${body.replace(/\s+/g, " ").slice(0, 500)}`,
    );
    return 1;
  }

  let created = {};
  try {
    created = JSON.parse(body);
  } catch {
    created = {};
  }

  writeLine(
    stdout,
    `Published the "${checkRunName}" check run for ${headSha}${created.html_url ? `: ${created.html_url}` : "."}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
