import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import YAML from "yaml";
import {
  extractBreakingChangeDeclaration,
  extractBreakingChangeJustification,
  findBreakingChanges,
  formatDeclarationInstructions,
  formatCompatibilityErrorSummary,
  formatCompatibilityFailure,
  formatCompatibilityOverride,
  formatCompatibilitySummary,
  runCompatibilityCheck,
  writeStepSummary,
} from "./check-contract-compatibility.mjs";

const scriptPath = fileURLToPath(
  new URL("./check-contract-compatibility.mjs", import.meta.url),
);
const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/api-codegen.yml", import.meta.url),
);
const justification = "The existing contract is intentionally replaced by v2.";
const migrationPlan =
  "Clients switch to POST /v2/rooms; v1 stays available for one release.";

function runCli(args, { env = {}, summaryPath } = {}) {
  const childEnv = { ...process.env, ...env };
  for (const key of [
    "API_BREAKING_CHANGE_JUSTIFICATION",
    "API_BREAKING_CHANGE_MIGRATION_PLAN",
    "API_BREAKING_CHANGE_PR_BODY",
    "GITHUB_EVENT_NAME",
    "GITHUB_STEP_SUMMARY",
  ]) {
    if (!(key in env)) {
      delete childEnv[key];
    }
  }
  if (summaryPath) {
    childEnv.GITHUB_STEP_SUMMARY = summaryPath;
  }
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: childEnv,
  });
}

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
  assert.match(output, /add both declarations to the pull request description/);
  assert.match(output, /Inline example:/);
  assert.match(output, /^ {2}API_BREAKING_CHANGE_JUSTIFICATION: <.+>$/m);
  assert.match(output, /^ {2}API_BREAKING_CHANGE_MIGRATION_PLAN: <.+>$/m);
  assert.match(output, /Multi-step migration plan example:/);
  assert.match(output, /^ {4}- Release the updated client first\.$/m);
  assert.match(
    output,
    /End the block with a blank line or the next API_BREAKING_CHANGE_\* marker\./,
  );
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
  assert.match(output, /add both declarations to the pull request description/);
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

test("extracts indented and bulleted declaration blocks", () => {
  const blockJustification = [
    "The old response cannot represent the new room state.",
    "Keeping it would make clients misinterpret the result.",
  ].join("\n");
  const blockMigrationPlan = [
    "- Update the mobile client to use POST /v2/rooms.",
    "- Keep v1 available for one release.",
    "- Remove v1 after adoption is confirmed.",
  ].join("\n");
  const body = [
    "API_BREAKING_CHANGE_JUSTIFICATION:",
    "  The old response cannot represent the new room state.",
    "  Keeping it would make clients misinterpret the result.",
    "API_BREAKING_CHANGE_MIGRATION_PLAN:",
    ...blockMigrationPlan.split("\n"),
  ].join("\n");

  assert.deepEqual(extractBreakingChangeDeclaration(body), {
    justification: blockJustification,
    migrationPlan: blockMigrationPlan,
  });
});

