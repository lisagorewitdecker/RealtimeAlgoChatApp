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
// The check parses every top-level directory of the package except the known
// non-source ones (NON_SOURCE_DIRECTORIES: dependencies, assets, the test
// suites with their stand-ins and output, this package's scripts, written
// records, build output) and dot-directories, so app/**, components/** and
// every shared-module home — hooks/**, lib/**, contexts/**, utils/**,
// constants/** and any folder added later (services/, store/, features/, …) —
// are read at module level without editing a list; app/ and components/ must
// exist. It uses the TypeScript compiler API (already a Chat App
// devDependency) instead of regular expressions so that comments, import
// aliases, namespace imports and same-file indirection
// (`const isIOS = Platform.OS === "ios"`) are handled exactly. A behavior value
// or JSX tag that comes from another Chat App file (`@/hooks/...`, `./...`) is
// followed one import hop: the module is parsed and the exported declaration
// resolved, so `behavior={useKeyboardBehavior()}` is traced into the hook.
// Anything further away — a second hop, `export *`, a module that cannot be
// found — is rejected outright so the platform split cannot be hidden by
// moving it. Controller KeyboardAvoidingView usages are also required to
// provide an explicit, statically provable behavior="padding" prop at the
// call site. Root-level files are configuration (Metro, Babel, Jest) and are
// not scanned; a value or tag imported from one is still followed from its
// call site like any other module.
//
// None of that helps if the provider itself disappears: the controller's
// KeyboardAvoidingView and KeyboardAwareScrollView only work under
// KeyboardProvider, which the root layout (app/_layout.tsx) renders around
// the navigator, and the Jest suites mock the provider as a pass-through. The
// whole-tree rule therefore follows the tree the root layout's default export
// renders — same-file components by name, a component imported from another
// Chat App file one hop — and fails when the navigator (expo-router's Stack,
// Slot, Tabs, …) is reached outside a KeyboardProvider from
// react-native-keyboard-controller, or is not found at all.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const KEYBOARD_STRATEGY_NOTE =
  'the "Keyboard handling on native has one strategy" note in replit.md';

export const KEYBOARD_STRATEGY_SUMMARY =
  "forms use KeyboardAwareScrollViewCompat from components/KeyboardAwareScrollViewCompat.tsx; " +
  'everything else uses KeyboardAvoidingView from "react-native-keyboard-controller" ' +
  'with behavior="padding" on both platforms; app/_layout.tsx wraps the navigator in ' +
  'KeyboardProvider from "react-native-keyboard-controller"';

/** The one file allowed to use react-native-keyboard-controller's KeyboardAwareScrollView. */
export const COMPAT_COMPONENT_PATH = "components/KeyboardAwareScrollViewCompat.tsx";

/** The root layout expo-router mounts every screen under; it owns the KeyboardProvider. */
export const ROOT_LAYOUT_PATH = "app/_layout.tsx";

/**
 * expo-router components that render the matched child routes. Every screen
 * mounts inside one of them, so a KeyboardProvider above the navigator covers
 * the whole app and one below or beside it covers nothing.
 */
export const ROUTER_NAVIGATOR_EXPORTS = ["Stack", "Slot", "Tabs", "NativeTabs", "Drawer", "Navigator"];

/**
 * Top-level directories (relative to the package root) that never hold app
 * source and are skipped by the scan: dependencies, static assets, the test
 * suites with their stand-ins, device flows and output, this package's Node
 * tooling (this check included), written records, and build output — the web
 * export and the native projects `expo prebuild` generates. Dot-directories
 * (`.expo`, `.replit-artifact`, …) are skipped as well. Every other top-level
 * directory is scanned, so a helper moved into constants/ or into a folder
 * that does not exist yet is read at module level without editing this list.
 * Keep the list in step with the "Keyboard handling on native has one
 * strategy" note in replit.md.
 */
export const NON_SOURCE_DIRECTORIES = [
  "node_modules",
  "assets",
  "__tests__",
  "__mocks__",
  "test-utils",
  "test-results",
  "coverage",
  "e2e",
  "scripts",
  "docs",
  "dist",
  "web-build",
  "static-build",
  "build",
  "ios",
  "android",
];

/**
 * Directories that must exist: the screens and the components. They are
 * scanned whatever the exclusions say, and a tree without them is not the
 * Chat App, so the scan refuses to run instead of passing on what is left.
 */
export const REQUIRED_DIRECTORIES = ["app", "components"];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Extensions tried, in order, when an import specifier names a module without one. */
const RESOLVED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** tsconfig.json maps `@/*` onto the package root. */
const PACKAGE_ALIAS = "@/";

/**
 * Metro picks `module.<platform>.<ext>` over `module.<ext>` per platform, so a
 * module with such variants is a platform split by file name.
 */
const PLATFORM_FILE_SUFFIXES = ["ios", "android", "native", "web"];

/** Values a KeyboardAvoidingView `behavior` prop can take (React Native + keyboard-controller). */
const KEYBOARD_BEHAVIORS = new Set(["padding", "height", "position", "translate-with-padding"]);

/** Platform names that appear next to a platform switch and say nothing about the value. */
const PLATFORM_LITERALS = new Set(["ios", "android", "web", "windows", "macos", "native", "default"]);

const KEYBOARD_CONTROLLER = "react-native-keyboard-controller";
const REACT_NATIVE = "react-native";
const EXPO_ROUTER = "expo-router";

/** `Stack` from "expo-router", `NativeTabs` from "expo-router/unstable-native-tabs", … */
function isRouterNavigatorExport(module, exportName) {
  return (
    (module === EXPO_ROUTER || module.startsWith(`${EXPO_ROUTER}/`)) &&
    ROUTER_NAVIGATOR_EXPORTS.includes(exportName)
  );
}

