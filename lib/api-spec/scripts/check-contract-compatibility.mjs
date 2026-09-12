import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const workspaceRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const defaultSpecPath = "lib/api-spec/openapi.yaml";
// An intentional contract break is only accepted when the pull request declares
// every piece of review evidence below. Each marker is also honored as an
// environment variable or command-line flag for local runs.
const breakingChangeDeclarations = [
  {
    key: "justification",
    option: "breakingChangeJustification",
    flag: "--breaking-change-justification",
    marker: "API_BREAKING_CHANGE_JUSTIFICATION",
    label: "Justification",
    placeholder: "<why the existing contract must break>",
  },
  {
    key: "migrationPlan",
    option: "breakingChangeMigrationPlan",
    flag: "--breaking-change-migration-plan",
    marker: "API_BREAKING_CHANGE_MIGRATION_PLAN",
    label: "Migration plan",
    placeholder: "<how existing consumers move to the new contract>",
  },
];
const stockDeclarationNonAnswers =
  /^(?:todo|tbd|n\s*\/?\s*a|none|see\s+above)[.!?]*$/i;
const stepSummaryHeading = "## API contract compatibility";
const httpMethods = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getByJsonPointer(document, pointer) {
  return pointer
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((value, part) => value?.[part], document);
}

function resolveReference(value, document, seen = new Set()) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveReference(item, document, seen));
  }
  if (!isRecord(value)) {
    return value;
  }
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
    if (seen.has(value.$ref)) {
      return {};
    }
    return resolveReference(
      getByJsonPointer(document, value.$ref),
      document,
      new Set([...seen, value.$ref]),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      resolveReference(nestedValue, document, seen),
    ]),
  );
}

function schemaTypes(schema) {
  if (Array.isArray(schema.type)) {
    return new Set(schema.type);
  }
  return schema.type ? new Set([schema.type]) : null;
}

function setIncludesAll(container, values) {
  return values ? [...values].every((value) => container?.has(value)) : true;
}

function compareEnum(oldSchema, newSchema, direction, label, findings) {
  const oldEnum = Array.isArray(oldSchema.enum)
    ? new Set(oldSchema.enum)
    : null;
  const newEnum = Array.isArray(newSchema.enum)
    ? new Set(newSchema.enum)
    : null;
  if (!oldEnum && !newEnum) {
    return;
  }

  const isCompatible =
    direction === "request"
      ? oldEnum && newEnum
        ? setIncludesAll(newEnum, oldEnum)
        : !newEnum
          ? true
          : false
      : oldEnum && newEnum
        ? setIncludesAll(oldEnum, newEnum)
        : !oldEnum
          ? true
          : false;
  if (!isCompatible) {
    findings.push(
      `${label} enum values changed incompatibly (${direction} contract)`,
    );
  }
}

function compareBound(
  oldSchema,
  newSchema,
  property,
  direction,
  label,
  findings,
) {
  const oldValue = oldSchema[property];
  const newValue = newSchema[property];
  if (oldValue === newValue) {
    return;
  }
  if (oldValue === undefined) {
    if (direction === "request") {
      findings.push(
        `${label} changed incompatibly: ${property} unrestricted → ${newValue}`,
      );
    }
    return;
  }
  if (newValue === undefined) {
    if (direction === "response") {
      findings.push(
        `${label} constraint was removed: ${property} ${oldValue} → unrestricted`,
      );
    }
    return;
  }

  const inputCompatible = property.startsWith("min")
    ? newValue <= oldValue
    : newValue >= oldValue;
  const outputCompatible = property.startsWith("min")
    ? newValue >= oldValue
    : newValue <= oldValue;
  if (
    (direction === "request" && !inputCompatible) ||
    (direction === "response" && !outputCompatible)
  ) {
    findings.push(
      `${label} changed incompatibly: ${property} ${oldValue} → ${newValue}`,
    );
  }
}

