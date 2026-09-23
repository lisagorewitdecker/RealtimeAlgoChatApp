import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const checkRunName = "Native evidence summary bytes";
export const checkRunTitle = "Verified bounded native evidence summary";
export const checkRunSummaryLimit = 65535;

function writeLine(stream, message) {
  stream.write(`${message}\n`);
}

function requiredEnvironment(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} must be set to publish the native evidence summary.`);
  }
  return value;
}

function readResolvedCommitSha(summary) {
  const match = summary.match(
    /^- Resolved commit SHA: `([0-9a-f]{40})`$/m,
  );
  if (!match) {
    throw new Error(
      "The captured native evidence summary does not contain a valid resolved commit SHA.",
    );
  }
  return match[1];
}

export async function main({
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let capturePath;
  let repository;
  let token;
  try {
    capturePath = requiredEnvironment(
      env,
      "NATIVE_EVIDENCE_SUMMARY_CAPTURE_PATH",
    );
    repository = requiredEnvironment(env, "GITHUB_REPOSITORY");
    token = requiredEnvironment(env, "GITHUB_TOKEN");
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (!existsSync(capturePath)) {
    writeLine(
      stderr,
      `The native evidence summary capture does not exist at ${capturePath}.`,
    );
    return 1;
  }

  let summary;
  try {
    summary = readFileSync(capturePath, "utf8");
  } catch (error) {
    writeLine(
      stderr,
      `Could not read the native evidence summary capture: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  if (summary.length === 0) {
    writeLine(stderr, "The native evidence summary capture is empty.");
    return 1;
  }
  if (summary.length > checkRunSummaryLimit) {
    writeLine(
      stderr,
      `The native evidence summary capture exceeds GitHub's ${checkRunSummaryLimit}-character check-run limit.`,
    );
    return 1;
  }

  let headSha;
  try {
    headSha = readResolvedCommitSha(summary);
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (typeof fetchImpl !== "function") {
    writeLine(stderr, "fetch is not available to publish the native evidence summary.");
    return 1;
  }

  const apiUrl = (env.GITHUB_API_URL || "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  let response;
  try {
    response = await fetchImpl(`${apiUrl}/repos/${repository}/check-runs`, {
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
        conclusion: "success",
        output: {
          title: checkRunTitle,
          summary,
        },
      }),
    });
  } catch (error) {
    writeLine(
      stderr,
      `Could not reach GitHub to publish the native evidence summary: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  if (!response.ok) {
    writeLine(
      stderr,
      `GitHub rejected the native evidence summary check run with status ${response.status}.`,
    );
    return 1;
  }

  let created = {};
  try {
    created = JSON.parse(await response.text());
  } catch {
    // The check run was accepted even if GitHub returned no JSON body.
  }
  writeLine(
    stdout,
    `Published the "${checkRunName}" check run for ${headSha}${
      created.html_url ? `: ${created.html_url}` : "."
    }`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}