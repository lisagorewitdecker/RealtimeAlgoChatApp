import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  COMPAT_COMPONENT_PATH,
  KEYBOARD_STRATEGY_RULES,
  NON_SOURCE_DIRECTORIES,
  REQUIRED_DIRECTORIES,
  ROOT_LAYOUT_PATH,
  ROUTER_NAVIGATOR_EXPORTS,
  assertKeyboardStrategy,
  createModuleLoader,
  formatKeyboardStrategyFailure,
  formatKeyboardStrategyPass,
  listSourceDirectories,
  scanKeyboardStrategy,
  scanKeyboardStrategySource,
  scanRootLayoutKeyboardProvider,
} from "./validate-keyboard-strategy.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(packageRoot, "scripts/validate-keyboard-strategy.mjs");

function scan(file, source) {
  return scanKeyboardStrategySource({ file, source, packageRelativePath: file });
}

function rulesOf(findings) {
  return findings.map((finding) => finding.rule);
}

/** A root layout that satisfies the whole-tree rule: the navigator sits inside KeyboardProvider. */
const compliantRootLayout = `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";

export default function RootLayout() {
  return (
    <KeyboardProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </KeyboardProvider>
  );
}
`;

/**
 * Writes a throwaway package root with the given `{ relativePath: source }`
 * files. The required directories (app/, components/) always exist; any other
 * directory exists only when a fixture file lives in it, which is how a real
 * tree grows a new folder. A compliant root layout is included unless `files`
 * supplies one, so fixtures for the per-file rules are not tripped by the
 * whole-tree rule.
 */
async function writeFixtureRoot(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "keyboard-strategy-"));
  for (const directory of REQUIRED_DIRECTORIES) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const [relativePath, source] of Object.entries({ [ROOT_LAYOUT_PATH]: compliantRootLayout, ...files })) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, source);
  }
  return root;
}

const compliantScreen = `import { Platform, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

const styles = StyleSheet.create({ root: { paddingTop: Platform.OS === "ios" ? 0 : 8 } });

export default function Screen() {
  return (
    <KeyboardAvoidingView style={styles.root} behavior="padding" keyboardVerticalOffset={0}>
      <View />
    </KeyboardAvoidingView>
  );
}
`;

