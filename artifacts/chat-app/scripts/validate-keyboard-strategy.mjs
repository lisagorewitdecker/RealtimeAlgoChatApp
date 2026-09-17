// Source-level guard for the Chat App's single keyboard strategy.
//
// replit.md ("Keyboard handling on native has one strategy") records the rule:
// forms use components/KeyboardAwareScrollViewCompat.tsx, everything else uses
// KeyboardAvoidingView from react-native-keyboard-controller with
// behavior="padding" on both platforms. React Native's own KeyboardAvoidingView
// stops reacting on Android once the keyboard-controller provider owns the
// insets, and every Jest suite mocks react-native-keyboard-controller, so a
// screen that drifts back to the old component, omits the behavior prop, uses
// a non-padding behavior, or hides a platform split behind a helper can still
// pass both Jest projects. Only reading the source catches it without a device.
//
// The check parses app/** and components/** with the TypeScript compiler API
// (already a Chat App devDependency) instead of regular expressions so that
// comments, import aliases, namespace imports and same-file indirection
// (`const isIOS = Platform.OS === "ios"`) are handled exactly. Controller
// KeyboardAvoidingView usages are also required to provide an explicit,
// statically provable behavior="padding" prop.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const KEYBOARD_STRATEGY_NOTE =
  'the "Keyboard handling on native has one strategy" note in replit.md';

export const KEYBOARD_STRATEGY_SUMMARY =
  "forms use KeyboardAwareScrollViewCompat from components/KeyboardAwareScrollViewCompat.tsx; " +
  'everything else uses KeyboardAvoidingView from "react-native-keyboard-controller" ' +
  'with behavior="padding" on both platforms';

/** The one file allowed to use react-native-keyboard-controller's KeyboardAwareScrollView. */
export const COMPAT_COMPONENT_PATH = "components/KeyboardAwareScrollViewCompat.tsx";

/** Directories (relative to the package root) covered by the check. */
export const SCANNED_DIRECTORIES = ["app", "components"];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Values a KeyboardAvoidingView `behavior` prop can take (React Native + keyboard-controller). */
const KEYBOARD_BEHAVIORS = new Set(["padding", "height", "position", "translate-with-padding"]);

/** Platform names that appear next to a platform switch and say nothing about the value. */
const PLATFORM_LITERALS = new Set(["ios", "android", "web", "windows", "macos", "native", "default"]);

export const KEYBOARD_STRATEGY_RULES = {
  "react-native-keyboard-avoiding-view": {
    description: 'KeyboardAvoidingView is imported from "react-native"',
    fix: 'import KeyboardAvoidingView from "react-native-keyboard-controller" instead; React Native\'s own component stops reacting on Android once the keyboard-controller provider owns the insets',
  },
  "platform-split-behavior": {
    description: "a behavior prop is chosen by Platform.OS / Platform.select / process.env.EXPO_OS",
    fix: 'use behavior="padding" on both platforms; the platform split is the old workaround for React Native\'s KeyboardAvoidingView and puts Android back on the code path that fails',
  },
  "keyboard-avoiding-view-behavior": {
    description:
      'react-native-keyboard-controller\'s KeyboardAvoidingView does not have an explicit statically provable behavior="padding" prop',
    fix: 'give every react-native-keyboard-controller KeyboardAvoidingView an explicit behavior="padding" prop; aliases, namespaces, missing props, and unresolved values are not accepted',
  },
  "direct-keyboard-aware-scroll-view": {
    description: "react-native-keyboard-controller's KeyboardAwareScrollView is used directly",
    fix: `use KeyboardAwareScrollViewCompat from ${COMPAT_COMPONENT_PATH} for forms; only that component may use react-native-keyboard-controller's KeyboardAwareScrollView`,
  },
};

function scriptKindFor(file) {
  switch (path.extname(file)) {
    case ".ts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      // React Native convention allows JSX inside plain .js files.
      return ts.ScriptKind.JSX;
  }
}

function moduleNameOf(node) {
  const specifier = node.moduleSpecifier;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : null;
}

function requireModuleName(initializer) {
  if (
    initializer &&
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "require" &&
    initializer.arguments.length === 1 &&
    ts.isStringLiteral(initializer.arguments[0])
  ) {
    return initializer.arguments[0].text;
  }
  return null;
}

function propertyNameText(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

/** Collects every name bound by a binding pattern (nested destructuring included). */
function collectBoundNames(name, into) {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) collectBoundNames(element.name, into);
    }
  }
  return into;
}