export const KEYBOARD_STRATEGY_RULES = {
  "root-keyboard-provider": {
    description:
      `${ROOT_LAYOUT_PATH} does not render KeyboardProvider from "react-native-keyboard-controller" around the navigator`,
    fix:
      `keep <KeyboardProvider> from "react-native-keyboard-controller" in ${ROOT_LAYOUT_PATH} with the navigator ` +
      `(${formatList(ROUTER_NAVIGATOR_EXPORTS.map((name) => `<${name}>`), "or")} from "expo-router") nested inside it; ` +
      "without the provider KeyboardAvoidingView and KeyboardAwareScrollViewCompat do nothing on devices, and every " +
      "Jest suite mocks the provider as a pass-through, so only this check notices. The check follows the tree " +
      "from the default export through same-file components and one import hop; the navigator must be nested " +
      "inside the provider element on that path, not passed through a children prop",
  },
  "react-native-keyboard-avoiding-view": {
    description: 'KeyboardAvoidingView is imported from "react-native"',
    fix: 'import KeyboardAvoidingView from "react-native-keyboard-controller" instead; React Native\'s own component stops reacting on Android once the keyboard-controller provider owns the insets',
  },
  "platform-split-behavior": {
    description:
      "a behavior prop is chosen by Platform.OS / Platform.select / process.env.EXPO_OS or by platform-specific module files",
    fix: 'use behavior="padding" on both platforms; the platform split is the old workaround for React Native\'s KeyboardAvoidingView and puts Android back on the code path that fails',
  },
  "behavior-from-another-file": {
    description: "a behavior value comes from another file that the check cannot follow",
    fix: 'keep the fixed "padding" value at the call site; the check follows a behavior value one import hop into another Chat App file, so a value defined further away, behind export *, or in a module it cannot find is rejected',
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

function parseSource(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
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

function hasModifier(node, kind) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
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

/** Local import specifiers: the `@/` package alias and relative paths. Everything else is a package. */
function isLocalSpecifier(specifier) {
  return (
    specifier.startsWith(PACKAGE_ALIAS) ||
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

/**
 * True for the identifier that names a declaration (`function name`, `class
 * Name`, `const name`, a parameter). Such an identifier introduces a binding
 * rather than reading one, so the walkers must not resolve it as a reference:
 * a followed function declaration would otherwise report itself twice.
 */
function isDeclarationName(node) {
  const parent = node.parent;
  return Boolean(
    parent &&
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isPropertyDeclaration(parent)) &&
      parent.name === node,
  );
}

function lineIn(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function formatList(items, conjunction = "and") {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/**
 * Walks one parsed file and records the facts the rules need: import
 * bindings, module namespaces, exports, same-file declarations, `behavior`
 * sites, member accesses and JSX tag names.
 */
function collectFacts(sourceFile) {
  const facts = {
    // { local, imported, module, node, viaRequire, isTypeOnly }
    namedImports: [],
    // { local, module, node, kind } for `import * as X` / `const X = require()`
    // (kind "namespace") and `import X` (kind "default")
    namespaceImports: [],
    // { exported, module, node } for `export { X } from "module"`; `exported`
    // is the name on the module's side
    reexports: [],
    // declared name -> declaration nodes (variable declarations, functions, classes)
    declarations: new Map(),
    // exported name -> how to reach the value:
    //   { kind: "local", local, node }            a same-file binding (declaration or import)
    //   { kind: "declaration", declaration, node } an anonymous `export default` value
    //   { kind: "reexport", module, imported, node } `export { imported as name } from "module"`
    exports: new Map(),
    // module specifiers of `export * from "module"`
    starExports: [],
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
          facts.namespaceImports.push({ local: clause.name.text, module, node: clause.name, kind: "default" });
        }
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          facts.namespaceImports.push({ local: bindings.name.text, module, node: bindings, kind: "namespace" });
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            facts.namedImports.push({
              local: element.name.text,
              imported: (element.propertyName ?? element.name).text,
              module,
              node: element,
              viaRequire: false,
              isTypeOnly: Boolean(clause.isTypeOnly || element.isTypeOnly),
            });
          }
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const module = moduleNameOf(node);
      const clause = node.exportClause;
      if (!clause && module) {
        facts.starExports.push(module);
      } else if (clause && ts.isNamespaceExport(clause) && module) {
        facts.exports.set(clause.name.text, { kind: "reexport", module, imported: "*", node: clause });
      } else if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const local = (element.propertyName ?? element.name).text;
          if (module) {
            facts.reexports.push({ exported: local, module, node: element });
          }
          if (node.isTypeOnly || element.isTypeOnly) continue;
          facts.exports.set(
            element.name.text,
            module
              ? { kind: "reexport", module, imported: local, node: element }
              : { kind: "local", local, node: element },
          );
        }
      }
    } else if (ts.isExportAssignment(node)) {
      // `export default expr`; `export = x` is not used by the Chat App and stays unresolved.
      if (!node.isExportEquals) {
        facts.exports.set("default", { kind: "declaration", declaration: node, node: node.expression });
      }
    } else if (ts.isVariableStatement(node)) {
      if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of node.declarationList.declarations) {
          for (const name of collectBoundNames(declaration.name, [])) {
            facts.exports.set(name, { kind: "local", local: name, node: declaration });
          }
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      const module = requireModuleName(node.initializer);
      if (module && ts.isIdentifier(node.name)) {
        facts.namespaceImports.push({ local: node.name.text, module, node: node.name, kind: "namespace" });
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
              isTypeOnly: false,
            });
          }
        }
      }
      if (!module) {
        for (const name of collectBoundNames(node.name, [])) addDeclaration(name, node);
      }
    } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) addDeclaration(node.name.text, node);
      if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
        const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
        if (node.name) {
          facts.exports.set(isDefault ? "default" : node.name.text, {
            kind: "local",
            local: node.name.text,
            node,
          });
        } else if (isDefault) {
          facts.exports.set("default", { kind: "declaration", declaration: node, node });
        }
      }
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
 * Everything the rules need to know about one parsed file. `resolveModule`
 * (specifier -> loaded module, see createModuleLoader) enables the single
 * import hop; the modules reached through it get a context without one.
 */
function createContext(sourceFile, facts, resolveModule) {
  const platformNames = new Set(["Platform"]);
  for (const entry of facts.namedImports) {
    if (entry.imported === "Platform") platformNames.add(entry.local);
  }
  const namespaceNames = new Set(facts.namespaceImports.map((entry) => entry.local));
  return {
    sourceFile,
    facts,
    platformNames,
    namespaceNames,
    declarations: facts.declarations,
    resolveModule,
  };
}

/** Keys for `visited` sets are scoped per file so a hop cannot collide with a same-named local. */
function visitKey(context, name) {
  return `${context.sourceFile.fileName}\u0000${name}`;
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
      key: visitKey(context, node.text),
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
          key: visitKey(context, `${node.expression.text}.${node.name.text}`),
          label: `\`${node.expression.text}.${node.name.text}\``,
          targets: [{ declaration, node: property.initializer }],
        };
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === node.name.text) {
        return {
          key: visitKey(context, `${node.expression.text}.${node.name.text}`),
          label: `\`${node.expression.text}.${node.name.text}\``,
          targets: [{ declaration, node: property.name }],
        };
      }
    }
  }
  return null;
}

/** The import binding a local name stands for, if it is imported at all. */
function importBindingFor(name, facts) {
  const named = facts.namedImports.find((entry) => entry.local === name && !entry.isTypeOnly);
  if (named) {
    return { local: name, module: named.module, imported: named.imported, node: named.node };
  }
  const namespace = facts.namespaceImports.find((entry) => entry.local === name);
  if (namespace) {
    return {
      local: name,
      module: namespace.module,
      imported: namespace.kind === "default" ? "default" : "*",
      node: namespace.node,
    };
  }
  return null;
}