test("the Chat App's source trees follow the keyboard strategy", () => {
  const { findings, scannedFiles, scannedDirectories, skippedDirectories, packagePath, rootLayoutFile } =
    scanKeyboardStrategy({ packageRoot });

  assert.deepEqual(findings, [], formatKeyboardStrategyFailure(findings));
  assert.equal(packagePath, "artifacts/chat-app");
  // The whole-tree rule read the real root layout, not a fallback path.
  assert.equal(rootLayoutFile, `artifacts/chat-app/${ROOT_LAYOUT_PATH}`);
  // The non-source list is pinned: a change to it is a change to the check's
  // scope and belongs in the replit.md note as well.
  assert.deepEqual(REQUIRED_DIRECTORIES, ["app", "components"]);
  assert.deepEqual(NON_SOURCE_DIRECTORIES, [
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
  ]);
  // Every top-level directory of the real package is either scanned or on the
  // non-source list (or a dot-directory); nothing falls through unnoticed.
  const topLevel = readdirSync(packageRoot).filter((name) => statSync(path.join(packageRoot, name)).isDirectory());
  const expectedScanned = topLevel
    .filter((name) => !NON_SOURCE_DIRECTORIES.includes(name) && !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(scannedDirectories, expectedScanned);
  assert.deepEqual([...scannedDirectories, ...skippedDirectories].sort(), [...topLevel].sort());
  // The shared-module homes are all present in the real tree, so a helper
  // moved into any of them is read at module level.
  for (const home of ["app", "components", "constants", "contexts", "hooks", "lib", "utils"]) {
    assert.ok(scannedDirectories.includes(home), `expected ${home}/ to be scanned`);
  }
  for (const skipped of ["__tests__", "assets", "scripts", "test-utils"]) {
    assert.ok(skippedDirectories.includes(skipped), `expected ${skipped}/ to be skipped`);
    assert.ok(!scannedDirectories.includes(skipped), `expected ${skipped}/ not to be scanned`);
  }
  // Guard against an empty or mis-rooted scan passing silently: the known
  // keyboard call sites, the compat component and one module from each
  // shared-module home must have been read, and nothing from the test tree.
  for (const expected of [
    "artifacts/chat-app/app/room/[roomId].tsx",
    "artifacts/chat-app/app/(tabs)/profile.tsx",
    "artifacts/chat-app/app/(auth)/forgot-password.tsx",
    "artifacts/chat-app/components/AiPanel.tsx",
    `artifacts/chat-app/${COMPAT_COMPONENT_PATH}`,
    "artifacts/chat-app/constants/colors.ts",
    "artifacts/chat-app/hooks/useColors.ts",
    "artifacts/chat-app/lib/sentry.ts",
    "artifacts/chat-app/contexts/AppContext.tsx",
    "artifacts/chat-app/utils/analytics.ts",
  ]) {
    assert.ok(scannedFiles.includes(expected), `expected ${expected} to be scanned`);
  }
  for (const excluded of ["__tests__/", "test-utils/", "scripts/", "assets/", "node_modules/"]) {
    const stray = scannedFiles.filter((file) => file.startsWith(`artifacts/chat-app/${excluded}`));
    assert.deepEqual(stray, [], `expected nothing under ${excluded} to be scanned`);
  }
});

test("the current correct usages pass the source rules", () => {
  assert.deepEqual(scan("app/screen.tsx", compliantScreen), []);
  assert.deepEqual(
    scan(
      "app/form.tsx",
      `import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
export default () => <KeyboardAwareScrollViewCompat contentContainerStyle={{ padding: 16 }} />;`,
    ),
    [],
  );
  assert.deepEqual(
    scan(
      "app/layout.tsx",
      `import { KeyboardProvider } from "react-native-keyboard-controller";
import { KeyboardAvoidingViewProps } from "react-native";
export default () => <KeyboardProvider />;`,
    ),
    [],
  );
});

test("flags KeyboardAvoidingView imported from react-native in every import form", () => {
  const forms = {
    named: 'import { View, KeyboardAvoidingView } from "react-native";',
    aliased: 'import { KeyboardAvoidingView as KAV } from "react-native";',
    typeOnly: 'import type { KeyboardAvoidingView } from "react-native";',
    namespace: 'import * as RN from "react-native";\nconst view = <RN.KeyboardAvoidingView behavior="padding" />;',
    defaultImport: 'import RN from "react-native";\nconst View = RN.KeyboardAvoidingView;',
    required: 'const { KeyboardAvoidingView } = require("react-native");',
    reexport: 'export { KeyboardAvoidingView } from "react-native";',
  };
  for (const [name, source] of Object.entries(forms)) {
    const findings = scan("app/screen.tsx", source);
    assert.deepEqual(rulesOf(findings), ["react-native-keyboard-avoiding-view"], `${name} form`);
    assert.match(findings[0].detail, /KeyboardAvoidingView/);
  }
  // A namespace import reports the use site, not the import line.
  assert.equal(scan("app/screen.tsx", forms.namespace)[0].line, 2);
});

test("does not flag KeyboardAvoidingView from react-native-keyboard-controller", () => {
  assert.deepEqual(
    scan(
      "app/screen.tsx",
      `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import * as RN from "react-native";
const Other = RN.View;`,
    ),
    [],
  );
});

test("requires controller KeyboardAvoidingView to use explicit statically provable padding", () => {
  const invalidForms = {
    fixedHeight: `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
const view = <KeyboardAvoidingView behavior="height" />;`,
    fixedPosition: `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
const view = <KeyboardAvoidingView behavior="position" />;`,
    omitted: `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
const view = <KeyboardAvoidingView />;`,
    dynamic: `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
const behavior = getKeyboardBehavior();
const view = <KeyboardAvoidingView behavior={behavior} />;`,
    aliased: `import { KeyboardAvoidingView as KAV } from "react-native-keyboard-controller";
const view = <KAV behavior="height" />;`,
    namespace: `import * as KC from "react-native-keyboard-controller";
const view = <KC.KeyboardAvoidingView behavior="height" />;`,
    namespaceAlias: `import * as KC from "react-native-keyboard-controller";
const KAV = KC.KeyboardAvoidingView;
const view = <KAV behavior="height" />;`,
  };
  for (const [name, source] of Object.entries(invalidForms)) {
    const findings = scan("app/screen.tsx", source);
    assert.ok(
      rulesOf(findings).includes("keyboard-avoiding-view-behavior"),
      `${name} form should require explicit padding: ${JSON.stringify(findings)}`,
    );
  }

  const validForms = [
    `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
const view = <KeyboardAvoidingView behavior="padding" />;`,
    `import { KeyboardAvoidingView as KAV } from "react-native-keyboard-controller";
const PADDING = "padding";
const view = <KAV behavior={PADDING} />;`,
    `import * as KC from "react-native-keyboard-controller";
const props = { behavior: "padding" };
const view = <KC.KeyboardAvoidingView behavior={props.behavior} />;`,
    `import * as KC from "react-native-keyboard-controller";
const KAV = KC.KeyboardAvoidingView;
const view = <KAV behavior={"padding"} />;`,
  ];
  for (const source of validForms) {
    assert.deepEqual(scan("app/screen.tsx", source), [], source);
  }
});

test("flags a behavior prop chosen by the platform, however it is written", () => {
  const forms = {
    ternary: `import { Platform } from "react-native";
const view = <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} />;`,
    undefinedOnAndroid: `import { Platform } from "react-native";
const view = <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} />;`,
    select: `import { Platform } from "react-native";
const view = <KeyboardAvoidingView behavior={Platform.select({ ios: "padding", android: "height" })} />;`,
    aliasedPlatform: `import { Platform as P } from "react-native";
const view = <KeyboardAvoidingView behavior={P.OS === "ios" ? "padding" : "height"} />;`,
    namespacePlatform: `import * as RN from "react-native";
const view = <KeyboardAvoidingView behavior={RN.Platform.OS === "ios" ? "padding" : "height"} />;`,
    expoOs: `const view = <KeyboardAvoidingView behavior={process.env.EXPO_OS === "ios" ? "padding" : "height"} />;`,
    viaBoolean: `import { Platform } from "react-native";
const isIOS = Platform.OS === "ios";
const view = <KeyboardAvoidingView behavior={isIOS ? "padding" : "height"} />;`,
    viaVariable: `import { Platform } from "react-native";
const behavior = Platform.OS === "ios" ? "padding" : "height";
const view = <KeyboardAvoidingView behavior={behavior} />;`,
    viaFunction: `import { Platform } from "react-native";
function pickBehavior() { return Platform.OS === "ios" ? "padding" : "height"; }
const view = <KeyboardAvoidingView behavior={pickBehavior()} />;`,
    viaConstants: `import { Platform } from "react-native";
const PADDING = "padding";
const HEIGHT = "height";
const view = <KeyboardAvoidingView behavior={Platform.OS === "ios" ? PADDING : HEIGHT} />;`,
    objectProperty: `import { Platform } from "react-native";
const keyboardProps = { behavior: Platform.OS === "ios" ? "padding" : "height" };
const view = <KeyboardAvoidingView {...keyboardProps} />;`,
    shorthandProperty: `import { Platform } from "react-native";
const behavior = Platform.select({ ios: "padding", default: "height" });
const keyboardProps = { behavior };`,
    memberOfObject: `import { Platform } from "react-native";
const config = { behavior: Platform.OS === "ios" ? "padding" : "height" };
const view = <KeyboardAvoidingView behavior={config.behavior} />;`,
  };
  for (const [name, source] of Object.entries(forms)) {
    const findings = scan("app/screen.tsx", source);
    assert.ok(findings.length > 0, `${name} form should be reported`);
    assert.ok(
      findings.every((finding) => finding.rule === "platform-split-behavior"),
      `${name} form: ${JSON.stringify(findings)}`,
    );
  }

  const viaBoolean = scan("app/screen.tsx", forms.viaBoolean);
  assert.equal(viaBoolean[0].line, 3);
  assert.equal(
    viaBoolean[0].detail,
    "the behavior prop depends on Platform.OS through `isIOS` (declared on line 2)",
  );
  assert.equal(scan("app/screen.tsx", forms.expoOs)[0].detail, "the behavior prop depends on process.env.EXPO_OS");
  assert.match(scan("app/screen.tsx", forms.aliasedPlatform)[0].detail, /P\.OS \(Platform imported as P\)/);
  assert.match(scan("app/screen.tsx", forms.namespacePlatform)[0].detail, /RN\.Platform\.OS/);
});

test("accepts a fixed behavior even when the file switches on Platform elsewhere", () => {
  const sources = [
    compliantScreen,
    `import { Platform } from "react-native";
const config = { behavior: "padding", keyboardVerticalOffset: Platform.OS === "ios" ? 0 : 24 };
const view = <KeyboardAvoidingView behavior={config.behavior} keyboardVerticalOffset={config.keyboardVerticalOffset} />;`,
    'const view = <KeyboardAvoidingView behavior={"padding"} />;',
    // DOM scrolling options share the prop name but never a keyboard value.
    `import { Platform } from "react-native";
const smooth = Platform.OS === "web" ? "smooth" : "auto";
window.scrollTo({ top: 0, behavior: smooth });
element.scrollIntoView({ behavior: Platform.OS === "web" ? "smooth" : "instant" });`,
  ];
  for (const source of sources) {
    assert.deepEqual(scan("app/screen.tsx", source), [], source);
  }
});

// --- Behavior values and tags that live in another Chat App file -----------

const platformHook = `import { Platform } from "react-native";

export function useKeyboardBehavior() {
  return Platform.OS === "ios" ? "padding" : "height";
}
`;

function scanFixture(files) {
  return writeFixtureRoot(files).then((root) => ({
    root,
    ...scanKeyboardStrategy({ packageRoot: root, workspaceRoot: root }),
  }));
}

function cleanup(t, roots) {
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
}

test("follows a behavior value one import hop into a hook that switches on the platform", async (t) => {
  const screen = (importLine, expression = "useKeyboardBehavior()") =>
    `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
${importLine}
export default () => <KeyboardAvoidingView behavior={${expression}} />;`;
  const forms = {
    aliasImport: {
      files: {
        "hooks/useKeyboardBehavior.ts": platformHook,
        "app/screen.tsx": screen('import { useKeyboardBehavior } from "@/hooks/useKeyboardBehavior";'),
      },
      detail:
        "the behavior prop depends on Platform.OS through `useKeyboardBehavior` (declared on line 3 of hooks/useKeyboardBehavior.ts)",
    },
    relativeImport: {
      files: {
        "hooks/useKeyboardBehavior.ts": platformHook,
        "app/screen.tsx": screen('import { useKeyboardBehavior } from "../hooks/useKeyboardBehavior";'),
      },
      detail:
        "the behavior prop depends on Platform.OS through `useKeyboardBehavior` (declared on line 3 of hooks/useKeyboardBehavior.ts)",
    },
    renamedImport: {
      files: {
        "hooks/useKeyboardBehavior.ts": platformHook,
        "app/screen.tsx": screen(
          'import { useKeyboardBehavior as useBehavior } from "@/hooks/useKeyboardBehavior";',
          "useBehavior()",
        ),
      },
      detail:
        "the behavior prop depends on Platform.OS through `useBehavior` (declared on line 3 of hooks/useKeyboardBehavior.ts)",
    },
    namespaceImport: {
      files: {
        "hooks/useKeyboardBehavior.ts": platformHook,
        "app/screen.tsx": screen(
          'import * as keyboard from "@/hooks/useKeyboardBehavior";',
          "keyboard.useKeyboardBehavior()",
        ),
      },
      detail:
        "the behavior prop depends on Platform.OS through `keyboard.useKeyboardBehavior` (declared on line 3 of hooks/useKeyboardBehavior.ts)",
    },
    defaultExport: {
      files: {
        "hooks/useKeyboardBehavior.ts": `import { Platform } from "react-native";
export default function useKeyboardBehavior() {
  return Platform.select({ ios: "padding", android: "height" });
}`,
        "app/screen.tsx": screen('import useKeyboardBehavior from "@/hooks/useKeyboardBehavior";'),
      },
      detail:
        "the behavior prop depends on Platform.select through `useKeyboardBehavior` (declared on line 2 of hooks/useKeyboardBehavior.ts)",
    },
    viaLocalVariable: {
      files: {
        "hooks/useKeyboardBehavior.ts": platformHook,
        "app/screen.tsx": `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useKeyboardBehavior } from "@/hooks/useKeyboardBehavior";
export default function Screen() {
  const behavior = useKeyboardBehavior();
  return <KeyboardAvoidingView behavior={behavior} />;
}`,
      },
      detail:
        "the behavior prop depends on Platform.OS through `useKeyboardBehavior` (declared on line 3 of hooks/useKeyboardBehavior.ts) through `behavior` (declared on line 4)",
    },
    exportedProperty: {
      files: {
        "utils/keyboard.ts": `import { Platform } from "react-native";
export const keyboardProps = { behavior: Platform.OS === "ios" ? "padding" : "height" };`,
        "app/screen.tsx": screen('import { keyboardProps } from "@/utils/keyboard";', "keyboardProps.behavior"),
      },
      detail:
        "the behavior prop depends on Platform.OS through `keyboardProps.behavior` (declared on line 2 of utils/keyboard.ts)",
    },
    contextHelper: {
      files: {
        "contexts/KeyboardContext.tsx": `import { Platform } from "react-native";
const isIOS = Platform.OS === "ios";
export const pickBehavior = () => (isIOS ? "padding" : "height");`,
        "app/screen.tsx": screen('import { pickBehavior } from "@/contexts/KeyboardContext";', "pickBehavior()"),
      },
      detail:
        "the behavior prop depends on Platform.OS through `isIOS` (declared on line 2) through `pickBehavior` (declared on line 3 of contexts/KeyboardContext.tsx)",
    },
  };
  const roots = [];
  for (const [name, { files, detail }] of Object.entries(forms)) {
    const { root, findings } = await scanFixture(files);
    roots.push(root);
    const split = findings.filter((finding) => finding.rule === "platform-split-behavior");
    const callSite = split.find((finding) => finding.file === "app/screen.tsx");
    assert.ok(callSite, `${name}: the call site should be reported: ${JSON.stringify(findings)}`);
    assert.equal(callSite.detail, detail, name);
    // The hook hides the switch, so the controller component's own rule fires too.
    assert.ok(
      findings.some((finding) => finding.rule === "keyboard-avoiding-view-behavior" && finding.file === "app/screen.tsx"),
      `${name}: the call site should also miss the explicit padding: ${JSON.stringify(findings)}`,
    );
    assert.ok(
      findings.every((finding) => ["platform-split-behavior", "keyboard-avoiding-view-behavior"].includes(finding.rule)),
      `${name}: ${JSON.stringify(findings)}`,
    );
  }
  cleanup(t, roots);

  // The shared module is scanned in its own right: a `behavior` property that
  // switches on the platform is a finding there even before it is consumed.
  const { root, findings } = await scanFixture({
    "utils/keyboard.ts": forms.exportedProperty.files["utils/keyboard.ts"],
    "app/screen.tsx": compliantScreen,
  });
  cleanup(t, [root]);
  assert.deepEqual(findings, [
    {
      file: "utils/keyboard.ts",
      rule: "platform-split-behavior",
      line: 2,
      detail: "the behavior property depends on Platform.OS",
    },
  ]);
});

test("a fixed value resolved one hop away is not mistaken for a platform split", async (t) => {
  const { root, findings } = await scanFixture({
    "lib/keyboard.ts": `import { Platform } from "react-native";
export const KEYBOARD_BEHAVIOR = "padding";
export const keyboardProps = { behavior: "padding", keyboardVerticalOffset: Platform.OS === "ios" ? 0 : 24 };
export const scrollOptions = { behavior: Platform.OS === "web" ? "smooth" : "instant" };`,
    "components/Shell.tsx": `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { KEYBOARD_BEHAVIOR, keyboardProps, scrollOptions } from "@/lib/keyboard";
export const A = () => <KeyboardAvoidingView behavior={KEYBOARD_BEHAVIOR} />;
export const B = () => <KeyboardAvoidingView behavior={keyboardProps.behavior} keyboardVerticalOffset={keyboardProps.keyboardVerticalOffset} />;
export const scroll = (element) => element.scrollIntoView({ behavior: scrollOptions.behavior });`,
    "components/Wrapper.tsx": `import { KEYBOARD_BEHAVIOR } from "@/lib/keyboard";
export const Wrapper = (props) => <Shell behavior={KEYBOARD_BEHAVIOR} {...props} />;`,
  });
  cleanup(t, [root]);

  // Neither the platform rule nor the "another file" rule fires, but the
  // controller component still wants the literal at its own call site.
  assert.deepEqual(
    findings.map(({ file, rule, line }) => ({ file, rule, line })),
    [
      { file: "components/Shell.tsx", rule: "keyboard-avoiding-view-behavior", line: 3 },
      { file: "components/Shell.tsx", rule: "keyboard-avoiding-view-behavior", line: 4 },
    ],
  );
});

test("reports a behavior value the check cannot follow instead of accepting it", async (t) => {
  const bareScreen = (importLine, expression = "useKeyboardBehavior()") =>
    `${importLine}
export default () => <KeyboardAvoidingView behavior={${expression}} />;`;
  const forms = {
    secondHop: {
      files: {
        "lib/keyboard.ts": platformHook.replace("useKeyboardBehavior", "pickBehavior"),
        "hooks/useKeyboardBehavior.ts": `import { pickBehavior } from "@/lib/keyboard";
export function useKeyboardBehavior() {
  return pickBehavior();
}`,
        "app/screen.tsx": bareScreen('import { useKeyboardBehavior } from "@/hooks/useKeyboardBehavior";'),
      },
      detail:
        "the behavior prop comes from another file (`useKeyboardBehavior` is declared in hooks/useKeyboardBehavior.ts, which imports `pickBehavior` from \"@/lib/keyboard\"; the check follows one import hop)",
    },
    reexportChain: {
      files: {
        "hooks/useKeyboardBehavior.ts": platformHook,
        "hooks/index.ts": 'export { useKeyboardBehavior } from "./useKeyboardBehavior";',
        "app/screen.tsx": bareScreen('import { useKeyboardBehavior } from "@/hooks";'),
      },
      detail:
        "the behavior prop comes from another file (`useKeyboardBehavior` is imported from \"@/hooks\" (hooks/index.ts), which imports it again from \"./useKeyboardBehavior\"; the check follows one import hop)",
    },
    importThenExport: {
      files: {
        "hooks/useKeyboardBehavior.ts": platformHook,
        "hooks/index.ts": `import { useKeyboardBehavior } from "./useKeyboardBehavior";
export { useKeyboardBehavior };`,
        "app/screen.tsx": bareScreen('import { useKeyboardBehavior } from "@/hooks";'),
      },
      detail:
        "the behavior prop comes from another file (`useKeyboardBehavior` is imported from \"@/hooks\" (hooks/index.ts), which imports it again from \"./useKeyboardBehavior\"; the check follows one import hop)",
    },
    starExport: {
      files: {
        "hooks/useKeyboardBehavior.ts": platformHook,
        "hooks/index.ts": 'export * from "./useKeyboardBehavior";',
        "app/screen.tsx": bareScreen('import { useKeyboardBehavior } from "@/hooks";'),
      },
      detail:
        "the behavior prop comes from another file (`useKeyboardBehavior` is imported from \"@/hooks\", but hooks/index.ts does not export `useKeyboardBehavior` directly (it may come through export * from \"./useKeyboardBehavior\"))",
    },
    missingExport: {
      files: {
        "hooks/useKeyboardBehavior.ts": 'export const unrelated = "padding";',
        "app/screen.tsx": bareScreen('import { useKeyboardBehavior } from "@/hooks/useKeyboardBehavior";'),
      },
      detail:
        "the behavior prop comes from another file (`useKeyboardBehavior` is imported from \"@/hooks/useKeyboardBehavior\", but hooks/useKeyboardBehavior.ts does not export `useKeyboardBehavior`)",
    },
    missingModule: {
      files: {
        "app/screen.tsx": bareScreen('import { useKeyboardBehavior } from "@/hooks/useKeyboardBehavior";'),
      },
      detail:
        "the behavior prop comes from another file (`useKeyboardBehavior` is imported from \"@/hooks/useKeyboardBehavior\", which does not resolve to a source file)",
    },
    wholeNamespace: {
      files: {
        "hooks/useKeyboardBehavior.ts": platformHook,
        "app/screen.tsx": bareScreen('import * as keyboard from "@/hooks/useKeyboardBehavior";', "keyboard"),
      },
      detail:
        "the behavior prop comes from another file (`keyboard` is imported from \"@/hooks/useKeyboardBehavior\", and the whole module namespace of hooks/useKeyboardBehavior.ts is used as the value)",
    },
  };
  const roots = [];
  for (const [name, { files, detail }] of Object.entries(forms)) {
    const { root, findings } = await scanFixture(files);
    roots.push(root);
    const callSite = findings.filter((finding) => finding.file === "app/screen.tsx");
    assert.deepEqual(rulesOf(callSite), ["behavior-from-another-file"], `${name}: ${JSON.stringify(findings)}`);
    assert.equal(callSite[0].line, 2, name);
    assert.equal(callSite[0].detail, detail, name);
  }
  cleanup(t, roots);

  // Without a module loader (single-source scans) nothing can be followed.
  const unfollowed = scan(
    "app/screen.tsx",
    bareScreen('import { useKeyboardBehavior } from "@/hooks/useKeyboardBehavior";'),
  );
  assert.deepEqual(rulesOf(unfollowed), ["behavior-from-another-file"]);
  assert.equal(
    unfollowed[0].detail,
    "the behavior prop comes from another file (`useKeyboardBehavior` is imported from \"@/hooks/useKeyboardBehavior\", which was not followed)",
  );

  // The fix keeps the literal at the call site; package imports are never followed.
  assert.match(
    formatKeyboardStrategyFailure(unfollowed),
    /\[behavior-from-another-file\] the behavior prop comes from another file \(.*\)\. Fix: keep the fixed "padding" value at the call site;/,
  );
  assert.deepEqual(
    scan(
      "app/screen.tsx",
      bareScreen('import { useKeyboardBehavior } from "some-keyboard-package";'),
    ),
    [],
  );
});

test("flags a behavior value taken from platform-specific module files", async (t) => {
  const { root, findings } = await scanFixture({
    "lib/keyboardBehavior.ios.ts": 'export const KEYBOARD_BEHAVIOR = "padding";',
    "lib/keyboardBehavior.android.ts": 'export const KEYBOARD_BEHAVIOR = "height";',
    "app/screen.tsx": `import { KEYBOARD_BEHAVIOR } from "@/lib/keyboardBehavior";
export default () => <KeyboardAvoidingView behavior={KEYBOARD_BEHAVIOR} />;`,
  });
  const withBase = await scanFixture({
    "lib/keyboardBehavior.ts": 'export const KEYBOARD_BEHAVIOR = "padding";',
    "lib/keyboardBehavior.android.ts": 'export const KEYBOARD_BEHAVIOR = "height";',
    "app/screen.tsx": `import { KEYBOARD_BEHAVIOR } from "@/lib/keyboardBehavior";
export default () => <KeyboardAvoidingView behavior={KEYBOARD_BEHAVIOR} />;`,
  });
  cleanup(t, [root, withBase.root]);

  assert.deepEqual(rulesOf(findings), ["platform-split-behavior"]);
  assert.equal(
    findings[0].detail,
    "the behavior prop depends on the platform-specific module files lib/keyboardBehavior.ios.ts and lib/keyboardBehavior.android.ts through `KEYBOARD_BEHAVIOR`",
  );
  assert.deepEqual(rulesOf(withBase.findings), ["platform-split-behavior"]);
  assert.equal(
    withBase.findings[0].detail,
    "the behavior prop depends on the platform-specific module files lib/keyboardBehavior.android.ts through `KEYBOARD_BEHAVIOR`",
  );
});

test("flags React Native's KeyboardAvoidingView re-exported under another name from a shared module", async (t) => {
  const composer = `import { KeyboardShell } from "@/lib/keyboard";
export const Composer = () => <KeyboardShell behavior="padding" />;`;
  const reexported = await scanFixture({
    "lib/keyboard.ts": 'export { KeyboardAvoidingView as KeyboardShell } from "react-native";',
    "components/Composer.tsx": composer,
  });
  const aliased = await scanFixture({
    "lib/keyboard.ts": `import { KeyboardAvoidingView } from "react-native";
export const KeyboardShell = KeyboardAvoidingView;`,
    "components/Composer.tsx": composer,
  });
  // A module outside the scanned directories (a root-level file, where only
  // configuration lives) is still followed from the call site.
  const unscannedModule = await scanFixture({
    "keyboard.ts": 'export { KeyboardAvoidingView as KeyboardShell } from "react-native";',
    "components/Composer.tsx": composer.replace("@/lib/keyboard", "@/keyboard"),
  });
  cleanup(t, [reexported.root, aliased.root, unscannedModule.root]);

  const callSiteFinding = (module) => ({
    file: "components/Composer.tsx",
    rule: "react-native-keyboard-avoiding-view",
    line: 2,
    detail: `renders <KeyboardShell>, which is KeyboardAvoidingView from "react-native" re-exported by "${module}"`,
  });
  assert.deepEqual(reexported.findings, [
    callSiteFinding("@/lib/keyboard"),
    {
      file: "lib/keyboard.ts",
      rule: "react-native-keyboard-avoiding-view",
      line: 1,
      detail: 're-exports KeyboardAvoidingView from "react-native"',
    },
  ]);
  assert.deepEqual(aliased.findings, [
    callSiteFinding("@/lib/keyboard"),
    {
      file: "lib/keyboard.ts",
      rule: "react-native-keyboard-avoiding-view",
      line: 1,
      detail: 'imports KeyboardAvoidingView from "react-native"',
    },
  ]);
  assert.deepEqual(unscannedModule.findings, [callSiteFinding("@/keyboard")]);
  assert.deepEqual(unscannedModule.scannedFiles, [ROOT_LAYOUT_PATH, "components/Composer.tsx"]);
});

test("holds the controller KeyboardAvoidingView re-exported under another name to the padding rule", async (t) => {
  const { root, findings } = await scanFixture({
    "lib/keyboard.ts": 'export { KeyboardAvoidingView as KeyboardShell } from "react-native-keyboard-controller";',
    "components/Composer.tsx": `import { KeyboardShell } from "@/lib/keyboard";
export const Fine = () => <KeyboardShell behavior="padding" />;
export const Wrong = () => <KeyboardShell behavior="height" />;
export const Missing = () => <KeyboardShell />;`,
  });
  cleanup(t, [root]);

  assert.deepEqual(
    findings.map(({ file, rule, line }) => ({ file, rule, line })),
    [
      { file: "components/Composer.tsx", rule: "keyboard-avoiding-view-behavior", line: 3 },
      { file: "components/Composer.tsx", rule: "keyboard-avoiding-view-behavior", line: 4 },
    ],
  );
});

test("type imports from another file are not treated as a behavior source", async (t) => {
  const { root, findings } = await scanFixture({
    "lib/keyboard.ts": 'export type KeyboardBehavior = "padding" | "height";',
    "app/screen.tsx": `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import type { KeyboardBehavior } from "@/lib/keyboard";
export default () => <KeyboardAvoidingView behavior={"padding" as KeyboardBehavior} />;`,
    "components/Shell.tsx": `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { KeyboardBehavior } from "@/lib/keyboard";
const behavior: KeyboardBehavior = "padding";
export const Shell = () => <KeyboardAvoidingView behavior={behavior satisfies KeyboardBehavior} />;`,
  });
  cleanup(t, [root]);

  assert.deepEqual(findings, []);
});

test("scans whatever top-level directories exist but still requires app/ and components/", async (t) => {
  const minimal = await mkdtemp(path.join(os.tmpdir(), "keyboard-strategy-"));
  await mkdir(path.join(minimal, "app"));
  await mkdir(path.join(minimal, "components"));
  await writeFile(path.join(minimal, ROOT_LAYOUT_PATH), compliantRootLayout);
  await writeFile(path.join(minimal, "app/screen.tsx"), compliantScreen);
  const noApp = await mkdtemp(path.join(os.tmpdir(), "keyboard-strategy-"));
  for (const directory of ["components", "constants", "hooks", "lib", "services"]) {
    await mkdir(path.join(noApp, directory));
  }
  await writeFile(path.join(noApp, "components/Fine.tsx"), compliantScreen);
  const noComponents = await mkdtemp(path.join(os.tmpdir(), "keyboard-strategy-"));
  await mkdir(path.join(noComponents, "app"));
  await writeFile(path.join(noComponents, "app/screen.tsx"), compliantScreen);
  cleanup(t, [minimal, noApp, noComponents]);

  // No optional directory, nothing skipped: the scope is the two required trees.
  const result = scanKeyboardStrategy({ packageRoot: minimal, workspaceRoot: minimal });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.scannedDirectories, ["app", "components"]);
  assert.deepEqual(result.skippedDirectories, []);
  assert.deepEqual(result.scannedFiles, [ROOT_LAYOUT_PATH, "app/screen.tsx"]);
  assert.equal(result.packagePath, "");
  assert.equal(result.rootLayoutFile, ROOT_LAYOUT_PATH);
  assert.deepEqual(listSourceDirectories({ packageRoot: minimal }), { scanned: ["app", "components"], skipped: [] });
  // Other folders never stand in for the required ones.
  assert.throws(
    () => scanKeyboardStrategy({ packageRoot: noApp, workspaceRoot: noApp }),
    /expected directory app does not exist\. Update REQUIRED_DIRECTORIES/,
  );
  assert.throws(
    () => scanKeyboardStrategy({ packageRoot: noComponents, workspaceRoot: noComponents }),
    /expected directory components does not exist/,
  );
  // The guard names the directory relative to the workspace root, as findings do.
  assert.throws(
    () => listSourceDirectories({ packageRoot: noApp, workspaceRoot: path.dirname(noApp) }),
    new RegExp(`expected directory ${path.basename(noApp)}/app does not exist`),
  );
});

