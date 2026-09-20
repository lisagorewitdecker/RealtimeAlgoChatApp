import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// BEGIN GENERATED PREVIEW LOADER EVIDENCE
export const CAPTURED_EXPO_TOOLING = Object.freeze({
  "expoCli": "57.0.20",
  "reactNative": "0.86.3"
});

export const REQUIRED_LOADER_PLATFORMS = Object.freeze([
  "linux",
  "macos",
  "windows"
]);

export const CAPTURED_LOADER_SAMPLES = Object.freeze([
  Object.freeze({
    "name": "Linux shared-library loader",
    "platform": "linux",
    "fixture": "missing-runtime-library"
  }),
  Object.freeze({
    "name": "macOS dyld loader",
    "platform": "macos",
    "fixture": "missing-runtime-library-dyld"
  }),
  Object.freeze({
    "name": "Windows loader",
    "platform": "windows",
    "fixture": "missing-runtime-library-windows"
  }),
  Object.freeze({
    "name": "Linux shared-library loader with a long path",
    "platform": "linux",
    "fixture": "missing-runtime-library-long-path"
  }),
  Object.freeze({
    "name": "macOS dyld loader with a long path",
    "platform": "macos",
    "fixture": "missing-runtime-library-dyld-long-path"
  }),
  Object.freeze({
    "name": "Windows loader with a long path",
    "platform": "windows",
    "fixture": "missing-runtime-library-windows-long-path"
  }),
  Object.freeze({
    "name": "Linux shared-library loader with spaces",
    "platform": "linux",
    "fixture": "missing-runtime-library-spaced"
  }),
  Object.freeze({
    "name": "macOS dyld loader with a quoted path",
    "platform": "macos",
    "fixture": "missing-runtime-library-dyld-quoted"
  }),
  Object.freeze({
    "name": "Windows loader with a quoted path",
    "platform": "windows",
    "fixture": "missing-runtime-library-windows-quoted"
  }),
  Object.freeze({
    "name": "macOS dyld loader with a quoted long path",
    "platform": "macos",
    "fixture": "missing-runtime-library-dyld-quoted-long-path"
  }),
  Object.freeze({
    "name": "Windows loader with a quoted long path",
    "platform": "windows",
    "fixture": "missing-runtime-library-windows-quoted-long-path"
  })
]);
// END GENERATED PREVIEW LOADER EVIDENCE

