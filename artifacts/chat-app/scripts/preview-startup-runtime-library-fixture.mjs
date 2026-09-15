const fixtureOutput = {
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
};
const fixtureName =
  process.env.PREVIEW_STARTUP_TEST_FIXTURE ?? "missing-runtime-library";
const output = fixtureOutput[fixtureName];
if (!output) {
  throw new Error(`Unknown preview startup fixture: ${fixtureName}`);
}
process.stderr.write(output);
process.exitCode = 1;