test("violations in every shared-module home are reported", async (t) => {
  // None of these modules is imported by a screen, so each finding can only
  // come from reading the module itself.
  const { root, findings, scannedDirectories } = await scanFixture({
    "app/screen.tsx": compliantScreen,
    "constants/keyboard.ts": 'export { KeyboardAvoidingView as KeyboardShell } from "react-native";',
    "hooks/useKeyboard.ts": 'export { KeyboardAvoidingView } from "react-native";',
    "lib/keyboard.ts": `import { Platform } from "react-native";
export const keyboardProps = { behavior: Platform.select({ ios: "padding", default: "height" }) };`,
    "contexts/KeyboardContext.tsx": `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
export const Provider = ({ children }) => <KeyboardAvoidingView>{children}</KeyboardAvoidingView>;`,
    "utils/forms.ts": 'import { KeyboardAwareScrollView } from "react-native-keyboard-controller";',
  });
  cleanup(t, [root]);

  assert.deepEqual(scannedDirectories, ["app", "components", "constants", "contexts", "hooks", "lib", "utils"]);
  assert.deepEqual(
    findings.map(({ file, rule, line }) => `${file}:${line} ${rule}`),
    [
      "constants/keyboard.ts:1 react-native-keyboard-avoiding-view",
      "contexts/KeyboardContext.tsx:2 keyboard-avoiding-view-behavior",
      "hooks/useKeyboard.ts:1 react-native-keyboard-avoiding-view",
      "lib/keyboard.ts:2 platform-split-behavior",
      "utils/forms.ts:1 direct-keyboard-aware-scroll-view",
    ],
  );
});