/**
 * Describes `node` as a reference into another module when it is an imported
 * identifier or a property chain rooted in one: `useKeyboardBehavior`,
 * `keyboard.BEHAVIOR` (namespace import, so `BEHAVIOR` is the export),
 * `config.behavior` (named import `config`, then its property). Returns null
 * for anything else.
 */
function importedReference(node, context) {
  const properties = [];
  let root = node;
  while (ts.isPropertyAccessExpression(root)) {
    properties.unshift(root.name.text);
    root = root.expression;
  }
  if (!ts.isIdentifier(root)) return null;
  const binding = importBindingFor(root.text, context.facts);
  if (!binding) return null;
  const label = `\`${[root.text, ...properties].join(".")}\``;
  let exported = binding.imported;
  if (exported === "*") {
    if (properties.length === 0) return { binding, exported: "*", properties: [], label };
    exported = properties.shift();
  }
  return { binding, exported, properties, label };
}

/**
 * Unwraps the syntax that never changes a value: parentheses, `as`,
 * `satisfies`, `<T>` assertions and `!`.
 */
function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * `target.property` through a plain object literal (exact, so an unrelated
 * platform switch in a sibling property does not count). Anything else keeps
 * the whole value, which is the conservative reading.
 */
function propertyTargets(target, property) {
  const value = unwrapExpression(target.node);
  if (
    !value ||
    !ts.isObjectLiteralExpression(value) ||
    value.properties.some((member) => ts.isSpreadAssignment(member))
  ) {
    return [target];
  }
  for (const member of value.properties) {
    if (propertyNameText(member.name) !== property) continue;
    if (ts.isPropertyAssignment(member)) return [{ declaration: target.declaration, node: member.initializer }];
    if (ts.isShorthandPropertyAssignment(member)) return [{ declaration: target.declaration, node: member.name }];
    return [{ declaration: target.declaration, node: member }];
  }
  // A plain literal without the property: the value is undefined.
  return [];
}

/**
 * Resolves an imported reference exactly one hop: loads the module, resolves
 * the exported name and walks trailing properties. The loaded module's own
 * imports are never followed.
 *
 * @returns {{ status: "external" }
 *   | { status: "unavailable" | "missing" | "unresolved", reason: string, record?: object }
 *   | { status: "reexport", record: object, binding: { module: string, imported: string }, platformVariants: string[] }
 *   | { status: "resolved", record: object | null, targets: Array<{ node: object, declaration: object }>, platformVariants: string[] }}
 *   `reason` completes the sentence "`X` is imported from "specifier", …".
 */
function resolveImport(reference, context) {
  const specifier = reference.binding.module;
  if (!isLocalSpecifier(specifier)) return { status: "external" };
  if (!context.resolveModule) {
    return { status: "unavailable", reason: "which was not followed" };
  }
  const resolved = context.resolveModule(specifier);
  if (!resolved) {
    return { status: "missing", reason: "which does not resolve to a source file" };
  }
  const { record, platformVariants } = resolved;
  if (!record) return { status: "resolved", record: null, targets: [], platformVariants };
  if (reference.exported === "*") {
    return {
      status: "unresolved",
      record,
      reason: `and the whole module namespace of ${record.file} is used as the value`,
    };
  }
  const entry = record.facts.exports.get(reference.exported);
  if (!entry) {
    const reason =
      record.facts.starExports.length > 0
        ? `but ${record.file} does not export \`${reference.exported}\` directly (it may come through export * from ${record.facts.starExports.map((module) => `"${module}"`).join(", ")})`
        : `but ${record.file} does not export \`${reference.exported}\``;
    return { status: "unresolved", record, reason };
  }
  let targets;
  if (entry.kind === "reexport") {
    return {
      status: "reexport",
      record,
      binding: { module: entry.module, imported: entry.imported },
      platformVariants,
    };
  }
  if (entry.kind === "declaration") {
    targets = [{ declaration: entry.declaration, node: entry.node }];
  } else {
    const binding = importBindingFor(entry.local, record.facts);
    if (binding) {
      return {
        status: "reexport",
        record,
        binding: { module: binding.module, imported: binding.imported },
        platformVariants,
      };
    }
    targets = (record.facts.declarations.get(entry.local) ?? [])
      .map((declaration) => ({
        declaration,
        node: ts.isVariableDeclaration(declaration) ? (declaration.initializer ?? null) : declaration,
      }))
      .filter((target) => target.node);
    if (targets.length === 0) {
      return {
        status: "unresolved",
        record,
        reason: `but \`${entry.local}\` has no resolvable declaration in ${record.file}`,
      };
    }
  }
  for (const property of reference.properties) {
    targets = targets.flatMap((target) => propertyTargets(target, property));
  }
  return { status: "resolved", record, targets, platformVariants };
}

/**
 * Explains how `node` depends on the platform ("Platform.OS", "RN.Platform.select",
 * "process.env.EXPO_OS"), following same-file declarations transitively so that
 * `const isIOS = Platform.OS === "ios"` feeding `behavior={isIOS ? … : …}` is
 * still reported, and following an import from another Chat App file one hop
 * so that `behavior={useKeyboardBehavior()}` is traced into the hook. Returns
 * null when the value does not (provably) depend on the platform.
 */