/**
 * Walks one parsed file and records the facts the rules need: import
 * bindings, module namespaces, same-file declarations, `behavior` sites,
 * member accesses and JSX tag names.
 */
function collectFacts(sourceFile) {
  const facts = {
    // { local, imported, module, node, viaRequire }
    namedImports: [],
    // { local, module, node } for `import * as X`, `import X` and `const X = require()`
    namespaceImports: [],
    // { exported, module, node } for `export { X } from "module"`
    reexports: [],
    // declared name -> declaration nodes (variable declarations, functions)
    declarations: new Map(),
    // { node, expression, kind } where kind is "jsx" | "property" | "shorthand"
    behaviorSites: [],
    memberAccesses: [],
    jsxTagIdentifiers: [],
    // { node, tagName } for JSX opening and self-closing elements
    jsxElements: [],
  };

  const addDeclaration = (name, node) => {
    const list = facts.declarations.get(name) ?? [];
    list.push(node);
    facts.declarations.set(name, list);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const module = moduleNameOf(node);
      const clause = node.importClause;
      if (module && clause) {
        if (clause.name) {
          facts.namespaceImports.push({ local: clause.name.text, module, node: clause.name });
        }
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          facts.namespaceImports.push({ local: bindings.name.text, module, node: bindings });
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            facts.namedImports.push({
              local: element.name.text,
              imported: (element.propertyName ?? element.name).text,
              module,
              node: element,
              viaRequire: false,
            });
          }
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const module = moduleNameOf(node);
      if (module && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          facts.reexports.push({
            exported: (element.propertyName ?? element.name).text,
            module,
            node: element,
          });
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      const module = requireModuleName(node.initializer);
      if (module && ts.isIdentifier(node.name)) {
        facts.namespaceImports.push({ local: node.name.text, module, node: node.name });
      } else if (module && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const imported = element.propertyName
            ? propertyNameText(element.propertyName)
            : ts.isIdentifier(element.name)
              ? element.name.text
              : null;
          if (imported) {
            facts.namedImports.push({
              local: ts.isIdentifier(element.name) ? element.name.text : imported,
              imported,
              module,
              node: element,
              viaRequire: true,
            });
          }
        }
      }
      if (!module) {
        for (const name of collectBoundNames(node.name, [])) addDeclaration(name, node);
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      addDeclaration(node.name.text, node);
    } else if (ts.isJsxAttribute(node)) {
      if (propertyNameText(node.name) === "behavior") {
        const initializer = node.initializer;
        // A string attribute (behavior="padding") is fixed by construction.
        const expression =
          initializer && ts.isJsxExpression(initializer) ? (initializer.expression ?? null) : null;
        facts.behaviorSites.push({ node, expression, kind: "jsx" });
      }
    } else if (ts.isPropertyAssignment(node)) {
      if (propertyNameText(node.name) === "behavior") {
        facts.behaviorSites.push({ node, expression: node.initializer, kind: "property" });
      }
    } else if (ts.isShorthandPropertyAssignment(node)) {
      if (node.name.text === "behavior") {
        facts.behaviorSites.push({ node, expression: node.name, kind: "shorthand" });
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      facts.memberAccesses.push(node);
    } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      facts.jsxElements.push({ node, tagName: node.tagName });
      if (ts.isIdentifier(node.tagName)) facts.jsxTagIdentifiers.push(node.tagName);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return facts;
}

/**
 * Same-file targets a reference resolves to, so a value can be followed back
 * to the code that computes it.
 *
 * - `name` resolves to every declaration of that name (variable initializers,
 *   function declarations).
 * - `object.property` resolves to that single property when `object` is
 *   declared as a plain object literal, so an unrelated Platform use elsewhere
 *   in the same object does not count.
 *
 * Returns `null` when the node is not a resolvable reference.
 */
function referenceTargets(node, context) {
  const { declarations } = context;
  if (ts.isIdentifier(node)) {
    const found = declarations.get(node.text);
    if (!found) return null;
    return {
      key: node.text,
      label: `\`${node.text}\``,
      targets: found
        .map((declaration) => ({
          declaration,
          node: ts.isVariableDeclaration(declaration) ? (declaration.initializer ?? null) : declaration,
        }))
        .filter((target) => target.node),
    };
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    declarations.has(node.expression.text)
  ) {
    const found = declarations.get(node.expression.text);
    if (found.length !== 1) return null;
    const [declaration] = found;
    if (
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      !ts.isObjectLiteralExpression(declaration.initializer) ||
      declaration.initializer.properties.some((property) => ts.isSpreadAssignment(property))
    ) {
      return null;
    }
    for (const property of declaration.initializer.properties) {
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === node.name.text) {
        return {
          key: `${node.expression.text}.${node.name.text}`,
          label: `\`${node.expression.text}.${node.name.text}\``,
          targets: [{ declaration, node: property.initializer }],
        };
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === node.name.text) {
        return {
          key: `${node.expression.text}.${node.name.text}`,
          label: `\`${node.expression.text}.${node.name.text}\``,
          targets: [{ declaration, node: property.name }],
        };
      }
    }
  }
  return null;
}

/**
 * Explains how `node` depends on the platform ("Platform.OS", "RN.Platform.select",
 * "process.env.EXPO_OS"), following same-file declarations transitively so that
 * `const isIOS = Platform.OS === "ios"` feeding `behavior={isIOS ? … : …}` is
 * still reported. Returns null when the value does not depend on the platform.
 */
function platformDependency(node, context, visited = new Set()) {
  if (!node) return null;
  const { sourceFile, platformNames, namespaceNames } = context;
  const lineOf = (target) =>
    sourceFile.getLineAndCharacterOfPosition(target.getStart(sourceFile)).line + 1;
  const platformLabel = (local, member) =>
    `${local}${member ? `.${member}` : ""}${local === "Platform" ? "" : " (Platform imported as " + local + ")"}`;

  const follow = (reference) => {
    if (visited.has(reference.key)) return null;
    visited.add(reference.key);
    for (const target of reference.targets) {
      const nested = platformDependency(target.node, context, visited);
      if (nested) {
        return `${nested} through ${reference.label} (declared on line ${lineOf(target.declaration)})`;
      }
    }
    return null;
  };

  if (ts.isIdentifier(node)) {
    if (platformNames.has(node.text)) return platformLabel(node.text);
    const reference = referenceTargets(node, context);
    return reference ? follow(reference) : null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const object = node.expression;
    if (ts.isIdentifier(object) && platformNames.has(object.text)) {
      return platformLabel(object.text, node.name.text);
    }
    if (ts.isIdentifier(object) && namespaceNames.has(object.text) && node.name.text === "Platform") {
      return `${object.text}.Platform`;
    }
    if (
      ts.isPropertyAccessExpression(object) &&
      ts.isIdentifier(object.expression) &&
      namespaceNames.has(object.expression.text) &&
      object.name.text === "Platform"
    ) {
      return `${object.expression.text}.Platform.${node.name.text}`;
    }
    if (node.name.text === "EXPO_OS") return "process.env.EXPO_OS";
    const reference = referenceTargets(node, context);
    if (reference) return follow(reference);
    // Only the object side can name Platform; `.name` is a property label.
    return platformDependency(object, context, visited);
  }
  if (ts.isElementAccessExpression(node)) {
    const argument = node.argumentExpression;
    if (argument && ts.isStringLiteral(argument) && argument.text === "EXPO_OS") {
      return "process.env.EXPO_OS";
    }
    return (
      platformDependency(node.expression, context, visited) ??
      (argument ? platformDependency(argument, context, visited) : null)
    );
  }
  if (ts.isPropertyAssignment(node)) {
    // `{ ios: "padding" }` – the key is a label, only the value is code.
    return platformDependency(node.initializer, context, visited);
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    return platformDependency(node.name, context, visited);
  }
  let found = null;
  ts.forEachChild(node, (child) => {
    if (!found) found = platformDependency(child, context, visited);
  });
  return found;
}

/**
 * Collects the string values a behavior expression can produce, following the
 * same same-file references as `platformDependency`. Platform names used by
 * the switch itself ("ios", "android", …) are left out.
 */
function collectStringValues(node, context, values = new Set(), visited = new Set()) {
  if (!node) return values;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (!PLATFORM_LITERALS.has(node.text)) values.add(node.text);
    return values;
  }
  if (ts.isPropertyAssignment(node)) {
    return collectStringValues(node.initializer, context, values, visited);
  }
  const reference = referenceTargets(node, context);
  if (reference) {
    // A resolved reference stands for exactly its targets; sweeping the rest
    // of an object literal could make an unknown value look like a known one.
    if (!visited.has(reference.key)) {
      visited.add(reference.key);
      for (const target of reference.targets) {
        collectStringValues(target.node, context, values, visited);
      }
    }
    return values;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return collectStringValues(node.expression, context, values, visited);
  }
  ts.forEachChild(node, (child) => {
    collectStringValues(child, context, values, visited);
  });
  return values;
}