test("a top-level folder that did not exist before is scanned without editing a list", async (t) => {
  // services/, store/ and features/ are not named anywhere in the check; a
  // violation in each — including one nested below the top level — is
  // reported at module level, and a compliant module there is left alone.
  const { root, findings, scannedDirectories, skippedDirectories } = await scanFixture({
    "app/screen.tsx": compliantScreen,
    "services/keyboardShell.ts": 'export { KeyboardAvoidingView as KeyboardShell } from "react-native";',
    "services/api.ts": "export const baseUrl = process.env.EXPO_PUBLIC_API_URL;",
    "store/forms.ts": 'import { KeyboardAwareScrollView } from "react-native-keyboard-controller";',
    "features/composer/keyboard.ts": `import { Platform } from "react-native";
export const keyboardProps = { behavior: process.env.EXPO_OS === "ios" ? "padding" : "height" };`,
    "features/composer/Composer.tsx": compliantScreen,
  });
  cleanup(t, [root]);

  assert.deepEqual(scannedDirectories, ["app", "components", "features", "services", "store"]);
  assert.deepEqual(skippedDirectories, []);
  assert.deepEqual(
    findings.map(({ file, rule, line }) => `${file}:${line} ${rule}`),
    [
      "features/composer/keyboard.ts:2 platform-split-behavior",
      "services/keyboardShell.ts:1 react-native-keyboard-avoiding-view",
      "store/forms.ts:1 direct-keyboard-aware-scroll-view",
    ],
  );
});

