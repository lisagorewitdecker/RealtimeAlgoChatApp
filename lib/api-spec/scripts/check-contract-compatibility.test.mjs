import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import YAML from "yaml";
import {
  extractBreakingChangeJustification,
  findBreakingChanges,
  formatCompatibilityFailure,
  formatCompatibilityOverride,
  runCompatibilityCheck,
} from "./check-contract-compatibility.mjs";

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

test("formats actionable failure output", () => {
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
  assert.match(output, /API_BREAKING_CHANGE_JUSTIFICATION/);
});

test("extracts a non-empty breaking change justification from a pull request body", () => {
  assert.equal(
    extractBreakingChangeJustification(`
## Summary
This changes the API version.

API_BREAKING_CHANGE_JUSTIFICATION: The existing contract is intentionally replaced by v2.
`),
    "The existing contract is intentionally replaced by v2.",
  );
  assert.equal(
    extractBreakingChangeJustification("API_BREAKING_CHANGE_JUSTIFICATION:   "),
    null,
  );
  assert.equal(
    extractBreakingChangeJustification("No override supplied"),
    null,
  );
});

test("formats an override with every changed contract and its justification", () => {
  const output = formatCompatibilityOverride(
    [
      "POST /rooms operationId changed (createRoom → createRoomV2)",
      'POST /rooms response "201" schema (application/json) property "name" was removed',
    ],
    "origin/development",
    "The existing contract is intentionally replaced by v2.",
  );
  assert.match(output, /intentional breaking change override was supplied/);
  assert.match(output, /Changed contracts:/);
  assert.match(output, /operationId changed/);
  assert.match(output, /property "name" was removed/);
  assert.match(
    output,
    /Justification \(API_BREAKING_CHANGE_JUSTIFICATION\): The existing contract is intentionally replaced by v2\./,
  );
});

test("fails by default and only overrides when the pull request supplies a reason", () => {
  const directory = mkdtempSync("/tmp/api-compatibility-test-");
  const baselineFile = join(directory, "baseline.yaml");
  const currentFile = join(directory, "current.yaml");
  writeFileSync(baselineFile, baseDocument);
  writeFileSync(
    currentFile,
    baseDocument.replace("createRoom", "createRoomV2"),
  );

  try {
    const defaultResult = runCompatibilityCheck({
      baselineFile,
      currentFile,
    });
    assert.equal(defaultResult.ok, false);
    assert.equal(defaultResult.overridden, undefined);

    const overrideResult = runCompatibilityCheck({
      baselineFile,
      currentFile,
      pullRequestBody:
        "API_BREAKING_CHANGE_JUSTIFICATION: The existing contract is intentionally replaced by v2.",
    });
    assert.equal(overrideResult.ok, true);
    assert.equal(overrideResult.overridden, true);
    assert.match(overrideResult.output, /POST \/rooms operationId changed/);
    assert.match(
      overrideResult.output,
      /The existing contract is intentionally replaced by v2\./,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