/**
 * Returns true only when a behavior expression resolves to the single literal
 * "padding". This intentionally accepts same-file constants and plain object
 * properties, but rejects conditionals, calls, hooks, missing values, and
 * unresolved references: the keyboard strategy must be visible at the call
 * site and provable without executing the app.
 */
function isStaticallyPadding(node, context, visited = new Set()) {
  if (!node) return false;
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text === "padding";
  }
  if (ts.isParenthesizedExpression(node)) {
    return isStaticallyPadding(node.expression, context, visited);
  }
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return isStaticallyPadding(node.expression, context, visited);
  }

  const reference = referenceTargets(node, context);
  if (!reference || visited.has(reference.key) || reference.targets.length === 0) {
    return false;
  }
  visited.add(reference.key);
  return reference.targets.every((target) =>
    isStaticallyPadding(target.node, context, visited),
  );
}

function isControllerKeyboardAvoidingViewTag(tagName, facts, visited = new Set()) {
  const controllerNamespaces = new Set(
    facts.namespaceImports
      .filter((entry) => entry.module === "react-native-keyboard-controller")
      .map((entry) => entry.local),
  );
  const controllerBindings = new Set(
    facts.namedImports
      .filter(
        (entry) =>
          entry.module === "react-native-keyboard-controller" &&
          entry.imported === "KeyboardAvoidingView",
      )
      .map((entry) => entry.local),
  );

  if (ts.isPropertyAccessExpression(tagName)) {
    return (
      tagName.name.text === "KeyboardAvoidingView" &&
      ts.isIdentifier(tagName.expression) &&
      controllerNamespaces.has(tagName.expression.text)
    );
  }
  if (!ts.isIdentifier(tagName)) return false;
  if (controllerBindings.has(tagName.text)) return true;

  // Also follow a same-file alias such as:
  // const KAV = KeyboardController.KeyboardAvoidingView;
  if (visited.has(tagName.text)) return false;
  visited.add(tagName.text);
  return (facts.declarations.get(tagName.text) ?? []).some(
    (declaration) =>
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      isControllerKeyboardAvoidingViewTag(
        declaration.initializer,
        facts,
        visited,
      ),
  );
}