test("a platform split spread onto a compliant call site is caught where it is defined", async (t) => {
  // The wrapper passes the required literal "padding" and then spreads the
  // helper's props over it, so the call site is clean and only the module
  // itself shows the split. Before constants/ was scanned this shipped.
  const { root, findings } = await scanFixture({
    "constants/keyboard.ts": `import { Platform } from "react-native";
export const keyboardProps = {
  behavior: Platform.OS === "ios" ? "padding" : "height",
  keyboardVerticalOffset: 0,
};`,
    "components/KeyboardShell.tsx": `import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { keyboardProps } from "@/constants/keyboard";
export const KeyboardShell = ({ children }) => (
  <KeyboardAvoidingView behavior="padding" {...keyboardProps}>{children}</KeyboardAvoidingView>
);`,
  });
  cleanup(t, [root]);

  assert.deepEqual(findings, [
    {
      file: "constants/keyboard.ts",
      rule: "platform-split-behavior",
      line: 3,
      detail: "the behavior property depends on Platform.OS",
    },
  ]);
});

test("non-source directories are skipped even when they hold keyboard violations", async (t) => {
  // Test suites and stand-ins legitimately mention the forbidden components
  // (they mock them), dependencies and build output are not the app's source,
  // and dot-directories are tooling state; none of them can trip the check or
  // stand in for a source folder.
  const violation = 'export { KeyboardAvoidingView } from "react-native";';
  const files = { "app/screen.tsx": compliantScreen, ".expo/types/router.ts": violation };
  for (const directory of NON_SOURCE_DIRECTORIES) {
    files[`${directory}/keyboard.ts`] = violation;
  }
  const { root, findings, scannedDirectories, skippedDirectories, scannedFiles } = await scanFixture(files);
  cleanup(t, [root]);

  assert.deepEqual(findings, []);
  assert.deepEqual(scannedDirectories, ["app", "components"]);
  assert.deepEqual(scannedFiles, [ROOT_LAYOUT_PATH, "app/screen.tsx"]);
  assert.deepEqual([...skippedDirectories].sort(), [".expo", ...NON_SOURCE_DIRECTORIES].sort());
  // The exclusion list is an opt-out for known names only: renaming the
  // exclusions makes the same folders source again.
  const rescanned = scanKeyboardStrategy({ packageRoot: root, workspaceRoot: root, excludedDirectories: [] });
  assert.deepEqual(rescanned.skippedDirectories, [".expo"]);
  assert.deepEqual(
    new Set(rescanned.findings.map(({ file }) => file)),
    new Set(NON_SOURCE_DIRECTORIES.map((directory) => `${directory}/keyboard.ts`)),
  );
  assert.ok(rescanned.findings.every(({ rule }) => rule === "react-native-keyboard-avoiding-view"));
});

test("flags KeyboardAwareScrollView used directly outside the compat component", () => {
  const forms = {
    named: 'import { KeyboardAwareScrollView } from "react-native-keyboard-controller";',
    aliased: 'import { KeyboardAwareScrollView as Form } from "react-native-keyboard-controller";',
    namespace: 'import * as KC from "react-native-keyboard-controller";\nconst form = <KC.KeyboardAwareScrollView />;',
    required: 'const { KeyboardAwareScrollView } = require("react-native-keyboard-controller");',
    reexport: 'export { KeyboardAwareScrollView } from "react-native-keyboard-controller";',
    otherPackage: 'import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";',
    localReexport: 'import { KeyboardAwareScrollView } from "@/components/forms";',
    bareTag: "const form = <KeyboardAwareScrollView />;",
  };
  for (const [name, source] of Object.entries(forms)) {
    const findings = scan("app/form.tsx", source);
    assert.deepEqual(rulesOf(findings), ["direct-keyboard-aware-scroll-view"], `${name} form`);
    assert.match(findings[0].detail, /KeyboardAwareScrollView/);
  }
});

test("allows the compat component itself and its props type elsewhere", () => {
  const compatSource = `import { KeyboardAwareScrollView, KeyboardAwareScrollViewProps } from "react-native-keyboard-controller";
import { Platform, ScrollView } from "react-native";
export function KeyboardAwareScrollViewCompat(props: KeyboardAwareScrollViewProps) {
  if (Platform.OS === "web") return <ScrollView {...props} />;
  return <KeyboardAwareScrollView {...props} />;
}`;
  assert.deepEqual(
    scanKeyboardStrategySource({
      file: `artifacts/chat-app/${COMPAT_COMPONENT_PATH}`,
      source: compatSource,
      packageRelativePath: COMPAT_COMPONENT_PATH,
    }),
    [],
  );
  // The exemption is by path, not by file name: a copy elsewhere is a violation.
  assert.deepEqual(
    rulesOf(scan("app/KeyboardAwareScrollViewCompat.tsx", compatSource)),
    ["direct-keyboard-aware-scroll-view"],
  );
  assert.deepEqual(
    scan(
      "components/Field.tsx",
      'import type { KeyboardAwareScrollViewProps } from "react-native-keyboard-controller";',
    ),
    [],
  );
});

test("the compat component is still held to the other two rules", () => {
  const findings = scanKeyboardStrategySource({
    file: `artifacts/chat-app/${COMPAT_COMPONENT_PATH}`,
    source: `import { KeyboardAvoidingView, Platform } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
export const Compat = () => <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} />;`,
    packageRelativePath: COMPAT_COMPONENT_PATH,
  });
  assert.deepEqual(rulesOf(findings), ["react-native-keyboard-avoiding-view", "platform-split-behavior"]);
});

test("ignores comments, so explanatory notes cannot trip the rules", () => {
  assert.deepEqual(
    scan(
      "app/screen.tsx",
      `// Do not: import { KeyboardAvoidingView } from "react-native";
/* Old code: behavior={Platform.OS === "ios" ? "padding" : "height"}
   and <KeyboardAwareScrollView /> from react-native-keyboard-controller. */
${compliantScreen}`,
    ),
    [],
  );
});