test("supports mixed inline and block declarations with CRLF endings", () => {
  const blockMigrationPlan = [
    "- Update the mobile client.",
    "  - Ship the generated client first.",
    "- Remove v1 in the following release.",
  ].join("\n");
  const body = [
    `API_BREAKING_CHANGE_JUSTIFICATION: ${justification}`,
    "API_BREAKING_CHANGE_MIGRATION_PLAN:",
    "  - Update the mobile client.",
    "    - Ship the generated client first.",
    "  - Remove v1 in the following release.",
  ].join("\r\n");

  assert.deepEqual(extractBreakingChangeDeclaration(body), {
    justification,
    migrationPlan: blockMigrationPlan,
  });
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

test("uses a later valid declaration when an earlier copy is empty", () => {
  assert.deepEqual(
    extractBreakingChangeDeclaration(
      [
        "API_BREAKING_CHANGE_JUSTIFICATION:",
        `API_BREAKING_CHANGE_JUSTIFICATION: ${justification}`,
        "API_BREAKING_CHANGE_MIGRATION_PLAN:",
        `  ${migrationPlan}`,
      ].join("\n"),
    ),
    { justification, migrationPlan },
  );
});

test("stops declaration blocks at blank lines and unrelated unindented text", () => {
  assert.deepEqual(
    extractBreakingChangeDeclaration(
      [
        "API_BREAKING_CHANGE_JUSTIFICATION:",
        "  Required for the new room model.",
        "",
        "  This belongs to another section.",
        "API_BREAKING_CHANGE_MIGRATION_PLAN:",
        "- Update clients.",
        "This is normal pull request prose.",
      ].join("\n"),
    ),
    {
      justification: "Required for the new room model.",
      migrationPlan: "- Update clients.",
    },
  );
});

test("rejects placeholder and stock non-answer declarations", () => {
  const rejectedValues = [
    "<why the existing contract must break>",
    "Copied: <why the existing contract must break>",
    "<   >",
    "<< >>",
    "TODO",
    "TBD.",
    "n/a",
    "N A",
    "none",
    "see above",
  ];

  withBreakingSpecFixture(({ baselineFile, currentFile }) => {
    for (const value of rejectedValues) {
      const result = runCompatibilityCheck({
        baselineFile,
        currentFile,
        breakingChangeJustification: value,
        breakingChangeMigrationPlan: migrationPlan,
      });
      assert.equal(result.ok, false, `expected "${value}" to be rejected`);
      assert.match(
        result.output,
        /justification \(API_BREAKING_CHANGE_JUSTIFICATION\) is a placeholder/,
      );
    }

    const printedPlanPlaceholder = runCompatibilityCheck({
      baselineFile,
      currentFile,
      breakingChangeJustification: justification,
      breakingChangeMigrationPlan:
        "<how existing consumers move to the new contract>",
    });
    assert.equal(printedPlanPlaceholder.ok, false);
    assert.match(
      printedPlanPlaceholder.output,
      /migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\) is a placeholder/,
    );

    const bothPrintedPlaceholders = runCompatibilityCheck({
      baselineFile,
      currentFile,
      breakingChangeJustification:
        "<why the existing contract must break>",
      breakingChangeMigrationPlan:
        "<how existing consumers move to the new contract>",
    });
    assert.equal(bothPrintedPlaceholders.ok, false);
    assert.match(
      bothPrintedPlaceholders.output,
      /justification \(API_BREAKING_CHANGE_JUSTIFICATION\) is a placeholder/,
    );
    assert.match(
      bothPrintedPlaceholders.output,
      /migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\) is a placeholder/,
    );
  });
});

