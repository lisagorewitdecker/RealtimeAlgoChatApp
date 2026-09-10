import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  extractBreakingChangeDeclaration,
  extractBreakingChangeJustification,
  findBreakingChanges,
  formatCompatibilityFailure,
  formatCompatibilityOverride,
  runCompatibilityCheck,
} from "./check-contract-compatibility.mjs";

const scriptPath = fileURLToPath(
  new URL("./check-contract-compatibility.mjs", import.meta.url),
);
const justification = "The existing contract is intentionally replaced by v2.";
const migrationPlan =
  "Clients switch to POST /v2/rooms; v1 stays available for one release.";

function parse(document) {
  return YAML.parse(document);
}

const baseDocument = `
openapi: 3.1.0
paths:
  /rooms:
    post:
      operationId: createRoom
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Room"
        "401":
          description: Unauthorized
components:
  schemas:
    Room:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
      required: [id, name]
`;

test("allows additive endpoints, optional fields, and response statuses", () => {
  const current = baseDocument
    .replace(
      `                name:
                  type: string
      responses:`,
      `                name:
                  type: string
                optional:
                  type: string
      responses:`,
    )
    .replace(
      `        name:
          type: string
      required: [id, name]`,
      `        name:
          type: string
        optional:
          type: string
      required: [id, name]`,
    )
    .replace(
      `        "401":
          description: Unauthorized`,
      `        "202":
          description: Accepted
        "401":
          description: Unauthorized`,
    )
    .replace(
      "paths:\n  /rooms:",
      `paths:
  /healthz:
    get:
      operationId: healthCheck
      responses:
        "200":
          description: Healthy
  /rooms:`,
    );
  assert.deepEqual(
    findBreakingChanges(parse(baseDocument), parse(current)),
    [],
  );
});

test("reports removed endpoints and changed operation identifiers", () => {
  const current = baseDocument
    .replace("      operationId: createRoom", "      operationId: addRoom")
    .replace("  /rooms:", "  /renamed-rooms:");
  const findings = findBreakingChanges(parse(baseDocument), parse(current));
  assert.match(findings.join("\n"), /POST \/rooms endpoint was removed/);
  assert.doesNotMatch(findings.join("\n"), /operationId changed/);

  const operationIdChange = findBreakingChanges(
    parse(baseDocument),
    parse(baseDocument.replace("createRoom", "addRoom")),
  );
  assert.match(
    operationIdChange.join("\n"),
    /operationId changed \(createRoom → addRoom\)/,
  );
});

test("reports incompatible request and response schema changes", () => {
  const current = baseDocument
    .replace("required: false", "required: true")
    .replace(
      "                name:\n                  type: string",
      "                name:\n                  type: integer",
    )
    .replace(
      "        id:\n          type: string",
      "        id:\n          type: integer",
    )
    .replace("      required: [id, name]", "      required: [id]");
  const findings = findBreakingChanges(parse(baseDocument), parse(current));
  assert.match(findings.join("\n"), /request body is now required/);
  assert.match(
    findings.join("\n"),
    /request schema .*name.*type changed incompatibly/,
  );
  assert.match(
    findings.join("\n"),
    /response "201" schema .*id.*type changed incompatibly/,
  );
  assert.match(
    findings.join("\n"),
    /response "201" schema .*property "name" is no longer guaranteed/,
  );
});

test("reports newly required request parameters", () => {
  const oldDocument = parse(`
openapi: 3.1.0
paths:
  /rooms:
    get:
      operationId: listRooms
      responses:
        "200":
          description: Rooms
`);
  const currentDocument = parse(`
openapi: 3.1.0
paths:
  /rooms:
    get:
      operationId: listRooms
      parameters:
        - in: query
          name: filter
          required: true
          schema:
            type: string
        - in: header
          name: X-Workspace
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Rooms
`);
  const findings = findBreakingChanges(oldDocument, currentDocument);
  assert.match(findings.join("\n"), /query:filter.*was added as required/);
  assert.match(
    findings.join("\n"),
    /header:X-Workspace.*was added as required/,
  );
});

test("reports removed request properties when additional properties are disallowed", () => {
  const oldDocument = parse(`
openapi: 3.1.0
paths:
  /rooms:
    post:
      operationId: updateRoom
      requestBody:
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              properties:
                legacyName:
                  type: string
                settings:
                  type: object
                  additionalProperties: false
                  properties:
                    color:
                      type: string
      responses:
        "204":
          description: Updated
`);
  const currentDocument = parse(`
openapi: 3.1.0
paths:
  /rooms:
    post:
      operationId: updateRoom
      requestBody:
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              properties:
                settings:
                  type: object
                  additionalProperties: false
                  properties: {}
      responses:
        "204":
          description: Updated
`);
  const findings = findBreakingChanges(oldDocument, currentDocument);
  assert.match(findings.join("\n"), /property "legacyName" was removed/);
  assert.match(findings.join("\n"), /settings.*property "color" was removed/);
});