test("the failure message names the file, line, rule and the replit.md strategy note", () => {
  const findings = scan(
    "artifacts/chat-app/app/room/[roomId].tsx",
    `import { KeyboardAvoidingView, Platform } from "react-native";
const view = <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} />;`,
  );
  const message = formatKeyboardStrategyFailure(findings);

  assert.match(message, /^Keyboard strategy violations in the Chat App/);
  assert.match(message, /see the "Keyboard handling on native has one strategy" note in replit\.md/);
  assert.match(
    message,
    /artifacts\/chat-app\/app\/room\/\[roomId\]\.tsx:1 \[react-native-keyboard-avoiding-view\] imports KeyboardAvoidingView from "react-native"\. Fix: import KeyboardAvoidingView from "react-native-keyboard-controller" instead/,
  );
  assert.match(
    message,
    /artifacts\/chat-app\/app\/room\/\[roomId\]\.tsx:2 \[platform-split-behavior\] the behavior prop depends on Platform\.OS\. Fix: use behavior="padding" on both platforms/,
  );
  for (const rule of Object.keys(KEYBOARD_STRATEGY_RULES)) {
    assert.ok(KEYBOARD_STRATEGY_RULES[rule].fix.length > 0, `${rule} documents its fix`);
  }
});

test("assertKeyboardStrategy throws the formatted message for a violating tree", async (t) => {
  const root = await writeFixtureRoot({
    "app/(tabs)/settings.tsx": 'import { KeyboardAvoidingView } from "react-native";',
    "components/Form.tsx": 'import { KeyboardAwareScrollView } from "react-native-keyboard-controller";',
    "components/Fine.tsx": compliantScreen,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(
    () => assertKeyboardStrategy({ packageRoot: root, workspaceRoot: root }),
    (error) => {
      assert.match(error.message, /app\/\(tabs\)\/settings\.tsx:1 \[react-native-keyboard-avoiding-view\]/);
      assert.match(error.message, /components\/Form\.tsx:1 \[direct-keyboard-aware-scroll-view\]/);
      assert.doesNotMatch(error.message, /Fine\.tsx/);
      assert.match(error.message, /replit\.md/);
      return true;
    },
  );
});

test("refuses to pass when a scanned directory is missing or empty", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "keyboard-strategy-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(
    () => scanKeyboardStrategy({ packageRoot: root, workspaceRoot: root }),
    /expected directory app does not exist/,
  );
  // Empty directories — required, shared-module home or new — count as
  // scanned but yield nothing, and nothing is not a pass.
  for (const directory of [...REQUIRED_DIRECTORIES, "constants", "services", "__tests__"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  assert.throws(
    () => scanKeyboardStrategy({ packageRoot: root, workspaceRoot: root }),
    /no source files found under app, components, constants, services; refusing to pass an empty scan/,
  );
});

// --- Whole-tree rule: the root layout wraps the navigator in KeyboardProvider

/** Runs the root-layout rule on one synthetic root layout with no other files to follow. */
function scanRootLayout(source, file = ROOT_LAYOUT_PATH) {
  return scanRootLayoutKeyboardProvider({ file, source });
}

/** The 1-based line of the first occurrence of `needle` in `source`. */
function lineOf(source, needle) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `expected the fixture to contain ${needle}`);
  return source.slice(0, index).split("\n").length;
}

const rootRule = "root-keyboard-provider";
const noProviderImport = `${ROOT_LAYOUT_PATH} does not import KeyboardProvider from "react-native-keyboard-controller"`;
const noNavigatorFinding = {
  file: ROOT_LAYOUT_PATH,
  rule: rootRule,
  line: null,
  detail:
    'renders no navigator the check can see (<Stack>, <Slot>, <Tabs>, <NativeTabs>, <Drawer> or <Navigator> from "expo-router", ' +
    "followed from the default export through same-file components and one import hop)",
};


test("the root layout rule is part of the strategy and its fix names the provider, the navigators and the limits", () => {
  assert.ok(Object.hasOwn(KEYBOARD_STRATEGY_RULES, rootRule));
  assert.deepEqual(ROUTER_NAVIGATOR_EXPORTS, ["Stack", "Slot", "Tabs", "NativeTabs", "Drawer", "Navigator"]);
  const { fix } = KEYBOARD_STRATEGY_RULES[rootRule];
  assert.match(fix, /keep <KeyboardProvider> from "react-native-keyboard-controller" in app\/_layout\.tsx/);
  for (const navigator of ROUTER_NAVIGATOR_EXPORTS) assert.ok(fix.includes(`<${navigator}>`), navigator);
  assert.match(fix, /every Jest suite mocks the provider as a pass-through/);
  assert.match(fix, /one import hop/);
  assert.match(fix, /not passed through a children prop/);
});

test("the real root layout fails the root provider rule as soon as KeyboardProvider is removed", () => {
  const layoutPath = path.join(packageRoot, ROOT_LAYOUT_PATH);
  const source = readFileSync(layoutPath, "utf8");
  const file = `artifacts/chat-app/${ROOT_LAYOUT_PATH}`;
  const importLine = 'import { KeyboardProvider } from "react-native-keyboard-controller";\n';
  const wrapped = /<KeyboardProvider>\s*(<RootLayoutNav \/>)\s*<\/KeyboardProvider>/;
  // Guard the derivation: the fixture below must really be "the current
  // layout minus the provider", so a restructured layout has to update this.
  assert.ok(source.includes(importLine), "the root layout imports KeyboardProvider");
  assert.match(source, wrapped, "the root layout wraps RootLayoutNav in KeyboardProvider");
  const removed = source.replace(importLine, "").replace(wrapped, "$1");
  assert.ok(!removed.includes("KeyboardProvider"));
  // The real loader follows AppFooter, ScaledText, the contexts, … exactly as
  // the check does against the tree.
  const resolveModule = createModuleLoader({ packageRoot }).resolverFor(layoutPath);

  assert.deepEqual(scanRootLayoutKeyboardProvider({ file, source, resolveModule }), []);

  const findings = scanRootLayoutKeyboardProvider({ file, source: removed, resolveModule });
  assert.deepEqual(findings, [
    {
      file,
      rule: rootRule,
      line: lineOf(removed, "<Stack screenOptions"),
      detail:
        'renders <Stack> from "expo-router" outside KeyboardProvider from "react-native-keyboard-controller" ' +
        `(reached through RootLayout › RootLayoutNav › RootLayoutContent; ${file} does not import KeyboardProvider ` +
        'from "react-native-keyboard-controller")',
    },
  ]);
  const message = formatKeyboardStrategyFailure(findings);
  assert.match(message, /^Keyboard strategy violation in the Chat App \(.*; see the "Keyboard handling on native has one strategy" note in replit\.md\):/);
  assert.match(message, /\n  - artifacts\/chat-app\/app\/_layout\.tsx:\d+ \[root-keyboard-provider\] renders <Stack> .* Fix: keep <KeyboardProvider>/);
});

test("the root provider rule says how the provider went missing", () => {
  const imported = `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  return <Stack />;
}`;
  const selfClosing = `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  return (
    <>
      <KeyboardProvider />
      <Stack />
    </>
  );
}`;
  const beside = `import { Stack } from "expo-router";
import { View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
function Footer() { return <View />; }
export default function RootLayout() {
  return (
    <View>
      <Stack />
      <KeyboardProvider>
        <Footer />
      </KeyboardProvider>
    </View>
  );
}`;
  const below = `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  return (
    <Stack>
      <KeyboardProvider>
        <Stack.Screen name="(tabs)" />
      </KeyboardProvider>
    </Stack>
  );
}`;
  const otherPackage = `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-avoiding-provider";
export default function RootLayout() {
  return (
    <KeyboardProvider>
      <Stack />
    </KeyboardProvider>
  );
}`;
  const conditional = `import { Stack } from "expo-router";
import { Platform } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  if (Platform.OS === "web") return <Stack />;
  return (
    <KeyboardProvider>
      <Stack />
    </KeyboardProvider>
  );
}`;
  const expectations = [
    [imported, 4, "reached through RootLayout; KeyboardProvider is imported but not rendered on the way there"],
    [selfClosing, 7, "reached through RootLayout; the self-closing <KeyboardProvider /> on line 6 renders nothing inside it"],
    [beside, 8, "reached through RootLayout; the <KeyboardProvider> on line 9 does not contain it"],
    [below, 5, "reached through RootLayout; the <KeyboardProvider> on line 6 does not contain it"],
    [otherPackage, 6, `reached through RootLayout; ${noProviderImport}`],
    [conditional, 5, "reached through RootLayout; the <KeyboardProvider> on line 7 does not contain it"],
  ];
  for (const [source, line, status] of expectations) {
    assert.deepEqual(
      scanRootLayout(source),
      [
        {
          file: ROOT_LAYOUT_PATH,
          rule: rootRule,
          line,
          detail: `renders <Stack> from "expo-router" outside KeyboardProvider from "react-native-keyboard-controller" (${status})`,
        },
      ],
      source,
    );
  }
});