test("accepts substantive one-sentence declarations", () => {
  withBreakingSpecFixture(({ baselineFile, currentFile }) => {
    const result = runCompatibilityCheck({
      baselineFile,
      currentFile,
      breakingChangeJustification: justification,
      breakingChangeMigrationPlan: migrationPlan,
    });
    assert.equal(result.ok, true);
    assert.equal(result.overridden, true);
  });
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

test("formats the full multi-line migration plan in compatibility output", () => {
  const multiLineMigrationPlan = [
    "- Update the mobile client.",
    "- Keep v1 for one release.",
    "- Remove v1 afterwards.",
  ].join("\n");
  const output = formatCompatibilityOverride(
    ["POST /rooms operationId changed (createRoom → createRoomV2)"],
    "origin/development",
    { justification, migrationPlan: multiLineMigrationPlan },
  );

  assert.ok(output.includes(multiLineMigrationPlan), output);
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

test("skips compatibility enforcement on push after pull request review", () => {
  const result = runCompatibilityCheck({
    eventName: "push",
    baselineFile: "/missing/baseline.yaml",
    currentFile: "/missing/current.yaml",
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.deepEqual(result.findings, []);
  assert.match(result.output, /skipped on push events/);
  assert.match(result.output, /enforced on the pull request before merge/);

  const summary = formatCompatibilitySummary(result, "HEAD^");
  assert.match(summary, /- Status: \*\*SKIPPED\*\*/);
  assert.match(summary, /enforced on the pull request before merge/);
});

test("workflow enforces compatibility on pull requests and skips post-merge development pushes", () => {
  const workflowSource = readFileSync(workflowPath, "utf8");
  const workflow = YAML.parse(workflowSource);
  const triggers = workflow.on;

  assert.deepEqual(triggers.push.branches, ["development"]);
  assert.deepEqual(triggers.pull_request.branches, ["development"]);
  assert.deepEqual(
    triggers.pull_request.types,
    ["opened", "synchronize", "reopened", "edited"],
    "new commits, reopened pull requests, and review-evidence edits must rerun enforcement",
  );

  const compatibilityStep = workflow.jobs["check-generated"].steps.find(
    (step) => step.run === "pnpm validate:api-compatibility",
  );
  assert.ok(compatibilityStep, "expected the API compatibility workflow step");
  const normalizedCondition = compatibilityStep.if.replace(/\s+/g, " ").trim();
  assert.equal(
    normalizedCondition,
    "${{ always() && steps.checkout.outcome == 'success' && steps.setup-pnpm.outcome == 'success' && steps.setup-node.outcome == 'success' && steps.install-dependencies.outcome == 'success' }}",
    "the compatibility step must remain eligible on pull requests after setup succeeds",
  );
  assert.equal(
    compatibilityStep.env.API_BREAKING_CHANGE_PR_BODY,
    "${{ github.event.pull_request.body }}",
    "pull request enforcement must receive the review evidence from the PR body",
  );

  const guidanceMatch = workflowSource.match(
    /(?<guidance>      # For an intentional versioned break,[\s\S]*?      #   \(End the block with a blank line or the next API_BREAKING_CHANGE_\* marker\.\))/,
  );
  assert.ok(
    guidanceMatch?.groups?.guidance,
    "expected reviewer-facing compatibility override guidance in the workflow",
  );
  const workflowGuidance = guidanceMatch.groups.guidance
    .split("\n")
    .map((line) => line.replace(/^      # ?/, ""));
  assert.deepEqual(
    workflowGuidance,
    formatDeclarationInstructions(),
    "workflow guidance and blocked compatibility output must use the same examples and boundary wording",
  );
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

test("the command line rejects placeholder declarations from pull request bodies and explicit flags", () => {
  withBreakingSpecFixture(({ baselineFile, currentFile }) => {
    const directory = mkdtempSync("/tmp/api-compatibility-placeholders-");
    const fileArgs = [
      "--baseline-file",
      baselineFile,
      "--current-file",
      currentFile,
    ];

    try {
      const pullRequestSummary = join(directory, "pull-request.md");
      const pullRequestPlaceholder = runCli(fileArgs, {
        summaryPath: pullRequestSummary,
        env: {
          API_BREAKING_CHANGE_PR_BODY: [
            "## API review",
            "API_BREAKING_CHANGE_JUSTIFICATION: TODO",
            `API_BREAKING_CHANGE_MIGRATION_PLAN: ${migrationPlan}`,
          ].join("\n"),
        },
      });
      assert.equal(pullRequestPlaceholder.status, 1);
      assert.match(
        pullRequestPlaceholder.stdout,
        /justification \(API_BREAKING_CHANGE_JUSTIFICATION\) is a placeholder/,
      );
      assert.match(
        readFileSync(pullRequestSummary, "utf8"),
        /justification \(API_BREAKING_CHANGE_JUSTIFICATION\) is a placeholder/,
      );

      const environmentSummary = join(directory, "environment.md");
      const environmentPlaceholder = runCli(fileArgs, {
        summaryPath: environmentSummary,
        env: {
          API_BREAKING_CHANGE_JUSTIFICATION: justification,
          API_BREAKING_CHANGE_MIGRATION_PLAN: "none",
        },
      });
      assert.equal(environmentPlaceholder.status, 1);
      assert.match(
        environmentPlaceholder.stdout,
        /migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\) is a placeholder/,
      );
      assert.match(
        readFileSync(environmentSummary, "utf8"),
        /migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\) is a placeholder/,
      );

      const flagSummary = join(directory, "flags.md");
      const flagPlaceholder = runCli(
        [
          ...fileArgs,
          "--breaking-change-justification",
          justification,
          "--breaking-change-migration-plan",
          "TBD",
        ],
        { summaryPath: flagSummary },
      );
      assert.equal(flagPlaceholder.status, 1);
      assert.match(
        flagPlaceholder.stdout,
        /migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\) is a placeholder/,
      );
      assert.match(
        readFileSync(flagSummary, "utf8"),
        /migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\) is a placeholder/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("the command line rejects a placeholder from the winning declaration source", () => {
  withBreakingSpecFixture(({ baselineFile, currentFile }) => {
    const directory = mkdtempSync("/tmp/api-compatibility-precedence-");
    const fileArgs = [
      "--baseline-file",
      baselineFile,
      "--current-file",
      currentFile,
    ];
    const substantivePullRequestBody = [
      `API_BREAKING_CHANGE_JUSTIFICATION: ${justification}`,
      `API_BREAKING_CHANGE_MIGRATION_PLAN: ${migrationPlan}`,
    ].join("\n");

    try {
      const environmentSummary = join(directory, "environment-wins.md");
      const environmentWins = runCli(fileArgs, {
        summaryPath: environmentSummary,
        env: {
          API_BREAKING_CHANGE_PR_BODY: substantivePullRequestBody,
          API_BREAKING_CHANGE_JUSTIFICATION: "TODO",
          API_BREAKING_CHANGE_MIGRATION_PLAN: migrationPlan,
        },
      });
      assert.equal(environmentWins.status, 1, environmentWins.stderr);
      assert.match(
        environmentWins.stdout,
        /justification \(API_BREAKING_CHANGE_JUSTIFICATION\) is a placeholder/,
      );
      assert.match(
        environmentWins.stdout,
        /Justification \(API_BREAKING_CHANGE_JUSTIFICATION\): TODO/,
      );
      const environmentSummaryText = readFileSync(environmentSummary, "utf8");
      assert.match(
        environmentSummaryText,
        /justification \(API_BREAKING_CHANGE_JUSTIFICATION\) is a placeholder/,
      );
      assert.match(
        environmentSummaryText,
        /Justification \(`API_BREAKING_CHANGE_JUSTIFICATION`\): `TODO`/,
      );

      const flagSummary = join(directory, "flag-wins.md");
      const flagWins = runCli(
        [
          ...fileArgs,
          "--breaking-change-justification",
          justification,
          "--breaking-change-migration-plan",
          "TBD",
        ],
        {
          summaryPath: flagSummary,
          env: {
            API_BREAKING_CHANGE_PR_BODY: substantivePullRequestBody,
            API_BREAKING_CHANGE_JUSTIFICATION: justification,
            API_BREAKING_CHANGE_MIGRATION_PLAN: migrationPlan,
          },
        },
      );
      assert.equal(flagWins.status, 1, flagWins.stderr);
      assert.match(
        flagWins.stdout,
        /migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\) is a placeholder/,
      );
      assert.match(
        flagWins.stdout,
        /Migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\): TBD/,
      );
      const flagSummaryText = readFileSync(flagSummary, "utf8");
      assert.match(
        flagSummaryText,
        /migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\) is a placeholder/,
      );
      assert.match(
        flagSummaryText,
        /Migration plan \(`API_BREAKING_CHANGE_MIGRATION_PLAN`\): `TBD`/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("summarizes a compatible contract without a changed-contracts section", () => {
  const summary = formatCompatibilitySummary(
    { ok: true, findings: [] },
    "origin/development",
  );
  assert.match(summary, /^## API contract compatibility\n/);
  assert.match(summary, /- Status: \*\*COMPATIBLE\*\*/);
  assert.match(summary, /- Baseline: `origin\/development`/);
  assert.match(summary, /No breaking API contract changes were detected\./);
  assert.doesNotMatch(summary, /Changed contracts/);
});

test("summarizes blocked breaks with every changed contract and the override instructions", () => {
  const findings = [
    "GET /rooms endpoint was removed (operationId: listRooms)",
    'POST /rooms response "201" schema (application/json) property "name" was removed',
  ];
  const summary = formatCompatibilitySummary(
    { ok: false, findings },
    "origin/development",
  );
  assert.match(summary, /- Status: \*\*BLOCKED\*\*/);
  assert.match(summary, /### Changed contracts/);
  for (const finding of findings) {
    assert.ok(
      summary.includes(`- \`${finding}\``),
      `expected the summary to list ${finding}`,
    );
  }
  assert.match(summary, /block the merge/);
  assert.match(summary, /add both declarations to the pull request description/);
  assert.match(summary, /\*\*Inline example\*\*/);
  assert.match(
    summary,
    /^API_BREAKING_CHANGE_JUSTIFICATION: <why the existing contract must break>$/m,
  );
  assert.match(
    summary,
    /^API_BREAKING_CHANGE_MIGRATION_PLAN: <how existing consumers move to the new contract>$/m,
  );
  assert.match(summary, /\*\*Multi-step migration plan example\*\*/);
  assert.match(summary, /^  - Release the updated client first\.$/m);
  assert.match(
    summary,
    /End the block with a blank line or the next `API_BREAKING_CHANGE_\*` marker\./,
  );
  assert.doesNotMatch(summary, /Review evidence|override was rejected/);
});

test("summarizes an incomplete override as blocked with the missing evidence called out", () => {
  const summary = formatCompatibilitySummary(
    {
      ok: false,
      findings: ["GET /rooms endpoint was removed (operationId: listRooms)"],
      justification,
      migrationPlan: null,
    },
    "origin/development",
  );
  assert.match(summary, /- Status: \*\*BLOCKED\*\*/);
  assert.match(summary, /### Review evidence/);
  assert.ok(
    summary.includes(
      `- Justification (\`API_BREAKING_CHANGE_JUSTIFICATION\`): \`${justification}\``,
    ),
    "expected the supplied justification in the summary",
  );
  assert.match(
    summary,
    /^- Migration plan \(`API_BREAKING_CHANGE_MIGRATION_PLAN`\): \*\*missing\*\*$/m,
  );
  assert.match(
    summary,
    /override was rejected because it omits the migration plan \(API_BREAKING_CHANGE_MIGRATION_PLAN\)\./,
  );
  assert.match(summary, /add both declarations to the pull request description/);
});

test("summarizes approved overrides with the changed contracts and the exact review evidence", () => {
  const exactJustification =
    "The existing contract is intentionally replaced by v2 (tracked in ROOMS-42).";
  const findings = [
    "POST /rooms operationId changed (createRoom → createRoomV2)",
  ];
  const summary = formatCompatibilitySummary(
    {
      ok: true,
      overridden: true,
      findings,
      justification: exactJustification,
      migrationPlan,
    },
    "origin/development",
  );
  assert.match(summary, /- Status: \*\*APPROVED OVERRIDE\*\*/);
  assert.match(summary, /- Baseline: `origin\/development`/);
  assert.match(summary, /### Changed contracts/);
  assert.ok(summary.includes(`- \`${findings[0]}\``));
  assert.match(summary, /### Review evidence/);
  assert.ok(
    summary.includes(
      `- Justification (\`API_BREAKING_CHANGE_JUSTIFICATION\`): \`${exactJustification}\``,
    ),
    "expected the exact justification in the summary",
  );
  assert.ok(
    summary.includes(
      `- Migration plan (\`API_BREAKING_CHANGE_MIGRATION_PLAN\`): \`${migrationPlan}\``,
    ),
    "expected the exact migration plan in the summary",
  );
  assert.doesNotMatch(summary, /BLOCKED|block the merge|\*\*missing\*\*/);
});

test("renders multi-line review evidence as distinct code lines under each declaration", () => {
  const multiLineJustification = [
    "The `v1` response cannot represent the replacement.",
    "- Existing clients already ignore the retired field.",
  ].join("\n");
  const multiLineMigrationPlan = [
    "1. Update the mobile client to call `createRoomV2`.",
    "2. Keep `v1` for one release.",
    "- Remove `v1` after adoption is confirmed.",
  ].join("\n");
  const summary = formatCompatibilitySummary(
    {
      ok: true,
      overridden: true,
      findings: ["POST /rooms operationId changed (createRoom → createRoomV2)"],
      justification: multiLineJustification,
      migrationPlan: multiLineMigrationPlan,
    },
    "origin/development",
  );
  const rendered = new MarkdownIt().render(summary);

  assert.match(
    rendered,
    /<li>\s*<p>Justification \(<code>API_BREAKING_CHANGE_JUSTIFICATION<\/code>\):<\/p>\s*<pre><code>The `v1` response cannot represent the replacement\.\n- Existing clients already ignore the retired field\.\n<\/code><\/pre>\s*<\/li>/,
  );
  assert.match(
    rendered,
    /<li>\s*<p>Migration plan \(<code>API_BREAKING_CHANGE_MIGRATION_PLAN<\/code>\):<\/p>\s*<pre><code>1\. Update the mobile client to call `createRoomV2`\.\n2\. Keep `v1` for one release\.\n- Remove `v1` after adoption is confirmed\.\n<\/code><\/pre>\s*<\/li>/,
  );
  assert.equal(
    (rendered.match(/<li>/g) ?? []).length,
    5,
    "reviewer-authored bullets must remain literal code instead of nested lists",
  );
});

test("keeps review evidence containing backticks intact in the summary", () => {
  const summary = formatCompatibilitySummary(
    {
      ok: true,
      overridden: true,
      findings: ["GET /rooms endpoint was removed (operationId: listRooms)"],
      justification: "Clients on `v1` are gone; `listRooms` moved to v2.",
      migrationPlan: "Call ``listRoomsV2`` instead.",
    },
    "origin/development",
  );
  assert.ok(
    summary.includes("``Clients on `v1` are gone; `listRooms` moved to v2.``"),
    "expected a longer code fence around a justification with backticks",
  );
  assert.ok(
    summary.includes("```Call ``listRoomsV2`` instead.```"),
    "expected the fence to outgrow the longest backtick run in the plan",
  );
});

test("summarizes a check that could not run", () => {
  const summary = formatCompatibilityErrorSummary(
    "Unable to read the OpenAPI baseline at origin/development:lib/api-spec/openapi.yaml.",
  );
  assert.match(summary, /^## API contract compatibility\n/);
  assert.match(summary, /- Status: \*\*NOT CHECKED\*\*/);
  assert.match(
    summary,
    /- Error: `Unable to read the OpenAPI baseline at origin\/development:lib\/api-spec\/openapi\.yaml\.`/,
  );
});

test("appends the summary only when a step summary file is configured", () => {
  const directory = mkdtempSync("/tmp/api-compatibility-summary-");
  const summaryPath = join(directory, "summary.md");
  try {
    assert.equal(writeStepSummary("## first", ""), false);
    assert.equal(writeStepSummary("## first", undefined), false);
    assert.equal(existsSync(summaryPath), false);

    assert.equal(writeStepSummary("## first", summaryPath), true);
    assert.equal(writeStepSummary("## second", summaryPath), true);
    assert.equal(readFileSync(summaryPath, "utf8"), "## first\n## second\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("publishes the decision to the job summary while preserving exit codes", () => {
  const directory = mkdtempSync("/tmp/api-compatibility-cli-");
  const baselineFile = join(directory, "baseline.yaml");
  const currentFile = join(directory, "current.yaml");
  writeFileSync(baselineFile, baseDocument);
  writeFileSync(
    currentFile,
    baseDocument.replace("createRoom", "createRoomV2"),
  );
  const fileArgs = [
    "--baseline-file",
    baselineFile,
    "--current-file",
    currentFile,
  ];

  try {
    const compatibleSummary = join(directory, "compatible.md");
    const compatible = runCli(
      ["--baseline-file", baselineFile, "--current-file", baselineFile],
      { summaryPath: compatibleSummary },
    );
    assert.equal(compatible.status, 0, compatible.stderr);
    assert.match(compatible.stdout, /backward compatible/);
    assert.match(
      readFileSync(compatibleSummary, "utf8"),
      /- Status: \*\*COMPATIBLE\*\*/,
    );

    const pushSummary = join(directory, "push.md");
    const push = runCli(fileArgs, {
      summaryPath: pushSummary,
      env: { GITHUB_EVENT_NAME: "push" },
    });
    assert.equal(push.status, 0, push.stderr);
    assert.match(push.stdout, /skipped on push events/);
    assert.match(
      readFileSync(pushSummary, "utf8"),
      /- Status: \*\*SKIPPED\*\*/,
    );

    const blockedSummary = join(directory, "blocked.md");
    const blocked = runCli(fileArgs, { summaryPath: blockedSummary });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /Breaking API contract changes detected/);
    const blockedMarkdown = readFileSync(blockedSummary, "utf8");
    assert.match(blockedMarkdown, /- Status: \*\*BLOCKED\*\*/);
    assert.match(
      blockedMarkdown,
      /- `POST \/rooms operationId changed \(createRoom → createRoomV2\)`/,
    );
    assert.doesNotMatch(blockedMarkdown, /Review evidence/);

    const incompleteSummary = join(directory, "incomplete.md");
    const incomplete = runCli(fileArgs, {
      summaryPath: incompleteSummary,
      env: {
        API_BREAKING_CHANGE_PR_BODY: `## Summary\n\nAPI_BREAKING_CHANGE_JUSTIFICATION: ${justification}\n`,
      },
    });
    assert.equal(incomplete.status, 1);
    const incompleteMarkdown = readFileSync(incompleteSummary, "utf8");
    assert.match(incompleteMarkdown, /- Status: \*\*BLOCKED\*\*/);
    assert.match(
      incompleteMarkdown,
      /- Migration plan \(`API_BREAKING_CHANGE_MIGRATION_PLAN`\): \*\*missing\*\*/,
    );

    const approvedSummary = join(directory, "approved.md");
    const approved = runCli(fileArgs, {
      summaryPath: approvedSummary,
      env: {
        API_BREAKING_CHANGE_PR_BODY: `## Summary\n\nAPI_BREAKING_CHANGE_JUSTIFICATION: ${justification}\r\nAPI_BREAKING_CHANGE_MIGRATION_PLAN: ${migrationPlan}\r\n`,
      },
    });
    assert.equal(approved.status, 0, approved.stderr);
    const approvedMarkdown = readFileSync(approvedSummary, "utf8");
    assert.match(approvedMarkdown, /- Status: \*\*APPROVED OVERRIDE\*\*/);
    assert.ok(
      approvedMarkdown.includes(
        `- Justification (\`API_BREAKING_CHANGE_JUSTIFICATION\`): \`${justification}\``,
      ),
      approvedMarkdown,
    );
    assert.ok(
      approvedMarkdown.includes(
        `- Migration plan (\`API_BREAKING_CHANGE_MIGRATION_PLAN\`): \`${migrationPlan}\``,
      ),
      approvedMarkdown,
    );
    assert.match(
      approvedMarkdown,
      /- `POST \/rooms operationId changed \(createRoom → createRoomV2\)`/,
    );

    const errorSummary = join(directory, "error.md");
    const errored = runCli(
      [
        "--baseline-file",
        join(directory, "missing.yaml"),
        "--current-file",
        currentFile,
      ],
      { summaryPath: errorSummary },
    );
    assert.equal(errored.status, 1);
    assert.match(errored.stderr, /API contract compatibility check failed/);
    assert.match(
      readFileSync(errorSummary, "utf8"),
      /- Status: \*\*NOT CHECKED\*\*/,
    );

    const entriesBefore = readdirSync(directory).sort();
    const silent = runCli(fileArgs);
    assert.equal(silent.status, 1);
    assert.match(silent.stdout, /Breaking API contract changes detected/);
    assert.deepEqual(readdirSync(directory).sort(), entriesBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