function compareSchema(oldValue, newValue, options, findings) {
  const { oldDocument, newDocument, direction, label } = options;
  if (oldValue === undefined || oldValue === true) {
    if (newValue === false) {
      findings.push(`${label} now rejects every value`);
    }
    return;
  }
  if (newValue === undefined || newValue === true) {
    if (
      newValue === undefined &&
      oldValue !== false &&
      direction === "response"
    ) {
      findings.push(`${label} schema was removed`);
    }
    return;
  }
  if (oldValue === false) {
    return;
  }
  if (newValue === false) {
    findings.push(`${label} now rejects every value`);
    return;
  }

  const oldSchema = resolveReference(oldValue, oldDocument);
  const newSchema = resolveReference(newValue, newDocument);
  const oldTypes = schemaTypes(oldSchema);
  const newTypes = schemaTypes(newSchema);
  if (oldTypes && newTypes) {
    const typesCompatible =
      direction === "request"
        ? setIncludesAll(newTypes, oldTypes)
        : setIncludesAll(oldTypes, newTypes);
    if (!typesCompatible) {
      findings.push(
        `${label} type changed incompatibly (${[...oldTypes].join("|")} → ${[...newTypes].join("|")})`,
      );
    }
  } else if (!oldTypes && newTypes) {
    findings.push(
      `${label} gained a restrictive type (${[...newTypes].join("|")})`,
    );
  } else if (oldTypes && !newTypes && direction === "response") {
    findings.push(
      `${label} lost its restrictive type (${[...oldTypes].join("|")} → unconstrained)`,
    );
  }

  compareEnum(oldSchema, newSchema, direction, label, findings);
  for (const property of [
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
  ]) {
    compareBound(oldSchema, newSchema, property, direction, label, findings);
  }

  if (
    oldSchema.format !== newSchema.format &&
    oldSchema.format &&
    newSchema.format
  ) {
    findings.push(
      `${label} format changed incompatibly (${oldSchema.format} → ${newSchema.format})`,
    );
  }
  if (
    oldSchema.pattern !== newSchema.pattern &&
    oldSchema.pattern &&
    newSchema.pattern
  ) {
    findings.push(`${label} pattern changed incompatibly`);
  }

  const oldProperties = isRecord(oldSchema.properties)
    ? oldSchema.properties
    : {};
  const newProperties = isRecord(newSchema.properties)
    ? newSchema.properties
    : {};
  const oldRequired = new Set(
    Array.isArray(oldSchema.required) ? oldSchema.required : [],
  );
  const newRequired = new Set(
    Array.isArray(newSchema.required) ? newSchema.required : [],
  );

  if (direction === "request") {
    for (const property of newRequired) {
      if (!oldRequired.has(property)) {
        findings.push(`${label} property "${property}" is now required`);
      }
    }
    if (newSchema.additionalProperties === false) {
      if (oldSchema.additionalProperties !== false) {
        findings.push(`${label} no longer accepts additional properties`);
      }
      for (const property of Object.keys(oldProperties)) {
        if (!(property in newProperties)) {
          findings.push(`${label} property "${property}" was removed`);
        }
      }
    }
  } else {
    for (const property of oldRequired) {
      if (!newRequired.has(property)) {
        findings.push(
          `${label} property "${property}" is no longer guaranteed`,
        );
      }
    }
    for (const property of Object.keys(oldProperties)) {
      if (!(property in newProperties)) {
        findings.push(`${label} property "${property}" was removed`);
      }
    }
  }

  for (const property of Object.keys(oldProperties)) {
    if (property in newProperties) {
      compareSchema(
        oldProperties[property],
        newProperties[property],
        {
          ...options,
          label: `${label}.${property}`,
        },
        findings,
      );
    }
  }

  if (oldSchema.items || newSchema.items) {
    if (!newSchema.items && oldSchema.items) {
      findings.push(`${label} array item schema was removed`);
    } else if (oldSchema.items && newSchema.items) {
      compareSchema(
        oldSchema.items,
        newSchema.items,
        {
          ...options,
          label: `${label} items`,
        },
        findings,
      );
    }
  }
}

function operationEntries(document) {
  const paths = isRecord(document.paths) ? document.paths : {};
  return Object.entries(paths).flatMap(([path, pathItem]) => {
    if (!isRecord(pathItem)) {
      return [];
    }
    return Object.entries(pathItem)
      .filter(([method]) => httpMethods.has(method))
      .map(([method, operation]) => ({
        key: `${method.toUpperCase()} ${path}`,
        path,
        method,
        operation,
        pathItem,
      }));
  });
}