// BEGIN GENERATED PREVIEW LOADER OUTPUT
export const fixtureOutput = Object.freeze({
  "missing-runtime-library": "Error: /opt/expo/react-native-devtools: error while loading shared libraries: libgtk-3.so.0: cannot open shared object file: No such file or directory\n",
  "missing-runtime-library-dyld": "dyld[12345]: Library not loaded: /opt/homebrew/lib/libgtk-3.dylib\n  Referenced from: /opt/expo/react-native-devtools\n  Reason: tried: '/opt/homebrew/lib/libgtk-3.dylib' (no such file)\n",
  "missing-runtime-library-windows": "Error: The code execution cannot proceed because libgtk-3-0.dll was not found. Reinstalling the program may fix this problem.\n",
  "missing-runtime-library-long-path": "Error: /opt/expo/react-native-devtools: error while loading shared libraries: /opt/expo/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/react-native-devtools-cache/libgtk-3.so.0: cannot open shared object file: No such file or directory\n",
  "missing-runtime-library-dyld-long-path": "dyld[12345]: Library not loaded: /opt/homebrew/Library/Application Support/Expo/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/libgtk-3.dylib\n  Referenced from: /opt/expo/react-native-devtools\n  Reason: tried: '/opt/homebrew/Library/Application Support/Expo/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/libgtk-3.dylib' (no such file)\n",
  "missing-runtime-library-windows-long-path": "Error: The code execution cannot proceed because C:\\Program Files\\Expo\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\libgtk-3-0.dll was not found. Reinstalling the program may fix this problem.\n",
  "missing-runtime-library-spaced": "Error: /opt/expo/react native devtools: error while loading shared libraries: /opt/expo/React Native DevTools/libgtk-3.so.0: cannot open shared object file: No such file or directory\nunrelated log text \u001b[31mshould not be included\u001b[0m\n",
  "missing-runtime-library-dyld-quoted": "dyld[12345]: Library not loaded: '/opt/homebrew/Library/Application Support/Expo/libgtk-3.dylib'\n  Referenced from: /opt/expo/react-native-devtools\n  unrelated log text should not be included\n",
  "missing-runtime-library-windows-quoted": "Error: The code execution cannot proceed because \"C:\\Program Files\\Expo\\React Native DevTools\\libgtk-3-0.dll\" was not found. Reinstalling the program may fix this problem.\nunrelated log text should not be included\n",
  "missing-runtime-library-dyld-quoted-long-path": "dyld[12345]: Library not loaded: '/opt/homebrew/Library/Application Support/Expo/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/libgtk-3.dylib'\n  Referenced from: /opt/expo/react-native-devtools\n  Reason: tried: '/opt/homebrew/Library/Application Support/Expo/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/react native devtools cache/libgtk-3.dylib' (no such file)\n",
  "missing-runtime-library-windows-quoted-long-path": "Error: The code execution cannot proceed because \"C:\\Program Files\\Expo\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\react native devtools cache\\libgtk-3-0.dll\" was not found. Reinstalling the program may fix this problem.\n",
  "missing-runtime-library-malformed-quotes": "dyld[12345]: Library not loaded: '/opt/homebrew/Library/Application Support/Expo/libgtk-3.dylib\" trailing unrelated loader text\n",
  "missing-runtime-library-malformed-control": "Error: /opt/expo/react-native-devtools: error while loading shared libraries: /opt/expo/libgtk-3.so.0\u0000 trailing unrelated loader text: cannot open shared object file: No such file or directory\n",
  "missing-runtime-library-malformed-trailing": "Error: The code execution cannot proceed because C:\\Program Files\\Expo\\React Native DevTools\\libgtk-3-0.dll was not found. trailing unrelated loader text\n",
  "missing-runtime-library-malformed-followed-by-valid": "dyld[12345]: Library not loaded: '/opt/homebrew/Library/Application Support/Expo/libgtk-3.dylib\" trailing unrelated loader text\ndyld[12345]: Library not loaded: /opt/homebrew/lib/libgtk-3.dylib\n",
  "unsupported-loader-wording": "React Native DevTools launcher exited with status 127\n"
});
// END GENERATED PREVIEW LOADER OUTPUT

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const fixtureName =
    process.env.PREVIEW_STARTUP_TEST_FIXTURE ?? "missing-runtime-library";
  if (
    fixtureName === "handoff-server" ||
    fixtureName === "handoff-server-stall-manifest" ||
    fixtureName === "handoff-server-stall-bundle"
  ) {
    if (process.env.PREVIEW_STARTUP_LIVE_START_MARKER) {
      appendFileSync(process.env.PREVIEW_STARTUP_LIVE_START_MARKER, "started\n");
    }
    const stallManifest = fixtureName === "handoff-server-stall-manifest";
    const stallBundle = fixtureName === "handoff-server-stall-bundle";
    const expectedExpoPlatform =
      process.env.PREVIEW_STARTUP_EXPECTED_EXPO_PLATFORM ?? "android";
    const port = Number(process.env.PORT);
    const server = createServer((request, response) => {
      if (request.headers["expo-platform"] !== expectedExpoPlatform) {
        response.statusCode = 400;
        response.end(
          `Expected expo-platform header ${expectedExpoPlatform}, received ` +
            `${request.headers["expo-platform"] ?? "missing"}`,
        );
        return;
      }

      if (request.url === "/") {
        response.writeHead(200, { "content-type": "application/json" });
        if (stallManifest) {
          response.flushHeaders();
          response.write('{"launchAsset":');
          return;
        }
        response.end(
          JSON.stringify({
            launchAsset: {
              url: "https://preview.example.test/_expo/static/js/bundle",
            },
          }),
        );
        return;
      }

      response.writeHead(200, { "content-type": "application/javascript" });
      if (stallBundle) {
        response.flushHeaders();
        response.write("console.log('partial preview validation fixture');");
        return;
      }
      response.end("console.log('preview validation fixture');");
    });

    const shutdown = () => {
      server.close();
      process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write("Starting Metro Bundler\n");
    });
  } else {
    const output =
      process.env.PREVIEW_STARTUP_TEST_OUTPUT ?? fixtureOutput[fixtureName];
    if (!output) {
      throw new Error(`Unknown preview startup fixture: ${fixtureName}`);
    }
    process.stderr.write(output);
    process.exitCode = 1;
  }
}
