#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import YAML from "yaml";

const workspace = resolve(
  process.env.REPOSITORY_INTEGRITY_WORKSPACE ?? process.cwd(),
);
const SHELL_EXTENSIONS = new Set([".bash", ".sh"]);
const JAVASCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

function trackedPaths() {
  try {
    return execFileSync("git", ["ls-files", "-z"], {
      cwd: workspace,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown Git error";
    throw new Error(`could not list tracked files: ${detail}`);
  }
}

function extension(path) {
  const match = basename(path).match(/(\.[^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function isJsonManifest(path) {
  return extension(path) === ".json";
}

function isYamlLockfile(path) {
  return /(?:^|[-_.])lock\.ya?ml$/i.test(path);
}

function isJavaScript(path) {
  return JAVASCRIPT_EXTENSIONS.has(extension(path));
}

function hasShellShebang(source) {
  const firstLine = source.toString("utf8").split("\n", 1)[0];
  return /^#!.*(?:^|[/\s])(ba|da|k|z)?sh(?:\s|$)/.test(firstLine);
}

function isShell(path, source) {
  return SHELL_EXTENSIONS.has(extension(path)) || hasShellShebang(source);
}

function divisors(value) {
  const result = new Set();
  for (let divisor = 1; divisor * divisor <= value; divisor += 1) {
    if (value % divisor !== 0) {
      continue;
    }
    result.add(divisor);
    result.add(value / divisor);
  }
  return [...result].sort((left, right) => left - right);
}

function equalsRepeated(source, unitLength, copies) {
  const unit = source.subarray(0, unitLength);
  for (let copy = 1; copy < copies; copy += 1) {
    const start = copy * unitLength;
    if (!source.subarray(start, start + unitLength).equals(unit)) {
      return false;
    }
  }
  return true;
}

function repeatedContent(source) {
  if (source.length < 2) {
    return null;
  }

  // Check the exact byte-length ratio before comparing any content. This
  // keeps the common, non-repeated case bounded by the number of divisors.
  for (const copies of divisors(source.length).filter((value) => value >= 2)) {
    const unitLength = source.length / copies;
    if (equalsRepeated(source, unitLength, copies)) {
      return {
        copies,
        shape: "verbatim",
      };
    }
  }

  // A merge can remove the first copy's final newline before appending the
  // next copy. Account for both common newline encodings while retaining the
  // same integer-ratio fast path.
  for (const newline of [Buffer.from("\r\n"), Buffer.from("\n")]) {
    if (source.length <= newline.length) {
      continue;
    }
    const normalizedLength = source.length + newline.length;
    for (const copies of divisors(normalizedLength).filter(
      (value) => value >= 2,
    )) {
      const unitLength = normalizedLength / copies;
      if (unitLength <= newline.length) {
        continue;
      }
      const unit = Buffer.concat([
        source.subarray(0, unitLength - newline.length),
        newline,
      ]);
      const joined = Buffer.concat([
        unit.subarray(0, unit.length - newline.length),
        ...Array.from({ length: copies - 1 }, () => unit),
      ]);
      if (joined.equals(source)) {
        return {
          copies,
          shape: "mid-line",
        };
      }
    }
  }

  return null;
}

function readTrackedFile(path) {
  try {
    return { source: readFileSync(resolve(workspace, path)), problem: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { source: null, problem: `could not read file: ${detail}` };
  }
}

function parseJson(source) {
  try {
    JSON.parse(source.toString("utf8"));
    return null;
  } catch (error) {
    return `JSON parse error: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function parseYaml(path, source) {
  try {
    const document = YAML.parseDocument(source.toString("utf8"), {
      prettyErrors: false,
    });
    if (document.errors.length > 0) {
      return `YAML parse error: ${document.errors
        .map((error) => error.message)
        .join("; ")}`;
    }
    return null;
  } catch (error) {
    return `YAML parse error: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function syntaxCheck(path, source, kind) {
  const command = kind === "shell" ? "bash" : process.execPath;
  const args = kind === "shell" ? ["-n", path] : ["--check", path];
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return null;
  }
  const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
  return `${kind} syntax error: ${
    detail || `command exited with status ${result.status ?? "unknown"}`
  }`;
}

function main() {
  const paths = trackedPaths();
  const failures = [];
  let textFileCount = 0;
  const jsonPaths = new Set();
  const yamlPaths = new Set();
  const shellPaths = new Set();
  const javascriptPaths = new Set();

  for (const path of paths) {
    const { source, problem } = readTrackedFile(path);
    if (problem) {
      failures.push({ path, problem });
      continue;
    }

    if (!source.includes(0)) {
      textFileCount += 1;
      const repetition = repeatedContent(source);
      if (repetition) {
        failures.push({
          path,
          problem: `whole-file self-repetition: ${repetition.copies} ${repetition.shape} copies`,
        });
      }
    }

    if (isJsonManifest(path)) {
      jsonPaths.add(path);
    }
    if (isYamlLockfile(path)) {
      yamlPaths.add(path);
    }
    if (isShell(path, source)) {
      shellPaths.add(path);
    }
    if (isJavaScript(path)) {
      javascriptPaths.add(path);
    }
  }

  for (const path of jsonPaths) {
    const { source, problem } = readTrackedFile(path);
    if (problem) {
      failures.push({ path, problem });
    } else {
      const parseProblem = parseJson(source);
      if (parseProblem) {
        failures.push({ path, problem: parseProblem });
      }
    }
  }

  for (const path of yamlPaths) {
    const { source, problem } = readTrackedFile(path);
    if (problem) {
      failures.push({ path, problem });
    } else {
      const parseProblem = parseYaml(path, source);
      if (parseProblem) {
        failures.push({ path, problem: parseProblem });
      }
    }
  }

  for (const path of shellPaths) {
    const problem = syntaxCheck(path, null, "shell");
    if (problem) {
      failures.push({ path, problem });
    }
  }

  for (const path of javascriptPaths) {
    const problem = syntaxCheck(path, null, "JavaScript");
    if (problem) {
      failures.push({ path, problem });
    }
  }

  if (failures.length > 0) {
    console.error("Repository integrity validation failed:");
    for (const { path, problem } of failures) {
      console.error(`- ${path}: ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Repository integrity validated ${paths.length} tracked file(s), including ${textFileCount} text file(s).`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `Repository integrity validation failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}