function parameterEntries(operationEntry, document) {
  const parameters = [
    ...(Array.isArray(operationEntry.pathItem.parameters)
      ? operationEntry.pathItem.parameters
      : []),
    ...(Array.isArray(operationEntry.operation?.parameters)
      ? operationEntry.operation.parameters
      : []),
  ];
  const entries = new Map();
  for (const rawParameter of parameters) {
    const parameter = resolveReference(rawParameter, document);
    if (parameter.name && parameter.in) {
      entries.set(`${parameter.in}:${parameter.name}`, parameter);
    }
  }
  return entries;
}

function responseContent(response, document) {
  const resolved = resolveReference(response, document);
  return isRecord(resolved?.content) ? resolved.content : {};
}

function requestBody(operation, document) {
  return resolveReference(operation?.requestBody, document);
}

function compareRequest(
  oldEntry,
  newEntry,
  oldDocument,
  newDocument,
  findings,
) {
  const oldParameters = parameterEntries(oldEntry, oldDocument);
  const newParameters = parameterEntries(newEntry, newDocument);
  for (const [key, oldParameter] of oldParameters) {
    const newParameter = newParameters.get(key);
    if (!newParameter) {
      continue;
    }
    if (!oldParameter.required && newParameter.required) {
      findings.push(
        `${newEntry.key} request parameter "${key}" is now required`,
      );
    }
    compareSchema(
      oldParameter.schema,
      newParameter.schema,
      {
        oldDocument,
        newDocument,
        direction: "request",
        label: `${newEntry.key} request parameter "${key}"`,
      },
      findings,
    );
  }
  for (const [key, newParameter] of newParameters) {
    if (!oldParameters.has(key) && newParameter.required) {
      findings.push(
        `${newEntry.key} request parameter "${key}" was added as required`,
      );
    }
  }

  const oldBody = requestBody(oldEntry.operation, oldDocument);
  const newBody = requestBody(newEntry.operation, newDocument);
  if (!oldBody) {
    return;
  }
  if (!newBody) {
    findings.push(`${newEntry.key} request body was removed`);
    return;
  }
  if (!oldBody.required && newBody.required) {
    findings.push(`${newEntry.key} request body is now required`);
  }
  const oldContent = isRecord(oldBody.content) ? oldBody.content : {};
  const newContent = isRecord(newBody.content) ? newBody.content : {};
  for (const mediaType of Object.keys(oldContent)) {
    if (!(mediaType in newContent)) {
      findings.push(
        `${newEntry.key} request content type "${mediaType}" was removed`,
      );
      continue;
    }
    compareSchema(
      oldContent[mediaType]?.schema,
      newContent[mediaType]?.schema,
      {
        oldDocument,
        newDocument,
        direction: "request",
        label: `${newEntry.key} request schema (${mediaType})`,
      },
      findings,
    );
  }
}

function compareResponses(
  oldEntry,
  newEntry,
  oldDocument,
  newDocument,
  findings,
) {
  const oldResponses =
    resolveReference(oldEntry.operation.responses, oldDocument) ?? {};
  const newResponses =
    resolveReference(newEntry.operation.responses, newDocument) ?? {};
  for (const status of Object.keys(oldResponses)) {
    if (!(status in newResponses)) {
      findings.push(`${newEntry.key} response "${status}" was removed`);
      continue;
    }
    const oldContent = responseContent(oldResponses[status], oldDocument);
    const newContent = responseContent(newResponses[status], newDocument);
    for (const mediaType of Object.keys(oldContent)) {
      if (!(mediaType in newContent)) {
        findings.push(
          `${newEntry.key} response "${status}" content type "${mediaType}" was removed`,
        );
        continue;
      }
      compareSchema(
        oldContent[mediaType]?.schema,
        newContent[mediaType]?.schema,
        {
          oldDocument,
          newDocument,
          direction: "response",
          label: `${newEntry.key} response "${status}" schema (${mediaType})`,
        },
        findings,
      );
    }
  }
}