test("reports response schemas that lose type and min/max constraints", () => {
  const oldDocument = parse(`
openapi: 3.1.0
paths:
  /value:
    get:
      operationId: getValue
      responses:
        "200":
          description: Value
          content:
            application/json:
              schema:
                type: string
                minLength: 2
                maxLength: 32
`);
  const currentDocument = parse(`
openapi: 3.1.0
paths:
  /value:
    get:
      operationId: getValue
      responses:
        "200":
          description: Value
          content:
            application/json:
              schema: {}
`);
  const findings = findBreakingChanges(oldDocument, currentDocument);
  assert.match(findings.join("\n"), /lost its restrictive type/);
  assert.match(findings.join("\n"), /constraint was removed: minLength/);
  assert.match(findings.join("\n"), /constraint was removed: maxLength/);
});

test("formats actionable failure output that asks for both override declarations", () => {
  const output = formatCompatibilityFailure(
    ["GET /rooms endpoint was removed"],
    "origin/development",
  );
  assert.match(
    output,
    /Breaking API contract changes detected against origin\/development/,
  );
  assert.match(output, /GET \/rooms endpoint was removed/);
  assert.match(output, /versioned API change/);
  assert.match(output, /add both lines to the pull request description/);
  assert.match(output, /^ {2}API_BREAKING_CHANGE_JUSTIFICATION: <.+>$/m);
  assert.match(output, /^ {2}API_BREAKING_CHANGE_MIGRATION_PLAN: <.+>$/m);
  assert.doesNotMatch(output, /override was rejected/);
});

test("explains which declaration an incomplete override omitted", () => {
  const output = formatCompatibilityFailure(
    ["GET /rooms endpoint was removed"],
    "origin/development",
    { justification, migrationPlan: null },
  );
  assert.match(
    output,
    /override was rejected because it omits the migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\)/,
  );
  assert.match(
    output,
    /- Justification \(API_BREAKING_CHANGE_JUSTIFICATION\): The existing contract is intentionally replaced by v2\./,
  );
  assert.match(
    output,
    /- Migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\): missing/,
  );
  assert.match(output, /add both lines to the pull request description/);
});

test("extracts the justification and migration plan from a pull request body", () => {
  const body = `
## Summary
This changes the API version.

API_BREAKING_CHANGE_JUSTIFICATION: ${justification}
API_BREAKING_CHANGE_MIGRATION_PLAN: ${migrationPlan}
`;
  assert.deepEqual(extractBreakingChangeDeclaration(body), {
    justification,
    migrationPlan,
  });
  assert.equal(extractBreakingChangeJustification(body), justification);

  assert.deepEqual(
    extractBreakingChangeDeclaration(
      `API_BREAKING_CHANGE_JUSTIFICATION: ${justification}\r\nAPI_BREAKING_CHANGE_MIGRATION_PLAN: ${migrationPlan}\r\n`,
    ),
    { justification, migrationPlan },
    "GitHub pull request bodies use CRLF line endings",
  );
});

test("treats empty declarations as missing", () => {
  assert.deepEqual(
    extractBreakingChangeDeclaration("API_BREAKING_CHANGE_JUSTIFICATION:   "),
    { justification: null, migrationPlan: null },
  );
  assert.deepEqual(extractBreakingChangeDeclaration("No override supplied"), {
    justification: null,
    migrationPlan: null,
  });
  assert.deepEqual(extractBreakingChangeDeclaration(undefined), {
    justification: null,
    migrationPlan: null,
  });
  assert.deepEqual(
    extractBreakingChangeDeclaration(
      `API_BREAKING_CHANGE_JUSTIFICATION:\nAPI_BREAKING_CHANGE_MIGRATION_PLAN: ${migrationPlan}\n`,
    ),
    { justification: null, migrationPlan },
    "an empty declaration must not swallow the next marker line as its value",
  );
});

test("formats an override with every changed contract and both pieces of review evidence", () => {
  const output = formatCompatibilityOverride(
    [
      "POST /rooms operationId changed (createRoom → createRoomV2)",
      'POST /rooms response "201" schema (application/json) property "name" was removed',
    ],
    "origin/development",
    { justification, migrationPlan },
  );
  assert.match(output, /intentional breaking change override was supplied/);
  assert.match(output, /Changed contracts:/);
  assert.match(output, /operationId changed/);
  assert.match(output, /property "name" was removed/);
  assert.match(output, /Review evidence:/);
  assert.match(
    output,
    /Justification \(API_BREAKING_CHANGE_JUSTIFICATION\): The existing contract is intentionally replaced by v2\./,
  );
  assert.match(
    output,
    /Migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\): Clients switch to POST \/v2\/rooms; v1 stays available for one release\./,
  );
});

