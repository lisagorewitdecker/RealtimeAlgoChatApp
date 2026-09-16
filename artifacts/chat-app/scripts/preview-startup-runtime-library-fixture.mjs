import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const CAPTURED_EXPO_TOOLING = Object.freeze({
  expoCli: "57.0.20",
  reactNative: "0.86.3",
});

export const CAPTURED_LOADER_SAMPLES = Object.freeze([
  Object.freeze({
    name: "Linux shared-library loader",
    fixture: "missing-runtime-library",
  }),
  Object.freeze({
    name: "macOS dyld loader",
    fixture: "missing-runtime-library-dyld",
  }),
  Object.freeze({
    name: "Windows loader",
    fixture: "missing-runtime-library-windows",
  }),
  Object.freeze({
    name: "Linux shared-library loader with a long path",
    fixture: "missing-runtime-library-long-path",
  }),
  Object.freeze({
    name: "macOS dyld loader with a long path",
    fixture: "missing-runtime-library-dyld-long-path",
  }),
  Object.freeze({
    name: "Windows loader with a long path",
    fixture: "missing-runtime-library-windows-long-path",
  }),
]);

const longLinuxLibraryPath =
  `/opt/expo/${"react-native-devtools-cache/".repeat(16)}` +
  "libgtk-3.so.0";
const longDyldLibraryPath =
  `/opt/homebrew/Library/Application Support/Expo/` +
  `${"react native devtools cache/".repeat(12)}` +
  "libgtk-3.dylib";
const longWindowsLibraryPath =
  `C:\\Program Files\\Expo\\${"react native devtools cache\\".repeat(12)}` +
  "libgtk-3-0.dll";

export const fixtureOutput = Object.freeze({
  "missing-runtime-library":
    "Error: /opt/expo/react-native-devtools: error while loading shared " +
    "libraries: libgtk-3.so.0: cannot open shared object file: No such file " +
    "or directory\n",
  "missing-runtime-library-dyld":
    "dyld[12345]: Library not loaded: /opt/homebrew/lib/libgtk-3.dylib\n" +
    "  Referenced from: /opt/expo/react-native-devtools\n" +
    "  Reason: tried: '/opt/homebrew/lib/libgtk-3.dylib' (no such file)\n",
  "missing-runtime-library-windows":
    "Error: The code execution cannot proceed because libgtk-3-0.dll was " +
    "not found. Reinstalling the program may fix this problem.\n",
  "missing-runtime-library-long-path":
    `Error: /opt/expo/react-native-devtools: error while loading shared ` +
    `libraries: ${longLinuxLibraryPath}: cannot open shared object file: ` +
    "No such file or directory\n",
  "missing-runtime-library-dyld-long-path":
    `dyld[12345]: Library not loaded: ${longDyldLibraryPath}\n` +
    "  Referenced from: /opt/expo/react-native-devtools\n" +
    `  Reason: tried: '${longDyldLibraryPath}' (no such file)\n`,
  "missing-runtime-library-windows-long-path":
    `Error: The code execution cannot proceed because ${longWindowsLibraryPath} ` +
    "was not found. Reinstalling the program may fix this problem.\n",
  "unsupported-loader-wording":
    "React Native DevTools launcher exited with status 127\n",
});
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixtureName =
    process.env.PREVIEW_STARTUP_TEST_FIXTURE ?? "missing-runtime-library";
  if (
    fixtureName === "handoff-server" ||
    fixtureName === "handoff-server-stall-manifest" ||
    fixtureName === "handoff-server-stall-bundle"
  ) {
    const stallManifest = fixtureName === "handoff-server-stall-manifest";
    const stallBundle = fixtureName === "handoff-server-stall-bundle";
    const port = Number(process.env.PORT);
    const server = createServer((request, response) => {
      if (request.url === "/") {
        if (stallManifest) return;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            launchAsset: {
              url: "https://preview.example.test/_expo/static/js/bundle",
            },
          }),
        );
        return;
      }

      if (stallBundle) return;
      response.setHeader("content-type", "application/javascript");
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
    const output = fixtureOutput[fixtureName];
    if (!output) {
      throw new Error(`Unknown preview startup fixture: ${fixtureName}`);
    }
    process.stderr.write(output);
    process.exitCode = 1;
  }
}