export function findBreakingChanges(oldDocument, newDocument) {
  const oldOperations = new Map(
    operationEntries(oldDocument).map((entry) => [entry.key, entry]),
  );
  const newOperations = new Map(
    operationEntries(newDocument).map((entry) => [entry.key, entry]),
  );
  const findings = [];

  for (const [key, oldEntry] of oldOperations) {
    const newEntry = newOperations.get(key);
    if (!newEntry) {
      findings.push(
        `${key} endpoint was removed (operationId: ${oldEntry.operation?.operationId ?? "missing"})`,
      );
      continue;
    }
    const oldOperationId = oldEntry.operation?.operationId;
    const newOperationId = newEntry.operation?.operationId;
    if (oldOperationId !== newOperationId) {
      findings.push(
        `${key} operationId changed (${oldOperationId ?? "missing"} → ${newOperationId ?? "missing"})`,
      );
    }
    compareRequest(oldEntry, newEntry, oldDocument, newDocument, findings);
    compareResponses(oldEntry, newEntry, oldDocument, newDocument, findings);
  }

  return findings;
}

function declarationIssue(entry, value) {
  if (typeof value !== "string" || !value.trim()) {
    return "missing";
  }

  const normalized = value.trim();
  if (
    normalized.toLowerCase().includes(entry.placeholder.toLowerCase()) ||
    /^[<>\s]+$/.test(normalized) ||
    stockDeclarationNonAnswers.test(normalized)
  ) {
    return "placeholder";
  }
  return null;
}

function missingDeclarations(declaration) {
  return breakingChangeDeclarations
    .map((entry) => ({
      ...entry,
      issue: declarationIssue(entry, declaration?.[entry.key]),
    }))
    .filter((entry) => entry.issue);
}

function formatDeclarationEvidence(declaration) {
  return breakingChangeDeclarations.map(
    (entry) =>
      `- ${entry.label} (${entry.marker}): ${declaration?.[entry.key] ?? "missing"}`,
  );
}

function formatDeclarationInstructions() {
  return [
    "For an intentional versioned break, add both lines to the pull request description:",
    ...breakingChangeDeclarations.map(
      (entry) => `  ${entry.marker}: ${entry.placeholder}`,
    ),
  ];
}

function isIncompleteOverride(missing) {
  return (
    missing.length > 0 &&
    (missing.length < breakingChangeDeclarations.length ||
      missing.some((entry) => entry.issue === "placeholder"))
  );
}

function describeMissingDeclarations(missing) {
  if (missing.every((entry) => entry.issue === "missing")) {
    return missing
      .map((entry) => `${entry.label.toLowerCase()} (${entry.marker})`)
      .join(" and the ");
  }
  return missing
    .map(
      (entry) =>
        `${entry.label.toLowerCase()} (${entry.marker}) ${
          entry.issue === "placeholder" ? "is a placeholder" : "is missing"
        }`,
    )
    .join(" and ");
}

export function formatCompatibilityFailure(
  findings,
  baselineRef,
  declaration = {},
) {
  const missing = missingDeclarations(declaration);
  return [
    `Breaking API contract changes detected against ${baselineRef}:`,
    ...findings.map((finding) => `- ${finding}`),
    "",
    "Additive endpoints and optional fields are allowed. Update the existing client contract or coordinate a versioned API change before merging.",
    ...(isIncompleteOverride(missing)
      ? [
          "",
          `The intentional breaking change override was rejected because ${
            missing.every((entry) => entry.issue === "missing")
              ? `it omits the ${describeMissingDeclarations(missing)}`
              : describeMissingDeclarations(missing)
          }:`,
          ...formatDeclarationEvidence(declaration),
          "",
        ]
      : []),
    ...formatDeclarationInstructions(),
  ].join("\n");
}