test("a root layout the rule cannot follow is a finding, not a pass", () => {
  const rootFinding = (detail) => [{ file: ROOT_LAYOUT_PATH, rule: rootRule, line: null, detail }];

  assert.deepEqual(
    scanRootLayoutKeyboardProvider({ file: ROOT_LAYOUT_PATH, source: null }),
    rootFinding("does not exist, so nothing renders KeyboardProvider around the navigator"),
  );
  assert.deepEqual(
    scanRootLayout(`import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export function RootLayout() {
  return <KeyboardProvider><Stack /></KeyboardProvider>;
}`),
    rootFinding(
      "has no default export, so the tree it renders cannot be followed from the default export through same-file components and one import hop",
    ),
  );
  assert.deepEqual(
    scanRootLayout('export { default } from "@/components/RootLayout";'),
    rootFinding(
      're-exports its default export from "@/components/RootLayout", which the check does not follow; define the root layout component in this file',
    ),
  );
  assert.deepEqual(
    scanRootLayout(`import { View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  return <KeyboardProvider><View /></KeyboardProvider>;
}`),
    [noNavigatorFinding],
  );
  // The failure message has no line to print for a file-level finding.
  const message = formatKeyboardStrategyFailure(rootFinding("has no default export"));
  assert.match(message, /\n  - app\/_layout\.tsx \[root-keyboard-provider\] has no default export\. Fix: /);
});

test("the root provider rule reads only what the layout renders, so dead code cannot satisfy it", () => {
  const deadWrapped = {
    unusedVariable: `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  const unused = <KeyboardProvider><Stack /></KeyboardProvider>;
  return null;
}`,
    effectCallback: `import { Stack } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  useEffect(() => {
    const tree = <KeyboardProvider><Stack /></KeyboardProvider>;
    void tree;
  }, []);
  return <View />;
}`,
    jsxProp: `import { Stack } from "expo-router";
import { View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  return <View header={<KeyboardProvider><Stack /></KeyboardProvider>} />;
}`,
    unusedComponent: `import { Stack } from "expo-router";
import { View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
function Unused() {
  return <KeyboardProvider><Stack /></KeyboardProvider>;
}
export default function RootLayout() {
  return <View />;
}`,
    renderPropChild: `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  return <KeyboardProvider>{() => <Stack />}</KeyboardProvider>;
}`,
    nestedFunctionReturn: `import { Stack } from "expo-router";
import { View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  const helper = () => {
    return <KeyboardProvider><Stack /></KeyboardProvider>;
  };
  void helper;
  return <View />;
}`,
  };
  for (const [name, source] of Object.entries(deadWrapped)) {
    assert.deepEqual(scanRootLayout(source), [noNavigatorFinding], name);
  }
});

test("the root provider rule ignores unwrapped navigators the layout never renders", () => {
  const deadUnwrapped = {
    callbacksAndVariables: `import { Stack } from "expo-router";
import { useCallback, useEffect } from "react";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  const unused = <Stack />;
  const onPress = useCallback(() => <Stack />, []);
  useEffect(() => {
    const dead = <Stack />;
    void dead;
    void onPress;
  }, [onPress]);
  return <KeyboardProvider><Stack /></KeyboardProvider>;
}`,
    jsxProp: `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  return <KeyboardProvider fallback={<Stack />}><Stack /></KeyboardProvider>;
}`,
    unusedComponent: `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
function Unused() {
  return <Stack />;
}
export default function RootLayout() {
  return <KeyboardProvider><Stack /></KeyboardProvider>;
}`,
    lifecycleMethod: `import { Stack } from "expo-router";
import React from "react";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default class RootLayout extends React.Component {
  componentDidMount() {
    const dead = <Stack />;
    void dead;
  }
  render() {
    return <KeyboardProvider><Stack /></KeyboardProvider>;
  }
}`,
  };
  for (const [name, source] of Object.entries(deadUnwrapped)) {
    assert.deepEqual(scanRootLayout(source), [], name);
  }
});

test("the root provider rule accepts every way the current layout may spell the provider and the navigator", () => {
  const layouts = {
    aliasedImport: `import { Slot } from "expo-router";
import { KeyboardProvider as KP } from "react-native-keyboard-controller";
export default () => <KP><Slot /></KP>;`,
    namespaceImport: `import { Tabs } from "expo-router";
import * as KC from "react-native-keyboard-controller";
export default function RootLayout() {
  return <KC.KeyboardProvider><Tabs screenOptions={{ headerShown: false }} /></KC.KeyboardProvider>;
}`,
    sameFileAlias: `import * as Router from "expo-router";
import * as KC from "react-native-keyboard-controller";
const Provider = KC.KeyboardProvider;
export default function RootLayout() {
  return <Provider><Router.Stack /></Provider>;
}`,
    nativeTabs: `import { NativeTabs } from "expo-router/unstable-native-tabs";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout() {
  return (
    <KeyboardProvider>
      <NativeTabs>
        <NativeTabs.Trigger name="index" />
      </NativeTabs>
    </KeyboardProvider>
  );
}`,
    sameFileComponents: `import { Stack } from "expo-router";
import { View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
function Content({ ready }) {
  if (!ready) return <View />;
  return (
    <Stack>
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
const Nav = () => (
  <View>
    <Content ready />
  </View>
);
function RootLayout() {
  return (
    <View>
      <KeyboardProvider>
        <Nav />
      </KeyboardProvider>
    </View>
  );
}
export default RootLayout;`,
    wrappedExport: `import * as Sentry from "@sentry/react-native";
import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
const enabled = Boolean(process.env["EXPO_PUBLIC_SENTRY_DSN"]);
function RootLayout() {
  return <KeyboardProvider><Stack /></KeyboardProvider>;
}
export default enabled ? Sentry.wrap(RootLayout) : RootLayout;`,
    namedDefaultExport: `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
const RootLayout = () => <KeyboardProvider><Stack /></KeyboardProvider>;
export { RootLayout as default };`,
    memoExport: `import { memo } from "react";
import { Drawer } from "expo-router/drawer";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default memo(function RootLayout() {
  return <KeyboardProvider><Drawer /></KeyboardProvider>;
});`,
    renderedVariables: `import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useMemo } from "react";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout({ ready }) {
  const statusBar = <StatusBar style="light" />;
  const navigator = useMemo(() => <Stack />, []);
  const renderContent = () => (ready ? navigator : null);
  return (
    <KeyboardProvider>
      {statusBar}
      {renderContent()}
    </KeyboardProvider>
  );
}`,
    branchingReturns: `import { Stack, Slot } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function RootLayout({ mode, ready }) {
  switch (mode) {
    case "stack":
      return ready && <KeyboardProvider><Stack /></KeyboardProvider>;
    default:
      return ready ? [<KeyboardProvider key="slot"><Slot /></KeyboardProvider>] : null;
  }
}`,
    immediatelyInvoked: `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default () => (function () { return <KeyboardProvider><Stack /></KeyboardProvider>; })();`,
  };
  for (const [name, source] of Object.entries(layouts)) {
    assert.deepEqual(scanRootLayout(source), [], name);
  }
});

test("the root provider rule follows one import hop for the navigator, the provider and its re-export", async (t) => {
  const navigatorOneHop = await scanFixture({
    "components/RootNavigator.tsx": `import { Stack } from "expo-router";
export function RootNavigator() {
  return <Stack screenOptions={{ headerShown: false }} />;
}`,
    [ROOT_LAYOUT_PATH]: `import { KeyboardProvider } from "react-native-keyboard-controller";
import { RootNavigator } from "@/components/RootNavigator";
export default function RootLayout() {
  return <KeyboardProvider><RootNavigator /></KeyboardProvider>;
}`,
  });
  const providerOneHop = await scanFixture({
    "components/AppShell.tsx": `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export const AppShell = () => <KeyboardProvider><Stack /></KeyboardProvider>;`,
    [ROOT_LAYOUT_PATH]: `import { AppShell } from "@/components/AppShell";
export default function RootLayout() {
  return <AppShell />;
}`,
  });
  const reexportedProvider = await scanFixture({
    "lib/keyboard.ts": 'export { KeyboardProvider as AppKeyboardProvider } from "react-native-keyboard-controller";',
    [ROOT_LAYOUT_PATH]: `import { Stack } from "expo-router";
import { AppKeyboardProvider } from "@/lib/keyboard";
export default function RootLayout() {
  return <AppKeyboardProvider><Stack /></AppKeyboardProvider>;
}`,
  });
  cleanup(t, [navigatorOneHop.root, providerOneHop.root, reexportedProvider.root]);

  assert.deepEqual(navigatorOneHop.findings, []);
  assert.deepEqual(providerOneHop.findings, []);
  assert.deepEqual(reexportedProvider.findings, []);
});

