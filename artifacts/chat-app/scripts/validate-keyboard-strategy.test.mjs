import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  COMPAT_COMPONENT_PATH,
  KEYBOARD_STRATEGY_RULES,
  SCANNED_DIRECTORIES,
  assertKeyboardStrategy,
  formatKeyboardStrategyFailure,
  scanKeyboardStrategy,
  scanKeyboardStrategySource,
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

/** Writes a throwaway package root with the given `{ relativePath: source }` files. */
async function writeFixtureRoot(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "keyboard-strategy-"));
  for (const directory of SCANNED_DIRECTORIES) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const [relativePath, source] of Object.entries(files)) {
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

test("the Chat App's app/ and components/ trees follow the keyboard strategy", () => {
  const { findings, scannedFiles } = scanKeyboardStrategy({ packageRoot });

  assert.deepEqual(findings, [], formatKeyboardStrategyFailure(findings));
  // Guard against an empty or mis-rooted scan passing silently: the known
  // keyboard call sites and the compat component must have been read.
  for (const expected of [
    "artifacts/chat-app/app/room/[roomId].tsx",
    "artifacts/chat-app/app/(tabs)/profile.tsx",
    "artifacts/chat-app/app/(auth)/forgot-password.tsx",
    "artifacts/chat-app/components/AiPanel.tsx",
    `artifacts/chat-app/${COMPAT_COMPONENT_PATH}`,
  ]) {
    assert.ok(scannedFiles.includes(expected), `expected ${expected} to be scanned`);
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
  for (const directory of SCANNED_DIRECTORIES) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  assert.throws(
    () => scanKeyboardStrategy({ packageRoot: root, workspaceRoot: root }),
    /no source files found under app, components/,
  );
});

test("the command line entry point fails with the violation and passes a clean tree", async (t) => {
  const violating = await writeFixtureRoot({
    "app/screen.tsx": `import { Platform } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
export default () => <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} />;`,
  });
  const clean = await writeFixtureRoot({ "app/screen.tsx": compliantScreen });
  t.after(() => Promise.all([violating, clean].map((root) => rm(root, { recursive: true, force: true }))));

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--root", violating], { cwd: packageRoot }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /app\/screen\.tsx:3 \[platform-split-behavior\] the behavior prop depends on Platform\.OS/);
      assert.match(error.stderr, /replit\.md/);
      return true;
    },
  );

  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--root", clean], {
    cwd: packageRoot,
  });
  assert.match(stdout, /Keyboard strategy check passed: 1 source files under app\/ and components\//);
});