function withBreakingSpecFixture(callback) {
  const directory = mkdtempSync("/tmp/api-compatibility-test-");
  const baselineFile = join(directory, "baseline.yaml");
  const currentFile = join(directory, "current.yaml");
  writeFileSync(baselineFile, baseDocument);
  writeFileSync(
    currentFile,
    baseDocument.replace("createRoom", "createRoomV2"),
  );
  try {
    return callback({ baselineFile, currentFile });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("fails by default and only overrides when the pull request supplies a reason and a migration plan", () => {
  withBreakingSpecFixture(({ baselineFile, currentFile }) => {
    const defaultResult = runCompatibilityCheck({
      baselineFile,
      currentFile,
      pullRequestBody: "",
    });
    assert.equal(defaultResult.ok, false);
    assert.equal(defaultResult.overridden, undefined);
    assert.equal(defaultResult.justification, null);
    assert.equal(defaultResult.migrationPlan, null);
    assert.doesNotMatch(defaultResult.output, /override was rejected/);

    const reasonOnlyResult = runCompatibilityCheck({
      baselineFile,
      currentFile,
      pullRequestBody: `API_BREAKING_CHANGE_JUSTIFICATION: ${justification}`,
    });
    assert.equal(reasonOnlyResult.ok, false);
    assert.equal(reasonOnlyResult.overridden, undefined);
    assert.equal(reasonOnlyResult.justification, justification);
    assert.equal(reasonOnlyResult.migrationPlan, null);
    assert.match(
      reasonOnlyResult.output,
      /override was rejected because it omits the migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\)/,
    );

    const planOnlyResult = runCompatibilityCheck({
      baselineFile,
      currentFile,
      pullRequestBody: `API_BREAKING_CHANGE_MIGRATION_PLAN: ${migrationPlan}`,
    });
    assert.equal(planOnlyResult.ok, false);
    assert.match(
      planOnlyResult.output,
      /override was rejected because it omits the justification \(API_BREAKING_CHANGE_JUSTIFICATION\)/,
    );

    const overrideResult = runCompatibilityCheck({
      baselineFile,
      currentFile,
      pullRequestBody: [
        "## Summary",
        `API_BREAKING_CHANGE_JUSTIFICATION: ${justification}`,
        `API_BREAKING_CHANGE_MIGRATION_PLAN: ${migrationPlan}`,
      ].join("\n"),
    });
    assert.equal(overrideResult.ok, true);
    assert.equal(overrideResult.overridden, true);
    assert.equal(overrideResult.justification, justification);
    assert.equal(overrideResult.migrationPlan, migrationPlan);
    assert.match(overrideResult.output, /POST \/rooms operationId changed/);
    assert.match(overrideResult.output, /Justification .*replaced by v2\./);
    assert.match(
      overrideResult.output,
      /Migration plan .*Clients switch to POST \/v2\/rooms/,
    );

    const explicitOptionsResult = runCompatibilityCheck({
      baselineFile,
      currentFile,
      pullRequestBody: "",
      breakingChangeJustification: justification,
      breakingChangeMigrationPlan: migrationPlan,
    });
    assert.equal(explicitOptionsResult.ok, true);
    assert.equal(explicitOptionsResult.overridden, true);
  });
});

test("the command line exits non-zero for an override that omits the migration plan", () => {
  withBreakingSpecFixture(({ baselineFile, currentFile }) => {
    const run = (args, env = {}) =>
      spawnSync(
        process.execPath,
        [
          scriptPath,
          "--baseline-file",
          baselineFile,
          "--current-file",
          currentFile,
          ...args,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            API_BREAKING_CHANGE_PR_BODY: "",
            API_BREAKING_CHANGE_JUSTIFICATION: "",
            API_BREAKING_CHANGE_MIGRATION_PLAN: "",
            ...env,
          },
        },
      );

    const reasonOnly = run(["--breaking-change-justification", justification]);
    assert.equal(reasonOnly.status, 1, reasonOnly.stderr);
    assert.match(
      reasonOnly.stdout,
      /override was rejected because it omits the migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\)/,
    );

    const emptyPlan = run([
      "--breaking-change-justification",
      justification,
      "--breaking-change-migration-plan",
      "   ",
    ]);
    assert.equal(emptyPlan.status, 1);
    assert.match(
      emptyPlan.stderr,
      /--breaking-change-migration-plan requires a non-empty migration plan/,
    );

    const pullRequestOverride = run([], {
      API_BREAKING_CHANGE_PR_BODY: `API_BREAKING_CHANGE_JUSTIFICATION: ${justification}\r\nAPI_BREAKING_CHANGE_MIGRATION_PLAN: ${migrationPlan}\r\n`,
    });
    assert.equal(pullRequestOverride.status, 0, pullRequestOverride.stderr);
    assert.match(
      pullRequestOverride.stdout,
      /Justification \(API_BREAKING_CHANGE_JUSTIFICATION\): The existing contract is intentionally replaced by v2\./,
    );
    assert.match(
      pullRequestOverride.stdout,
      /Migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\): Clients switch to POST \/v2\/rooms; v1 stays available for one release\./,
    );

    const environmentOverride = run([], {
      API_BREAKING_CHANGE_JUSTIFICATION: justification,
      API_BREAKING_CHANGE_MIGRATION_PLAN: migrationPlan,
    });
    assert.equal(environmentOverride.status, 0, environmentOverride.stderr);
    assert.match(environmentOverride.stdout, /Review evidence:/);
  });
});