function extractDeclarationValue(text, marker) {
  if (typeof text !== "string") {
    return null;
  }

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const markerPattern = new RegExp(
    `^[ \\t]*${marker}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`,
    "i",
  );
  const declarationMarkerPattern =
    /^[ \t]*API_BREAKING_CHANGE_[A-Z0-9_]+[ \t]*:/i;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(markerPattern);
    if (!match) {
      continue;
    }

    const inlineValue = match[1].trim();
    if (inlineValue) {
      return inlineValue;
    }

    const blockLines = [];
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const line = lines[blockIndex];
      if (!line.trim() || declarationMarkerPattern.test(line)) {
        break;
      }
      if (!/^[ \t]+/.test(line) && !/^[ \t]*[-*+][ \t]+/.test(line)) {
        break;
      }
      blockLines.push(line);
    }

    if (blockLines.length === 0) {
      continue;
    }
    const commonIndent = Math.min(
      ...blockLines.map((line) => line.match(/^[ \t]*/)[0].length),
    );
    return blockLines
      .map((line) => line.slice(commonIndent).trimEnd())
      .join("\n")
      .trim();
  }

  return null;
}

export function extractBreakingChangeDeclaration(text) {
  return Object.fromEntries(
    breakingChangeDeclarations.map((entry) => [
      entry.key,
      extractDeclarationValue(text, entry.marker),
    ]),
  );
}

export function extractBreakingChangeJustification(text) {
  return extractBreakingChangeDeclaration(text).justification;
}

export function formatCompatibilityOverride(
  findings,
  baselineRef,
  declaration,
) {
  return [
    `Breaking API contract changes detected against ${baselineRef}, but an intentional breaking change override was supplied.`,
    "Changed contracts:",
    ...findings.map((finding) => `- ${finding}`),
    "",
    "Review evidence:",
    ...formatDeclarationEvidence(declaration),
  ].join("\n");
}

