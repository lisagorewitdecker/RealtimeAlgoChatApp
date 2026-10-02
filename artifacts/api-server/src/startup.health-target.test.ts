import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const artifactPath = fileURLToPath(
  new URL("../.replit-artifact/artifact.toml", import.meta.url),
);
const artifactSource = readFileSync(artifactPath, "utf8");

function readStartupHealthSection(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const sectionHeader = "[services.production.health.startup]";
  const sectionStart = lines.indexOf(sectionHeader);

  if (sectionStart === -1) {
    return [];
  }

  const sectionLines: string[] = [];
  for (const line of lines.slice(sectionStart + 1)) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      break;
    }
    sectionLines.push(line);
  }
  return sectionLines;
}

function readPathAssignments(sectionLines: string[]): string[] {
  return sectionLines.flatMap((line) => {
    const match = line.match(/^\s*path\s*=\s*"([^"]*)"\s*(?:#.*)?$/);
    return match ? [match[1]] : [];
  });
}

describe("API deployment health target", () => {
  it("uses the process liveness route instead of database readiness", () => {
    const sectionLines = readStartupHealthSection(artifactSource);
    expect(
      sectionLines.length,
      "artifact.toml must define [services.production.health.startup] so the deployment health target is explicit",
    ).toBeGreaterThan(0);

    const pathAssignments = readPathAssignments(sectionLines);
    expect(
      pathAssignments,
      "deployment health target must be exactly /api/livez; /api/healthz is database readiness and can falsely report a live process as offline",
    ).toEqual(["/api/livez"]);
  });
});