function behaviorAttributeFor(element) {
  return element.node.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) &&
      propertyNameText(property.name) === "behavior",
  );
}

function behaviorExpressionFor(attribute) {
  if (!attribute?.initializer) return null;
  if (
    ts.isStringLiteral(attribute.initializer) ||
    ts.isNoSubstitutionTemplateLiteral(attribute.initializer)
  ) {
    return attribute.initializer;
  }
  if (ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.expression ?? null;
  }
  return null;
}

/**
 * Scans one source text and returns the rule violations it contains.
 *
 * @param {{ file: string, source: string, packageRelativePath?: string }} input
 *   `file` is the display name used in findings; `packageRelativePath` (POSIX,
 *   relative to the package root) decides the compat-component exemption and
 *   defaults to `file`.
 * @returns {Array<{ file: string, rule: string, line: number, detail: string }>}
 */
export function scanKeyboardStrategySource({ file, source, packageRelativePath = file }) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const facts = collectFacts(sourceFile);
  const findings = [];
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const report = (rule, node, detail) => {
    findings.push({ file, rule, line: lineOf(node), detail });
  };

  const isCompatComponent =
    packageRelativePath.split(path.sep).join("/") === COMPAT_COMPONENT_PATH;

  // Rule: KeyboardAvoidingView imported from "react-native".
  const reactNativeNamespaces = new Set(
    facts.namespaceImports
      .filter((entry) => entry.module === "react-native")
      .map((entry) => entry.local),
  );
  let reportedReactNativeImport = false;
  for (const entry of facts.namedImports) {
    if (entry.module === "react-native" && entry.imported === "KeyboardAvoidingView") {
      reportedReactNativeImport = true;
      report(
        "react-native-keyboard-avoiding-view",
        entry.node,
        entry.viaRequire
          ? 'destructures KeyboardAvoidingView from require("react-native")'
          : entry.local === entry.imported
            ? 'imports KeyboardAvoidingView from "react-native"'
            : `imports KeyboardAvoidingView from "react-native" as ${entry.local}`,
      );
    }
  }
  for (const entry of facts.reexports) {
    if (entry.module === "react-native" && entry.exported === "KeyboardAvoidingView") {
      reportedReactNativeImport = true;
      report(
        "react-native-keyboard-avoiding-view",
        entry.node,
        're-exports KeyboardAvoidingView from "react-native"',
      );
    }
  }
  if (!reportedReactNativeImport) {
    for (const access of facts.memberAccesses) {
      if (
        access.name.text === "KeyboardAvoidingView" &&
        ts.isIdentifier(access.expression) &&
        reactNativeNamespaces.has(access.expression.text)
      ) {
        report(
          "react-native-keyboard-avoiding-view",
          access,
          `uses ${access.expression.text}.KeyboardAvoidingView from "react-native"`,
        );
      }
    }
  }

  // Rule: a behavior prop chosen by platform.
  const platformNames = new Set(["Platform"]);
  for (const entry of facts.namedImports) {
    if (entry.imported === "Platform") platformNames.add(entry.local);
  }
  const namespaceNames = new Set(facts.namespaceImports.map((entry) => entry.local));
  const context = { sourceFile, platformNames, namespaceNames, declarations: facts.declarations };
  for (const site of facts.behaviorSites) {
    const dependency = platformDependency(site.expression, context);
    if (!dependency) continue;
    // A `behavior` that can only ever be a non-keyboard value (a DOM
    // scrollTo({ behavior: "smooth" }) option, say) is not this rule's target.
    // Unknown values stay reported: a hook or helper may hide the switch.
    const values = collectStringValues(site.expression, context);
    const clearlyNotKeyboard =
      values.size > 0 && [...values].every((value) => !KEYBOARD_BEHAVIORS.has(value));
    if (clearlyNotKeyboard) continue;
    report(
      "platform-split-behavior",
      site.node,
      `the behavior ${site.kind === "jsx" ? "prop" : "property"} depends on ${dependency}`,
    );
  }

  // Rule: controller KeyboardAvoidingView must make the padding strategy
  // explicit. This is separate from the platform rule because a fixed
  // `height`, an omitted prop, or an opaque helper is still unsafe.
  for (const element of facts.jsxElements) {
    if (!isControllerKeyboardAvoidingViewTag(element.tagName, facts)) continue;
    const behaviorAttribute = behaviorAttributeFor(element);
    const behaviorExpression = behaviorExpressionFor(behaviorAttribute);
    if (isStaticallyPadding(behaviorExpression, context)) continue;
    report(
      "keyboard-avoiding-view-behavior",
      behaviorAttribute ?? element.tagName,
      behaviorAttribute
        ? 'react-native-keyboard-controller\'s KeyboardAvoidingView must use an explicit statically provable behavior="padding" prop'
        : 'react-native-keyboard-controller\'s KeyboardAvoidingView is missing an explicit statically provable behavior="padding" prop',
    );
  }

  // Rule: KeyboardAwareScrollView used directly outside the compat component.
  if (!isCompatComponent) {
    let reportedDirectImport = false;
    for (const entry of facts.namedImports) {
      if (entry.imported === "KeyboardAwareScrollView") {
        reportedDirectImport = true;
        report(
          "direct-keyboard-aware-scroll-view",
          entry.node,
          entry.viaRequire
            ? `destructures KeyboardAwareScrollView from require("${entry.module}")`
            : `imports KeyboardAwareScrollView from "${entry.module}"`,
        );
      }
    }
    for (const entry of facts.reexports) {
      if (entry.exported === "KeyboardAwareScrollView") {
        reportedDirectImport = true;
        report(
          "direct-keyboard-aware-scroll-view",
          entry.node,
          `re-exports KeyboardAwareScrollView from "${entry.module}"`,
        );
      }
    }
    if (!reportedDirectImport) {
      for (const access of facts.memberAccesses) {
        if (
          access.name.text === "KeyboardAwareScrollView" &&
          ts.isIdentifier(access.expression) &&
          namespaceNames.has(access.expression.text)
        ) {
          reportedDirectImport = true;
          report(
            "direct-keyboard-aware-scroll-view",
            access,
            `uses ${access.expression.text}.KeyboardAwareScrollView directly`,
          );
        }
      }
    }
    if (!reportedDirectImport) {
      for (const tag of facts.jsxTagIdentifiers) {
        if (tag.text === "KeyboardAwareScrollView") {
          report(
            "direct-keyboard-aware-scroll-view",
            tag,
            "renders <KeyboardAwareScrollView> directly",
          );
        }
      }
    }
  }

  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return findings;
}