function markdownCode(text) {
  const value = String(text);
  const longestBacktickRun = Math.max(
    0,
    ...[...value.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  const content =
    value.startsWith("`") || value.endsWith("`") ? ` ${value} ` : value;
  return `${fence}${content}${fence}`;
}

function formatChangedContractsSection(findings) {
  return [
    "",
    "### Changed contracts",
    ...findings.map((finding) => `- ${markdownCode(finding)}`),
  ];
}

function formatReviewEvidenceSection(declaration) {
  return [
    "",
    "### Review evidence",
    ...breakingChangeDeclarations.map((entry) => {
      const value = declaration?.[entry.key];
      return `- ${entry.label} (${markdownCode(entry.marker)}): ${
        value ? markdownCode(value) : "**missing**"
      }`;
    }),
  ];
}

export function formatCompatibilitySummary(result, baseline) {
  const lines = [stepSummaryHeading, ""];
  if (result.skipped) {
    lines.push(
      "- Status: **SKIPPED**",
      `- Baseline: ${markdownCode(baseline)}`,
      "",
      result.output,
    );
  } else if (!result.ok) {
    const missing = missingDeclarations(result);
    lines.push(
      "- Status: **BLOCKED**",
      `- Baseline: ${markdownCode(baseline)}`,
      ...formatChangedContractsSection(result.findings),
      ...(isIncompleteOverride(missing)
        ? [
            ...formatReviewEvidenceSection(result),
            "",
            `The intentional breaking change override was rejected because ${
              missing.every((entry) => entry.issue === "missing")
                ? `it omits the ${describeMissingDeclarations(missing)}`
                : describeMissingDeclarations(missing)
            }.`,
          ]
        : []),
      "",
      "Unapproved breaking changes block the merge. Update the existing client contract or coordinate a versioned API change.",
      "For an intentional versioned break, add both lines to the pull request description:",
      ...breakingChangeDeclarations.map(
        (entry) => `- ${markdownCode(`${entry.marker}: ${entry.placeholder}`)}`,
      ),
    );
  } else if (result.overridden) {
    lines.push(
      "- Status: **APPROVED OVERRIDE**",
      `- Baseline: ${markdownCode(baseline)}`,
      ...formatChangedContractsSection(result.findings),
      ...formatReviewEvidenceSection(result),
    );
  } else {
    lines.push(
      "- Status: **COMPATIBLE**",
      `- Baseline: ${markdownCode(baseline)}`,
      "",
      "No breaking API contract changes were detected.",
    );
  }
  return lines.join("\n");
}

export function formatCompatibilityErrorSummary(message) {
  return [
    stepSummaryHeading,
    "",
    "- Status: **NOT CHECKED**",
    `- Error: ${markdownCode(message)}`,
  ].join("\n");
}

export function writeStepSummary(
  markdown,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
) {
  if (!summaryPath) {
    return false;
  }
  appendFileSync(summaryPath, `${markdown}\n`);
  return true;
}

function readBaseline(baselineRef) {
  try {
    return execFileSync("git", ["show", `${baselineRef}:${defaultSpecPath}`], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    throw new Error(
      `Unable to read the OpenAPI baseline at ${baselineRef}:${defaultSpecPath}. Fetch the target branch or pass --baseline-file. ${detail ?? ""}`.trim(),
    );
  }
}

function parseArgs(argv) {
  const options = {
    currentFile: resolve(workspaceRoot, defaultSpecPath),
    baselineFile: null,
    eventName: process.env.GITHUB_EVENT_NAME || null,
    baselineRef:
      process.env.OPENAPI_BASELINE_REF ||
      (process.env.GITHUB_BASE_REF
        ? `origin/${process.env.GITHUB_BASE_REF}`
        : "HEAD^"),
  };
  for (const entry of breakingChangeDeclarations) {
    options[entry.option] = process.env[entry.marker]?.trim() || null;
  }
  const declarationFlags = new Map(
    breakingChangeDeclarations.map((entry) => [entry.flag, entry]),
  );
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--current-file") {
      options.currentFile = resolve(argv[++index]);
    } else if (argument === "--baseline-file") {
      options.baselineFile = resolve(argv[++index]);
    } else if (argument === "--base-ref") {
      options.baselineRef = argv[++index];
    } else if (declarationFlags.has(argument)) {
      const entry = declarationFlags.get(argument);
      const value = argv[++index]?.trim();
      if (!value) {
        throw new Error(
          `${argument} requires a non-empty ${entry.label.toLowerCase()}`,
        );
      }
      options[entry.option] = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function resolveBreakingChangeDeclaration(options) {
  const declared = extractBreakingChangeDeclaration(
    options.pullRequestBody ?? process.env.API_BREAKING_CHANGE_PR_BODY,
  );
  return Object.fromEntries(
    breakingChangeDeclarations.map((entry) => [
      entry.key,
      options[entry.option]?.trim() || declared[entry.key],
    ]),
  );
}

export function runCompatibilityCheck(options) {
  if (options.eventName === "push") {
    return {
      ok: true,
      skipped: true,
      output:
        "API contract compatibility enforcement is skipped on push events because breaking changes are reviewed and enforced on the pull request before merge.",
      findings: [],
    };
  }
  if (!existsSync(options.currentFile)) {
    throw new Error(
      `Current OpenAPI document does not exist: ${options.currentFile}`,
    );
  }
  const currentDocument = YAML.parse(readFileSync(options.currentFile, "utf8"));
  const baselineText = options.baselineFile
    ? readFileSync(options.baselineFile, "utf8")
    : readBaseline(options.baselineRef);
  const baselineDocument = YAML.parse(baselineText);
  const findings = findBreakingChanges(baselineDocument, currentDocument);
  if (findings.length > 0) {
    const baseline = options.baselineFile ?? options.baselineRef;
    const declaration = resolveBreakingChangeDeclaration(options);
    if (missingDeclarations(declaration).length === 0) {
      return {
        ok: true,
        overridden: true,
        output: formatCompatibilityOverride(findings, baseline, declaration),
        findings,
        ...declaration,
      };
    }
    return {
      ok: false,
      output: formatCompatibilityFailure(findings, baseline, declaration),
      findings,
      ...declaration,
    };
  }
  return {
    ok: true,
    output: `API contract is backward compatible with ${options.baselineFile ?? options.baselineRef}.`,
    findings: [],
  };
}

function main() {
  let summary;
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runCompatibilityCheck(options);
    console.log(result.output);
    summary = formatCompatibilitySummary(
      result,
      options.baselineFile ?? options.baselineRef,
    );
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`API contract compatibility check failed: ${error.message}`);
    summary = formatCompatibilityErrorSummary(error.message);
    process.exitCode = 1;
  }
  // Publishes the decision to the GitHub Actions job summary when
  // GITHUB_STEP_SUMMARY is set; local runs only print to the console.
  writeStepSummary(summary);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main();
}