function platformDependency(node, context, visited = new Set()) {
  if (!node) return null;
  const { sourceFile, platformNames, namespaceNames } = context;
  const platformLabel = (local, member) =>
    `${local}${member ? `.${member}` : ""}${local === "Platform" ? "" : " (Platform imported as " + local + ")"}`;

  const follow = (reference) => {
    if (visited.has(reference.key)) return null;
    visited.add(reference.key);
    for (const target of reference.targets) {
      const nested = platformDependency(target.node, context, visited);
      if (nested) {
        return `${nested} through ${reference.label} (declared on line ${lineIn(sourceFile, target.declaration)})`;
      }
    }
    return null;
  };

  const followImport = (reference) => {
    const key = visitKey(context, `import ${reference.label}`);
    if (visited.has(key)) return null;
    visited.add(key);
    const resolution = resolveImport(reference, context);
    if (resolution.status !== "resolved") return null;
    if (resolution.platformVariants.length > 0) {
      return `the platform-specific module files ${formatList(resolution.platformVariants)} through ${reference.label}`;
    }
    for (const target of resolution.targets) {
      const nested = platformDependency(target.node, resolution.record.context, visited);
      if (nested) {
        return (
          `${nested} through ${reference.label} (declared on line ` +
          `${lineIn(resolution.record.sourceFile, target.declaration)} of ${resolution.record.file})`
        );
      }
    }
    return null;
  };

  if (ts.isIdentifier(node)) {
    if (isDeclarationName(node)) return null;
    if (platformNames.has(node.text)) return platformLabel(node.text);
    const imported = importedReference(node, context);
    if (imported) return followImport(imported);
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
    const imported = importedReference(node, context);
    if (imported) return followImport(imported);
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
 * same same-file references and single import hop as `platformDependency`.
 * Platform names used by the switch itself ("ios", "android", …) are left out.
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
  if (ts.isIdentifier(node) && isDeclarationName(node)) return values;
  const imported = importedReference(node, context);
  if (imported) {
    const key = visitKey(context, `import ${imported.label}`);
    if (!visited.has(key)) {
      visited.add(key);
      const resolution = resolveImport(imported, context);
      if (resolution.status === "resolved") {
        for (const target of resolution.targets) {
          collectStringValues(target.node, resolution.record.context, values, visited);
        }
      }
    }
    return values;
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
 * Collects every import a behavior value can reach through same-file
 * references: the seeds of the import hop and of the "comes from another
 * file" rule. Type positions are skipped because a type annotation never
 * supplies a runtime value.
 */
function collectImportOrigins(node, context, origins = [], visited = new Set()) {
  if (!node || ts.isTypeNode(node)) return origins;
  if (ts.isIdentifier(node) && isDeclarationName(node)) return origins;
  const imported = importedReference(node, context);
  if (imported) {
    const key = visitKey(context, `import ${imported.label}`);
    if (!visited.has(key)) {
      visited.add(key);
      origins.push(imported);
    }
    return origins;
  }
  const reference = referenceTargets(node, context);
  if (reference) {
    if (!visited.has(reference.key)) {
      visited.add(reference.key);
      for (const target of reference.targets) {
        collectImportOrigins(target.node, context, origins, visited);
      }
    }
    return origins;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return collectImportOrigins(node.expression, context, origins, visited);
  }
  if (ts.isPropertyAssignment(node)) {
    return collectImportOrigins(node.initializer, context, origins, visited);
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    return collectImportOrigins(node.name, context, origins, visited);
  }
  ts.forEachChild(node, (child) => {
    collectImportOrigins(child, context, origins, visited);
  });
  return origins;
}

/**
 * Explains why a behavior value that reaches into another Chat App file
 * cannot be verified: the module or export cannot be resolved, or the value
 * sits a second import hop away. Returns null when every local import the
 * value touches resolves within one hop (package imports are never followed).
 */
function unresolvedImportExplanation(expression, context) {
  for (const reference of collectImportOrigins(expression, context)) {
    const specifier = reference.binding.module;
    const resolution = resolveImport(reference, context);
    switch (resolution.status) {
      case "external":
        break;
      case "unavailable":
      case "missing":
      case "unresolved":
        return `${reference.label} is imported from "${specifier}", ${resolution.reason}`;
      case "reexport":
        if (isLocalSpecifier(resolution.binding.module)) {
          return (
            `${reference.label} is imported from "${specifier}" (${resolution.record.file}), ` +
            `which imports it again from "${resolution.binding.module}"; the check follows one import hop`
          );
        }
        break;
      case "resolved":
        for (const target of resolution.targets) {
          for (const nested of collectImportOrigins(target.node, resolution.record.context)) {
            if (isLocalSpecifier(nested.binding.module)) {
              return (
                `${reference.label} is declared in ${resolution.record.file}, which imports ` +
                `${nested.label} from "${nested.binding.module}"; the check follows one import hop`
              );
            }
          }
        }
        break;
      default:
        break;
    }
  }
  return null;
}

/**
 * Returns true only when a behavior expression resolves to the single literal
 * "padding". This intentionally accepts same-file constants and plain object
 * properties, but rejects conditionals, calls, hooks, missing values, imports
 * and unresolved references: the keyboard strategy must be visible at the call
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

/**
 * True when `tagName` denotes a package export accepted by
 * `isTarget(packageName, exportName)`: directly (`import { X } from pkg`,
 * `pkg.X`), through a same-file alias (`const KAV = KC.X`), or through one
 * import hop into a Chat App module that re-exports or aliases it
 * (`export { X as Shell } from pkg`). Local modules never count as the
 * package, and a second local hop is not followed.
 */
function tagResolvesToExport(tagName, context, isTarget, visited = new Set()) {
  if (!tagName) return false;
  const reference = importedReference(tagName, context);
  if (reference) {
    if (!isLocalSpecifier(reference.binding.module)) {
      // `import RN from pkg; RN.X` reads the package like a namespace.
      const chain =
        reference.binding.imported === "default"
          ? reference.properties
          : [reference.exported, ...reference.properties];
      return chain.length === 1 && isTarget(reference.binding.module, chain[0]);
    }
    const resolution = resolveImport(reference, context);
    if (resolution.status === "reexport") {
      return (
        !isLocalSpecifier(resolution.binding.module) &&
        isTarget(resolution.binding.module, resolution.binding.imported)
      );
    }
    if (resolution.status === "resolved") {
      return resolution.targets.some((target) =>
        tagResolvesToExport(target.node, resolution.record.context, isTarget, visited),
      );
    }
    return false;
  }
  if (!ts.isIdentifier(tagName)) return false;
  const key = visitKey(context, tagName.text);
  if (visited.has(key)) return false;
  visited.add(key);
  return (context.facts.declarations.get(tagName.text) ?? []).some(
    (declaration) =>
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      tagResolvesToExport(declaration.initializer, context, isTarget, visited),
  );
}

/** `tagResolvesToExport` for one named export of one package. */
function tagResolvesToPackageExport(tagName, context, packageName, exportName, visited = new Set()) {
  return tagResolvesToExport(
    tagName,
    context,
    (module, name) => module === packageName && name === exportName,
    visited,
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
 * @param {{ file: string, source: string, packageRelativePath?: string, resolveModule?: ((specifier: string) => object | null) | null }} input
 *   `file` is the display name used in findings; `packageRelativePath` (POSIX,
 *   relative to the package root) decides the compat-component exemption and
 *   defaults to `file`. `resolveModule` (from createModuleLoader) lets values
 *   and tags imported from another Chat App file be followed one hop; without
 *   it such values are reported as coming from another file.
 * @returns {Array<{ file: string, rule: string, line: number, detail: string }>}
 */
export function scanKeyboardStrategySource({
  file,
  source,
  packageRelativePath = file,
  resolveModule = null,
}) {
  const sourceFile = parseSource(file, source);
  const facts = collectFacts(sourceFile);
  const context = createContext(sourceFile, facts, resolveModule);
  const findings = [];
  const report = (rule, node, detail) => {
    findings.push({ file, rule, line: lineIn(sourceFile, node), detail });
  };

  const isCompatComponent =
    packageRelativePath.split(path.sep).join("/") === COMPAT_COMPONENT_PATH;

  // Rule: KeyboardAvoidingView imported from "react-native".
  const reactNativeNamespaces = new Set(
    facts.namespaceImports
      .filter((entry) => entry.module === REACT_NATIVE)
      .map((entry) => entry.local),
  );
  let reportedReactNativeImport = false;
  for (const entry of facts.namedImports) {
    if (entry.module === REACT_NATIVE && entry.imported === "KeyboardAvoidingView") {
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
    if (entry.module === REACT_NATIVE && entry.exported === "KeyboardAvoidingView") {
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
  // A tag imported from another Chat App file that turns out to be React
  // Native's component under a different name (`export { KeyboardAvoidingView
  // as KeyboardShell } from "react-native"` in a shared module).
  for (const element of facts.jsxElements) {
    const reference = importedReference(element.tagName, context);
    if (!reference || !isLocalSpecifier(reference.binding.module)) continue;
    if (!tagResolvesToPackageExport(element.tagName, context, REACT_NATIVE, "KeyboardAvoidingView")) {
      continue;
    }
    report(
      "react-native-keyboard-avoiding-view",
      element.tagName,
      `renders <${element.tagName.getText(sourceFile)}>, which is KeyboardAvoidingView from "react-native" ` +
        `re-exported by "${reference.binding.module}"`,
    );
  }

  // Rule: a behavior prop chosen by platform, or taken from a file the check
  // cannot follow.
  for (const site of facts.behaviorSites) {
    const dependency = platformDependency(site.expression, context);
    // A `behavior` that can only ever be a non-keyboard value (a DOM
    // scrollTo({ behavior: "smooth" }) option, say) is not this rule's target.
    // Unknown values stay reported: a hook or helper may hide the switch.
    const values = collectStringValues(site.expression, context);
    const clearlyNotKeyboard =
      values.size > 0 && [...values].every((value) => !KEYBOARD_BEHAVIORS.has(value));
    if (clearlyNotKeyboard) continue;
    const subject = `the behavior ${site.kind === "jsx" ? "prop" : "property"}`;
    if (dependency) {
      report("platform-split-behavior", site.node, `${subject} depends on ${dependency}`);
      continue;
    }
    const explanation = unresolvedImportExplanation(site.expression, context);
    if (explanation) {
      report("behavior-from-another-file", site.node, `${subject} comes from another file (${explanation})`);
    }
  }

  // Rule: controller KeyboardAvoidingView must make the padding strategy
  // explicit. This is separate from the platform rule because a fixed
  // `height`, an omitted prop, or an opaque helper is still unsafe.
  for (const element of facts.jsxElements) {
    if (!tagResolvesToPackageExport(element.tagName, context, KEYBOARD_CONTROLLER, "KeyboardAvoidingView")) {
      continue;
    }
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
          context.namespaceNames.has(access.expression.text)
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

// --- Whole-tree rule: the root layout wraps the navigator in KeyboardProvider

/** JSX children that render something: elements, expressions and non-blank text. */
function isRenderedJsxChild(child) {
  return !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces);
}

/** Functions and methods: their `return` statements belong to them, not to the enclosing component. */
function isFunctionLikeValue(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * Follows the tree the root layout renders, starting at its default export,
 * and records every navigator element reached together with whether a
 * KeyboardProvider from react-native-keyboard-controller encloses it on that
 * path, plus every provider element seen.
 *
 * Only rendered code is followed. A component contributes the expressions it
 * returns (every `return` of its own body, a concise arrow body, a class's
 * `render` method); nested callbacks, effects, unused declarations and JSX
 * props are not rendered by the component and are not read. A rendered
 * expression contributes its JSX (children carry the provider flag; a
 * same-file component tag is followed into its declaration and a component
 * imported from another Chat App file is followed one hop — the loaded module
 * has no resolver, so its own imports are not followed), both branches of a
 * conditional, the operands of `&&`/`||`/`??`, array elements, the value of a
 * same-file variable (`{statusBar}`) and what a call in rendered position
 * returns (`{renderContent()}`, `useMemo(() => <Stack />, [])`). A component
 * that renders its `children` prop is not modelled: the navigator counts as
 * inside the provider only when the followed JSX nests it there.
 *
 * @returns {{
 *   entry: "followed" | "missing" | "reexport",
 *   entryModule?: string,
 *   navigators: Array<{ file: string, line: number, tag: string, insideProvider: boolean, path: string[] }>,
 *   providers: Array<{ file: string, line: number, hasChildren: boolean }>,
 * }}
 */
function traceRootLayout(facts, context, file) {
  const trace = { entry: "followed", navigators: [], providers: [] };
  const visited = new Set();
  const isProvider = (tagName, tagContext) =>
    tagResolvesToPackageExport(tagName, tagContext, KEYBOARD_CONTROLLER, "KeyboardProvider");

  // A frame says where the trace currently is: which file (and its context),
  // whether a provider element encloses this point, and the component path.

  /** `node` is a value used as a component: what it returns is rendered in `frame`. */
  const component = (node, frame) => {
    node = unwrapExpression(node);
    if (!node) return;
    if (isFunctionLikeValue(node)) {
      renderReturns(node, named(node, frame));
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const render = node.members.find(
        (member) => ts.isMethodDeclaration(member) && propertyNameText(member.name) === "render",
      );
      if (render) renderReturns(render, named(node, frame));
      return;
    }
    if (ts.isCallExpression(node)) {
      // `memo(RootLayout)`, `forwardRef(function …)`, `Sentry.wrap(RootLayout)`:
      // the wrapped arguments are the component.
      for (const argument of node.arguments) component(argument, frame);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      component(node.whenTrue, frame);
      component(node.whenFalse, frame);
      return;
    }
    if (ts.isBinaryExpression(node) && isEitherOperandOperator(node.operatorToken.kind)) {
      component(node.left, frame);
      component(node.right, frame);
      return;
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      followReference(node, frame, component);
      return;
    }
    // `export default <JSX />` is not a component, but it is what mounts.
    if (isJsxValue(node)) rendered(node, frame);
  };

  /** `node` is an expression whose value is rendered in `frame`. */
  const rendered = (node, frame) => {
    node = unwrapExpression(node);
    if (!node) return;
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      const providerHere = isProvider(opening.tagName, frame.context);
      if (providerHere) {
        trace.providers.push({
          file: frame.file,
          line: lineIn(frame.context.sourceFile, opening),
          hasChildren: node.children.some(isRenderedJsxChild),
        });
      }
      renderedTag(opening.tagName, opening, frame);
      // Props are the component's business, wherever it sits; only the
      // children are inside a provider element.
      const inner = providerHere ? { ...frame, insideProvider: true } : frame;
      for (const child of node.children) rendered(child, inner);
      return;
    }
    if (ts.isJsxSelfClosingElement(node)) {
      if (isProvider(node.tagName, frame.context)) {
        trace.providers.push({ file: frame.file, line: lineIn(frame.context.sourceFile, node), hasChildren: false });
      }
      renderedTag(node.tagName, node, frame);
      return;
    }
    if (ts.isJsxFragment(node)) {
      for (const child of node.children) rendered(child, frame);
      return;
    }
    if (ts.isJsxExpression(node)) {
      rendered(node.expression, frame);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      rendered(node.whenTrue, frame);
      rendered(node.whenFalse, frame);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.CommaToken) {
        rendered(node.right, frame);
      } else if (isEitherOperandOperator(operator)) {
        rendered(node.left, frame);
        rendered(node.right, frame);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        rendered(ts.isSpreadElement(element) ? element.expression : element, frame);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      // `{renderContent()}`, `(() => …)()`, `{items.map((item) => <Row />)}`,
      // `useMemo(() => <Stack />, [])`: what the call returns is rendered
      // here, so a same-file (or one-hop) callee is followed as a component
      // and the functions passed to it contribute what they return.
      const callee = unwrapExpression(node.expression);
      if (isFunctionLikeValue(callee)) renderReturns(callee, frame);
      else if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) followReference(callee, frame, component);
      for (const argument of node.arguments) {
        const value = unwrapExpression(argument);
        if (isFunctionLikeValue(value)) renderReturns(value, frame);
      }
      return;
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      // `{statusBar}`, `{content}`: a same-file variable's value (or a value
      // imported from another Chat App file) is rendered here.
      followReference(node, frame, rendered);
    }
    // Literals, `null`, templates, `new`, `await`, functions in rendered
    // position (render props) and anything else render nothing the check
    // can follow.
  };

  /** Renders every expression the function or method returns, skipping nested functions' returns. */
  const renderReturns = (fn, frame) => {
    if (!fn.body) return;
    if (!ts.isBlock(fn.body)) {
      rendered(fn.body, frame);
      return;
    }
    const collect = (node) => {
      if (ts.isReturnStatement(node)) {
        rendered(node.expression, frame);
        return;
      }
      if (isFunctionLikeValue(node) || ts.isClassLike(node)) return;
      ts.forEachChild(node, collect);
    };
    ts.forEachChild(fn.body, collect);
  };

  const renderedTag = (tagName, element, frame) => {
    if (tagResolvesToExport(tagName, frame.context, isRouterNavigatorExport)) {
      trace.navigators.push({
        file: frame.file,
        line: lineIn(frame.context.sourceFile, element),
        tag: tagName.getText(frame.context.sourceFile),
        insideProvider: frame.insideProvider,
        path: frame.path,
      });
      return;
    }
    followReference(tagName, frame, component);
  };

  /**
   * Resolves an identifier or property chain to what it names — same-file
   * declarations, or the export of another Chat App file one hop away — and
   * hands each target to `mode` (component or rendered) in that file.
   */
  const followReference = (node, frame, mode) => {
    const label = node.getText(frame.context.sourceFile);
    const imported = importedReference(node, frame.context);
    if (imported) {
      if (!isLocalSpecifier(imported.binding.module)) return;
      const key = `${visitKey(frame.context, `import ${label}`)}\u0000${mode.name}\u0000${frame.insideProvider}`;
      if (visited.has(key)) return;
      visited.add(key);
      const resolution = resolveImport(imported, frame.context);
      // A re-export chain, a missing module or export, or a whole namespace
      // is not followed; a navigator hidden there is reported as not found.
      if (resolution.status !== "resolved") return;
      const { record } = resolution;
      const next = {
        context: record.context,
        file: record.file,
        insideProvider: frame.insideProvider,
        path: [...frame.path, `${label} (${record.file})`],
      };
      for (const target of resolution.targets) mode(target.node, next);
      return;
    }
    const reference = referenceTargets(node, frame.context);
    if (!reference) return;
    const key = `${reference.key}\u0000${mode.name}\u0000${frame.insideProvider}`;
    if (visited.has(key)) return;
    visited.add(key);
    const next = { ...frame, path: [...frame.path, label] };
    for (const target of reference.targets) mode(target.node, next);
  };

  /** Adds a named function's or class's own name to the path unless the reference already did. */
  const named = (node, frame) => {
    const name = node.name && ts.isIdentifier(node.name) ? node.name.text : null;
    if (!name || frame.path[frame.path.length - 1] === name) return frame;
    return { ...frame, path: [...frame.path, name] };
  };

  const entry = facts.exports.get("default");
  if (!entry) {
    trace.entry = "missing";
    return trace;
  }
  if (entry.kind === "reexport") {
    trace.entry = "reexport";
    trace.entryModule = entry.module;
    return trace;
  }
  const root = { context, file, insideProvider: false, path: [] };
  if (entry.kind === "local") {
    // `export default function RootLayout` / `export { RootLayout as default }`:
    // the name is resolved like any reference (declared here or imported).
    const name = ts.isExportSpecifier(entry.node) ? (entry.node.propertyName ?? entry.node.name) : entry.node.name;
    if (name) followReference(name, root, component);
    return trace;
  }
  // `export default <expression>`: `RootLayout`, `memo(function …)`,
  // `sentryEnabled ? Sentry.wrap(RootLayout) : RootLayout`.
  component(entry.node, root);
  return trace;
}

/** `||` and `??` may render either operand. */
function isEitherOperandOperator(operator) {
  return operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken;
}

function isJsxValue(node) {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

/**
 * Turns a root-layout trace into findings: the default export could not be
 * followed, no navigator was reached, or a navigator sits outside the
 * provider. Findings without a line are file-level.
 */
function rootLayoutFindings(trace, file, facts) {
  const rule = "root-keyboard-provider";
  const finding = (line, detail) => ({ file, rule, line, detail });
  const navigatorList = formatList(ROUTER_NAVIGATOR_EXPORTS.map((name) => `<${name}>`), "or");
  const followed = "followed from the default export through same-file components and one import hop";
  if (trace.entry === "missing") {
    return [finding(null, `has no default export, so the tree it renders cannot be ${followed}`)];
  }
  if (trace.entry === "reexport") {
    return [
      finding(
        null,
        `re-exports its default export from "${trace.entryModule}", which the check does not follow; ` +
          "define the root layout component in this file",
      ),
    ];
  }
  if (trace.navigators.length === 0) {
    return [
      finding(
        null,
        `renders no navigator the check can see (${navigatorList} from "expo-router", ${followed})`,
      ),
    ];
  }
  const importsProvider =
    facts.namedImports.some((entry) => entry.module === KEYBOARD_CONTROLLER && entry.imported === "KeyboardProvider") ||
    facts.namespaceImports.some((entry) => entry.module === KEYBOARD_CONTROLLER) ||
    facts.reexports.some((entry) => entry.module === KEYBOARD_CONTROLLER && entry.exported === "KeyboardProvider");
  const providerStatus = () => {
    if (trace.providers.length === 0) {
      return importsProvider
        ? `KeyboardProvider is imported but not rendered on the way there`
        : `${file} does not import KeyboardProvider from "${KEYBOARD_CONTROLLER}"`;
    }
    const withChildren = trace.providers.filter((provider) => provider.hasChildren);
    const describe = (providers) =>
      formatList(
        providers.map((provider) =>
          provider.file === file ? `line ${provider.line}` : `line ${provider.line} of ${provider.file}`,
        ),
      );
    if (withChildren.length === 0) {
      return `the self-closing <KeyboardProvider /> on ${describe(trace.providers)} renders nothing inside it`;
    }
    return `the <KeyboardProvider> on ${describe(withChildren)} does not contain it`;
  };
  return trace.navigators
    .filter((navigator) => !navigator.insideProvider)
    .map((navigator) => {
      const where = navigator.file === file ? "" : ` in ${navigator.file}`;
      const through = navigator.path.length > 0 ? `reached through ${navigator.path.join(" › ")}; ` : "";
      return finding(
        navigator.file === file ? navigator.line : null,
        `renders <${navigator.tag}> from "expo-router"${where}${
          navigator.file === file ? "" : ` (line ${navigator.line})`
        } outside KeyboardProvider from "${KEYBOARD_CONTROLLER}" (${through}${providerStatus()})`,
      );
    });
}

/**
 * Checks that the root layout renders KeyboardProvider from
 * react-native-keyboard-controller around the navigator.
 *
 * @param {{ file: string, source: string | null, resolveModule?: ((specifier: string) => object | null) | null }} input
 *   `file` is the display name used in findings; `source` null means the
 *   root layout file does not exist. `resolveModule` (from createModuleLoader)
 *   lets components imported from another Chat App file be followed one hop.
 * @returns {Array<{ file: string, rule: string, line: number | null, detail: string }>}
 */
export function scanRootLayoutKeyboardProvider({ file, source, resolveModule = null }) {
  if (source === null) {
    return [
      {
        file,
        rule: "root-keyboard-provider",
        line: null,
        detail: "does not exist, so nothing renders KeyboardProvider around the navigator",
      },
    ];
  }
  const sourceFile = parseSource(file, source);
  const facts = collectFacts(sourceFile);
  const context = createContext(sourceFile, facts, resolveModule);
  return rootLayoutFindings(traceRootLayout(facts, context, file), file, facts);
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function displayPath(workspaceRoot, absoluteFile) {
  return path.relative(workspaceRoot, absoluteFile).split(path.sep).join("/");
}

/** Absolute path stem an import specifier names, or null for a package import. */
function specifierBase(specifier, fromAbsoluteFile, packageRoot) {
  if (specifier.startsWith(PACKAGE_ALIAS)) {
    return path.join(packageRoot, specifier.slice(PACKAGE_ALIAS.length));
  }
  if (isLocalSpecifier(specifier)) {
    return path.resolve(path.dirname(fromAbsoluteFile), specifier);
  }
  return null;
}

/**
 * Finds the file a module stem denotes (`stem.ts`, `stem/index.tsx`, …) and
 * any platform-specific siblings Metro would prefer on one platform.
 */
function locateModuleFiles(base) {
  const extension = path.extname(base);
  const stem = SOURCE_EXTENSIONS.has(extension) ? base.slice(0, -extension.length) : base;
  for (const candidate of [stem, path.join(stem, "index")]) {
    let file = null;
    const platformVariants = [];
    for (const resolvedExtension of RESOLVED_EXTENSIONS) {
      if (!file && isFile(`${candidate}${resolvedExtension}`)) file = `${candidate}${resolvedExtension}`;
      for (const platform of PLATFORM_FILE_SUFFIXES) {
        const variant = `${candidate}.${platform}${resolvedExtension}`;
        if (isFile(variant)) platformVariants.push(variant);
      }
    }
    if (file || platformVariants.length > 0) return { file, platformVariants };
  }
  return { file: null, platformVariants: [] };
}

/**
 * Loads the Chat App modules that behavior values and JSX tags are followed
 * into. Each module is parsed once; its context has no resolver of its own,
 * which is what limits the analysis to a single import hop.
 *
 * @param {{ packageRoot: string, workspaceRoot?: string }} options
 * @returns {{ resolverFor: (absoluteFile: string) => (specifier: string) => ({ record: object | null, platformVariants: string[] } | null) }}
 */
export function createModuleLoader({ packageRoot, workspaceRoot = path.resolve(packageRoot, "../..") }) {
  const records = new Map();
  const load = (absoluteFile) => {
    let record = records.get(absoluteFile);
    if (!record) {
      const file = displayPath(workspaceRoot, absoluteFile);
      const sourceFile = parseSource(file, readFileSync(absoluteFile, "utf8"));
      const facts = collectFacts(sourceFile);
      record = { file, absoluteFile, sourceFile, facts, context: createContext(sourceFile, facts, null) };
      records.set(absoluteFile, record);
    }
    return record;
  };
  const resolve = (specifier, fromAbsoluteFile) => {
    const base = specifierBase(specifier, fromAbsoluteFile, packageRoot);
    if (!base) return null;
    const { file, platformVariants } = locateModuleFiles(base);
    if (!file && platformVariants.length === 0) return null;
    return {
      record: file ? load(file) : null,
      platformVariants: platformVariants.map((variant) => displayPath(workspaceRoot, variant)),
    };
  };
  return {
    resolverFor: (absoluteFile) => (specifier) => resolve(specifier, absoluteFile),
  };
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
 * Locates the root layout and runs the KeyboardProvider rule on it. Metro
 * would prefer a platform-specific `_layout.<platform>.tsx` on that platform,
 * so such variants are a finding: the check reads one root layout.
 */
function scanRootLayout({ packageRoot, workspaceRoot, loader }) {
  const { file, platformVariants } = locateModuleFiles(path.join(packageRoot, ROOT_LAYOUT_PATH));
  const rootLayoutFile = displayPath(workspaceRoot, file ?? path.join(packageRoot, ROOT_LAYOUT_PATH));
  const findings = [];
  if (platformVariants.length > 0) {
    findings.push({
      file: rootLayoutFile,
      rule: "root-keyboard-provider",
      line: null,
      detail:
        `has platform-specific variants (${formatList(platformVariants.map((variant) => displayPath(workspaceRoot, variant)))}) ` +
        "that the check does not follow; keep a single root layout",
    });
  }
  findings.push(
    ...scanRootLayoutKeyboardProvider({
      file: rootLayoutFile,
      source: file ? readFileSync(file, "utf8") : null,
      resolveModule: file ? loader.resolverFor(file) : null,
    }),
  );
  return { rootLayoutFile, findings };
}

/**
 * Enumerates the top-level directories the scan reads: every directory of the
 * package root except the non-source ones and dot-directories, plus the
 * required directories whatever the exclusions say. A folder added later is
 * therefore scanned without editing a list, and only a name on the
 * non-source list can keep one out. Throws when a required directory is
 * missing.
 *
 * @param {{ packageRoot: string, workspaceRoot?: string, excludedDirectories?: string[], requiredDirectories?: string[] }} options
 * @returns {{ scanned: string[], skipped: string[] }} names sorted by name;
 *   `skipped` lists the existing top-level directories the scan left out.
 */
export function listSourceDirectories({
  packageRoot,
  workspaceRoot = path.resolve(packageRoot, "../.."),
  excludedDirectories = NON_SOURCE_DIRECTORIES,
  requiredDirectories = REQUIRED_DIRECTORIES,
}) {
  for (const directory of requiredDirectories) {
    const absoluteDirectory = path.join(packageRoot, directory);
    if (!isDirectory(absoluteDirectory)) {
      throw new Error(
        `Keyboard strategy check: expected directory ${displayPath(workspaceRoot, absoluteDirectory)} ` +
          "does not exist. Update REQUIRED_DIRECTORIES in scripts/validate-keyboard-strategy.mjs if the Chat App source moved.",
      );
    }
  }
  const excluded = new Set(excludedDirectories);
  const scanned = [];
  const skipped = [];
  for (const name of readdirSync(packageRoot).sort((a, b) => a.localeCompare(b))) {
    if (!isDirectory(path.join(packageRoot, name))) continue;
    if (requiredDirectories.includes(name) || (!excluded.has(name) && !name.startsWith("."))) {
      scanned.push(name);
    } else {
      skipped.push(name);
    }
  }
  return { scanned, skipped };
}

/**
 * Scans every top-level source directory of the package (see
 * listSourceDirectories), then checks that the root layout wraps the
 * navigator in KeyboardProvider.
 *
 * @param {{ packageRoot?: string, workspaceRoot?: string, excludedDirectories?: string[], requiredDirectories?: string[] }} options
 *   Findings name files relative to `workspaceRoot` (defaults to two levels
 *   above the package root, i.e. `artifacts/chat-app/app/...`). Directories
 *   named in `excludedDirectories` (default NON_SOURCE_DIRECTORIES) and
 *   dot-directories are skipped; those in `requiredDirectories` must exist.
 * @returns {{ findings: Array<{ file: string, rule: string, line: number | null, detail: string }>, scannedFiles: string[], scannedDirectories: string[], skippedDirectories: string[], packagePath: string, rootLayoutFile: string }}
 *   `line` is null for a file-level finding (the root layout is missing, has
 *   no default export, …). `packagePath` is the package root relative to
 *   `workspaceRoot` ("" when they coincide).
 */
export function scanKeyboardStrategy({
  packageRoot = defaultPackageRoot(),
  workspaceRoot = path.resolve(packageRoot, "../.."),
  excludedDirectories = NON_SOURCE_DIRECTORIES,
  requiredDirectories = REQUIRED_DIRECTORIES,
} = {}) {
  const findings = [];
  const scannedFiles = [];
  const { scanned: scannedDirectories, skipped: skippedDirectories } = listSourceDirectories({
    packageRoot,
    workspaceRoot,
    excludedDirectories,
    requiredDirectories,
  });
  const loader = createModuleLoader({ packageRoot, workspaceRoot });
  for (const directory of scannedDirectories) {
    const absoluteDirectory = path.join(packageRoot, directory);
    for (const absoluteFile of listSourceFiles(absoluteDirectory)) {
      const file = displayPath(workspaceRoot, absoluteFile);
      const packageRelativePath = displayPath(packageRoot, absoluteFile);
      scannedFiles.push(file);
      findings.push(
        ...scanKeyboardStrategySource({
          file,
          source: readFileSync(absoluteFile, "utf8"),
          packageRelativePath,
          resolveModule: loader.resolverFor(absoluteFile),
        }),
      );
    }
  }
  if (scannedFiles.length === 0) {
    throw new Error(
      `Keyboard strategy check: no source files found under ${scannedDirectories.join(", ")}; refusing to pass an empty scan.`,
    );
  }
  const rootLayout = scanRootLayout({ packageRoot, workspaceRoot, loader });
  findings.push(...rootLayout.findings);
  return {
    findings,
    scannedFiles,
    scannedDirectories,
    skippedDirectories,
    packagePath: displayPath(workspaceRoot, packageRoot),
    rootLayoutFile: rootLayout.rootLayoutFile,
  };
}

/**
 * One sentence saying what a passing scan covered: the directories read, the
 * fact that they are every top-level directory of the package minus the
 * skipped non-source ones, and the root layout the whole-tree rule checked.
 */
export function formatKeyboardStrategyPass({
  scannedFiles,
  scannedDirectories,
  skippedDirectories,
  packagePath,
  rootLayoutFile,
}) {
  const count = scannedFiles.length;
  const asDirectories = (names) => formatList(names.map((name) => `${name}/`));
  const where = packagePath ? `of ${packagePath}` : "of the package";
  const scope =
    skippedDirectories.length > 0
      ? `every top-level directory ${where} except the non-source ${asDirectories(skippedDirectories)}`
      : `every top-level directory ${where}`;
  return (
    `Keyboard strategy check passed: ${count} source file${count === 1 ? "" : "s"} under ` +
    `${asDirectories(scannedDirectories)} (${scope}) follow${count === 1 ? "s" : ""} ` +
    `${KEYBOARD_STRATEGY_NOTE}, and ${rootLayoutFile} wraps the navigator in KeyboardProvider.`
  );
}

/** Formats findings as the failure message: file, line, rule, what was found, and the fix. */
export function formatKeyboardStrategyFailure(findings) {
  const lines = [
    `Keyboard strategy violation${findings.length === 1 ? "" : "s"} in the Chat App ` +
      `(${KEYBOARD_STRATEGY_SUMMARY}; see ${KEYBOARD_STRATEGY_NOTE}):`,
  ];
  for (const finding of findings) {
    const rule = KEYBOARD_STRATEGY_RULES[finding.rule];
    const location = finding.line === null || finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
    lines.push(`  - ${location} [${finding.rule}] ${finding.detail}. Fix: ${rule.fix}.`);
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
  const result = scanKeyboardStrategy(options);
  if (result.findings.length > 0) {
    console.error(formatKeyboardStrategyFailure(result.findings));
    process.exitCode = 1;
    return;
  }
  console.log(formatKeyboardStrategyPass(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