function listSourceFiles(directory) {
  const files = [];
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(entryPath);
      }
    }
  };
  walk(directory);
  return files;
}

/**
 * Scans the package's app/ and components/ trees.
 *
 * @param {{ packageRoot?: string, workspaceRoot?: string, directories?: string[] }} options
 *   Findings name files relative to `workspaceRoot` (defaults to two levels
 *   above the package root, i.e. `artifacts/chat-app/app/...`).
 * @returns {{ findings: Array<{ file: string, rule: string, line: number, detail: string }>, scannedFiles: string[] }}
 */
export function scanKeyboardStrategy({
  packageRoot = defaultPackageRoot(),
  workspaceRoot = path.resolve(packageRoot, "../.."),
  directories = SCANNED_DIRECTORIES,
} = {}) {
  const findings = [];
  const scannedFiles = [];
  for (const directory of directories) {
    const absoluteDirectory = path.join(packageRoot, directory);
    let stats;
    try {
      stats = statSync(absoluteDirectory);
    } catch {
      stats = null;
    }
    if (!stats || !stats.isDirectory()) {
      throw new Error(
        `Keyboard strategy check: expected directory ${path.relative(workspaceRoot, absoluteDirectory)} ` +
          "does not exist. Update SCANNED_DIRECTORIES in scripts/validate-keyboard-strategy.mjs if the Chat App source moved.",
      );
    }
    for (const absoluteFile of listSourceFiles(absoluteDirectory)) {
      const file = path.relative(workspaceRoot, absoluteFile).split(path.sep).join("/");
      const packageRelativePath = path
        .relative(packageRoot, absoluteFile)
        .split(path.sep)
        .join("/");
      scannedFiles.push(file);
      findings.push(
        ...scanKeyboardStrategySource({
          file,
          source: readFileSync(absoluteFile, "utf8"),
          packageRelativePath,
        }),
      );
    }
  }
  if (scannedFiles.length === 0) {
    throw new Error(
      `Keyboard strategy check: no source files found under ${directories.join(", ")}; refusing to pass an empty scan.`,
    );
  }
  return { findings, scannedFiles };
}

