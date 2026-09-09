import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const workspaceRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const defaultSpecPath = "lib/api-spec/openapi.yaml";
const breakingChangeJustificationMarker = "API_BREAKING_CHANGE_JUSTIFICATION";
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

export function formatCompatibilityFailure(findings, baselineRef) {
  return [
    `Breaking API contract changes detected against ${baselineRef}:`,
    ...findings.map((finding) => `- ${finding}`),
    "",
    "Additive endpoints and optional fields are allowed. Update the existing client contract or coordinate a versioned API change before merging.",
    `For an intentional versioned break, add "${breakingChangeJustificationMarker}: <reason>" to the pull request description.`,
  ].join("\n");
}

export function extractBreakingChangeJustification(text) {
  if (typeof text !== "string") {
    return null;
  }

  const markerPattern = new RegExp(
    `^\\s*${breakingChangeJustificationMarker}\\s*:\\s*(.+?)\\s*$`,
    "im",
  );
  const match = text.match(markerPattern);
  return match?.[1]?.trim() || null;
}

export function formatCompatibilityOverride(
  findings,
  baselineRef,
  justification,
) {
  return [
    `Breaking API contract changes detected against ${baselineRef}, but an intentional breaking change override was supplied.`,
    "Changed contracts:",
    ...findings.map((finding) => `- ${finding}`),
    "",
    `Justification (${breakingChangeJustificationMarker}): ${justification}`,
  ].join("\n");
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
    breakingChangeJustification:
      process.env.API_BREAKING_CHANGE_JUSTIFICATION?.trim() || null,
    baselineRef:
      process.env.OPENAPI_BASELINE_REF ||
      (process.env.GITHUB_BASE_REF
        ? `origin/${process.env.GITHUB_BASE_REF}`
        : "HEAD^"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--current-file") {
      options.currentFile = resolve(argv[++index]);
    } else if (argument === "--baseline-file") {
      options.baselineFile = resolve(argv[++index]);
    } else if (argument === "--base-ref") {
      options.baselineRef = argv[++index];
    } else if (argument === "--breaking-change-justification") {
      const justification = argv[++index]?.trim();
      if (!justification) {
        throw new Error(
          "--breaking-change-justification requires a non-empty reason",
        );
      }
      options.breakingChangeJustification = justification;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

export function runCompatibilityCheck(options) {
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
    const justification =
      options.breakingChangeJustification?.trim() ||
      extractBreakingChangeJustification(
        options.pullRequestBody ?? process.env.API_BREAKING_CHANGE_PR_BODY,
      );
    if (justification) {
      return {
        ok: true,
        overridden: true,
        output: formatCompatibilityOverride(
          findings,
          options.baselineFile ?? options.baselineRef,
          justification,
        ),
        findings,
        justification,
      };
    }
    return {
      ok: false,
      output: formatCompatibilityFailure(
        findings,
        options.baselineFile ?? options.baselineRef,
      ),
      findings,
    };
  }
  return {
    ok: true,
    output: `API contract is backward compatible with ${options.baselineFile ?? options.baselineRef}.`,
    findings: [],
  };
}

function main() {
  try {
    const result = runCompatibilityCheck(parseArgs(process.argv.slice(2)));
    console.log(result.output);
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`API contract compatibility check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main();
}