test("the root provider rule rejects what it cannot prove: a second hop, a children wrapper, a child layout, platform variants", async (t) => {
  const secondHop = await scanFixture({
    "components/Shell.tsx": `import { Nav } from "./Nav";
export function Shell() { return <Nav />; }`,
    "components/Nav.tsx": `import { Stack } from "expo-router";
export function Nav() { return <Stack />; }`,
    [ROOT_LAYOUT_PATH]: `import { KeyboardProvider } from "react-native-keyboard-controller";
import { Shell } from "@/components/Shell";
export default function RootLayout() {
  return <KeyboardProvider><Shell /></KeyboardProvider>;
}`,
  });
  const childrenWrapper = await scanFixture({
    "components/KeyboardRoot.tsx": `import { KeyboardProvider } from "react-native-keyboard-controller";
export function KeyboardRoot({ children }) {
  return <KeyboardProvider>{children}</KeyboardProvider>;
}`,
    [ROOT_LAYOUT_PATH]: `import { Stack } from "expo-router";
import { KeyboardRoot } from "@/components/KeyboardRoot";
export default function RootLayout() {
  return (
    <KeyboardRoot>
      <Stack />
    </KeyboardRoot>
  );
}`,
  });
  const movedIntoChildLayout = await scanFixture({
    "app/(tabs)/_layout.tsx": `import { Tabs } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default function TabLayout() {
  return <KeyboardProvider><Tabs /></KeyboardProvider>;
}`,
    [ROOT_LAYOUT_PATH]: `import { Stack } from "expo-router";
export default function RootLayout() {
  return <Stack />;
}`,
  });
  const platformVariants = await scanFixture({
    "app/_layout.ios.tsx": `import { Stack } from "expo-router";
export default function RootLayout() {
  return <Stack />;
}`,
  });
  cleanup(t, [secondHop.root, childrenWrapper.root, movedIntoChildLayout.root, platformVariants.root]);

  assert.deepEqual(secondHop.findings, [noNavigatorFinding]);
  assert.deepEqual(childrenWrapper.findings, [
    {
      file: ROOT_LAYOUT_PATH,
      rule: rootRule,
      line: 6,
      detail:
        'renders <Stack> from "expo-router" outside KeyboardProvider from "react-native-keyboard-controller" ' +
        "(reached through RootLayout; the <KeyboardProvider> on line 3 of components/KeyboardRoot.tsx does not contain it)",
    },
  ]);
  assert.deepEqual(movedIntoChildLayout.findings, [
    {
      file: ROOT_LAYOUT_PATH,
      rule: rootRule,
      line: 3,
      detail:
        'renders <Stack> from "expo-router" outside KeyboardProvider from "react-native-keyboard-controller" ' +
        `(reached through RootLayout; ${noProviderImport})`,
    },
  ]);
  assert.deepEqual(platformVariants.findings, [
    {
      file: ROOT_LAYOUT_PATH,
      rule: rootRule,
      line: null,
      detail: "has platform-specific variants (app/_layout.ios.tsx) that the check does not follow; keep a single root layout",
    },
  ]);
});

test("a screen rendering a nested navigator does not satisfy or trip the root provider rule", async (t) => {
  // Only the root layout is followed: a nested Stack in a child layout and a
  // KeyboardProvider rendered by a screen are both out of the rule's scope.
  const { root, findings } = await scanFixture({
    "app/(tabs)/_layout.tsx": `import { Tabs } from "expo-router";
export default () => <Tabs />;`,
    "app/(auth)/_layout.tsx": `import { Stack } from "expo-router";
import { KeyboardProvider } from "react-native-keyboard-controller";
export default () => <KeyboardProvider><Stack /></KeyboardProvider>;`,
  });
  cleanup(t, [root]);

  assert.deepEqual(findings, []);
});

test("the command line entry point fails when the root layout loses its provider", async (t) => {
  const root = await writeFixtureRoot({
    "app/screen.tsx": compliantScreen,
    [ROOT_LAYOUT_PATH]: `import { Stack } from "expo-router";
export default function RootLayout() {
  return <Stack />;
}`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--root", root], { cwd: packageRoot }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        /app\/_layout\.tsx:3 \[root-keyboard-provider\] renders <Stack> from "expo-router" outside KeyboardProvider/,
      );
      assert.match(error.stderr, /see the "Keyboard handling on native has one strategy" note in replit\.md/);
      return true;
    },
  );
});

test("the command line entry point fails with the violation and passes a clean tree", async (t) => {
  const violating = await writeFixtureRoot({
    "app/screen.tsx": `import { Platform } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
export default () => <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} />;`,
  });
  // A module-level violation in a folder the check never heard of, with the
  // screens clean, fails the command line the same way.
  const hiddenHelper = await writeFixtureRoot({
    "app/screen.tsx": compliantScreen,
    "services/keyboardShell.ts": 'export { KeyboardAvoidingView as KeyboardShell } from "react-native";',
  });
  const clean = await writeFixtureRoot({ "app/screen.tsx": compliantScreen });
  // Scanned, skipped and dot-directories side by side, as in the real tree.
  const mixed = await writeFixtureRoot({
    "app/screen.tsx": compliantScreen,
    "components/Fine.tsx": compliantScreen,
    "constants/colors.ts": "export const colors = { background: '#000' };",
    "services/api.ts": "export const baseUrl = process.env.EXPO_PUBLIC_API_URL;",
    "__tests__/screen.test.tsx": 'export { KeyboardAvoidingView } from "react-native";',
    "assets/README.md": "images",
    ".expo/types/router.ts": 'export { KeyboardAvoidingView } from "react-native";',
  });
  t.after(() =>
    Promise.all([violating, hiddenHelper, clean, mixed].map((root) => rm(root, { recursive: true, force: true }))),
  );

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--root", violating], { cwd: packageRoot }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /app\/screen\.tsx:3 \[platform-split-behavior\] the behavior prop depends on Platform\.OS/);
      assert.match(error.stderr, /replit\.md/);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--root", hiddenHelper], { cwd: packageRoot }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        /services\/keyboardShell\.ts:1 \[react-native-keyboard-avoiding-view\] re-exports KeyboardAvoidingView from "react-native"/,
      );
      return true;
    },
  );

  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--root", clean], {
    cwd: packageRoot,
  });
  assert.equal(
    stdout.trim(),
    "Keyboard strategy check passed: 2 source files under app/ and components/ (every top-level directory of the package) " +
      'follow the "Keyboard handling on native has one strategy" note in replit.md, and app/_layout.tsx wraps the navigator in KeyboardProvider.',
  );

  // The pass message names what was read and what was deliberately left out,
  // so a folder skipped by name is visible in the run output.
  const mixedRun = await execFileAsync(process.execPath, [scriptPath, "--root", mixed], { cwd: packageRoot });
  assert.equal(
    mixedRun.stdout.trim(),
    "Keyboard strategy check passed: 5 source files under app/, components/, constants/ and services/ " +
      "(every top-level directory of the package except the non-source __tests__/, .expo/ and assets/) " +
      'follow the "Keyboard handling on native has one strategy" note in replit.md, and app/_layout.tsx wraps the navigator in KeyboardProvider.',
  );
});

test("the pass message describes the real tree's scope", () => {
  const result = scanKeyboardStrategy({ packageRoot });
  const message = formatKeyboardStrategyPass(result);

  const [scanned, rest] = message.split(" (every top-level directory of artifacts/chat-app except the non-source ");
  assert.match(scanned, /^Keyboard strategy check passed: \d+ source files under app\/, components\/, constants\/, /);
  for (const skipped of ["__tests__/", "assets/", "scripts/", "test-utils/"]) {
    assert.ok(!scanned.includes(skipped), `${skipped} must be listed as skipped, not scanned`);
    assert.ok(rest.split(") follow ")[0].includes(skipped), `${skipped} must be listed as skipped`);
  }
  assert.match(
    rest,
    /\) follow the "Keyboard handling on native has one strategy" note in replit\.md, and artifacts\/chat-app\/app\/_layout\.tsx wraps the navigator in KeyboardProvider\.$/,
  );
  // One file reads as singular.
  assert.match(
    formatKeyboardStrategyPass({ ...result, scannedFiles: ["app/_layout.tsx"], skippedDirectories: [], packagePath: "" }),
    /^Keyboard strategy check passed: 1 source file under .* \(every top-level directory of the package\) follows the/,
  );
});