/** Formats findings as the failure message: file, line, rule, what was found, and the fix. */
export function formatKeyboardStrategyFailure(findings) {
  const lines = [
    `Keyboard strategy violation${findings.length === 1 ? "" : "s"} in the Chat App ` +
      `(${KEYBOARD_STRATEGY_SUMMARY}; see ${KEYBOARD_STRATEGY_NOTE}):`,
  ];
  for (const finding of findings) {
    const rule = KEYBOARD_STRATEGY_RULES[finding.rule];
    lines.push(`  - ${finding.file}:${finding.line} [${finding.rule}] ${finding.detail}. Fix: ${rule.fix}.`);
  }
  return lines.join("\n");
}

/** Throws with the formatted failure message when the scan finds violations. */
export function assertKeyboardStrategy(options) {
  const result = scanKeyboardStrategy(options);
  if (result.findings.length > 0) {
    throw new Error(formatKeyboardStrategyFailure(result.findings));
  }
  return result;
}

function defaultPackageRoot() {
  return path.resolve(fileURLToPath(new URL("..", import.meta.url)));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a directory argument.");
      options.packageRoot = path.resolve(value);
      index += 1;
    } else if (argument.startsWith("--root=")) {
      options.packageRoot = path.resolve(argument.slice("--root=".length));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.packageRoot) {
    // A custom root (fixtures, other checkouts) reports paths relative to itself.
    options.workspaceRoot = options.packageRoot;
  }
  const { findings, scannedFiles } = scanKeyboardStrategy(options);
  if (findings.length > 0) {
    console.error(formatKeyboardStrategyFailure(findings));
    process.exitCode = 1;
    return;
  }
  console.log(
    `Keyboard strategy check passed: ${scannedFiles.length} source files under ` +
      `${SCANNED_DIRECTORIES.map((directory) => `${directory}/`).join(" and ")} follow ${KEYBOARD_STRATEGY_NOTE}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
