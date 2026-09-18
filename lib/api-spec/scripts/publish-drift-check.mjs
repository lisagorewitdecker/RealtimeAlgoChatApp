// Publishes the bounded generated-client drift report as its own GitHub check
// run. A reviewer can then read the changed generated paths, the bounded
// report, and the regeneration command from the pull request's Checks tab and
// from the public check-runs API, without downloading job logs.

import { existsSync, readFileSync } from "node:fs";
import {
  buildDriftSummary,
  checkRunSummaryLimit,
  driftSummaryTitle,
} from "./drift-summary.mjs";

export const checkRunName = "Generated client drift evidence";

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function readRequiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} must be set to publish the generated-client drift evidence.`,
    );
  }
  return value;
}

async function main() {
  const reportPath = process.env.API_CODEGEN_DRIFT_REPORT_PATH;
  if (!reportPath) {
    console.error(
      "API_CODEGEN_DRIFT_REPORT_PATH is not set, so there is no generated-client drift report to publish.",
    );
    return 1;
  }

  if (!existsSync(reportPath)) {
    // The verification step also fails for reasons other than drift, such as
    // codegen itself failing. There is no drift evidence to publish then.
    console.log(
      `No generated-client drift report at ${reportPath}; nothing to publish.`,
    );
    return 0;
  }

  let report;
  try {
    report = readFileSync(reportPath, "utf8").trimEnd();
  } catch (error) {
    console.error(
      `Could not read the generated-client drift report at ${reportPath}: ${describeError(error)}`,
    );
    return 1;
  }

  if (report.length === 0) {
    console.log(
      `The generated-client drift report at ${reportPath} is empty; nothing to publish.`,
    );
    return 0;
  }

  let repository;
  let token;
  let headSha;
  try {
    repository = readRequiredEnvironment("GITHUB_REPOSITORY");
    token = readRequiredEnvironment("GITHUB_TOKEN");
    headSha =
      process.env.API_CODEGEN_DRIFT_HEAD_SHA ||
      readRequiredEnvironment("GITHUB_SHA");
  } catch (error) {
    console.error(describeError(error));
    return 1;
  }

  const apiUrl = (process.env.GITHUB_API_URL || "https://api.github.com")
    .replace(/\/+$/, "");
  const summary = buildDriftSummary(report, { limit: checkRunSummaryLimit });

  let response;
  try {
    response = await fetch(`${apiUrl}/repos/${repository}/check-runs`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
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
    console.error(
      `Could not reach GitHub to publish the generated-client drift evidence: ${describeError(error)}`,
    );
    return 1;
  }

  const body = await response.text().catch(() => "");
  if (!response.ok) {
    // The response body can echo the request, so it is bounded and never
    // printed alongside the token that produced it.
    console.error(
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
  console.log(
    `Published the "${checkRunName}" check run for ${headSha}${created.html_url ? `: ${created.html_url}` : "."}`,
  );
  return 0;
}

process.exit(await main());
