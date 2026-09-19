// Runs after the test framework is installed, so the testing library's
// expect matchers can load. Provider startup (key generation, secure storage,
// registration) can exceed the library's 1s waitFor default when the project's
// validation checks share a starved CPU. Polling stops as soon as an expectation
// passes, so healthy runs are unaffected.
require("@testing-library/react-native").configure({ asyncUtilTimeout: 15_000 });

const originalConsoleError = console.error;
var expectedConsoleErrors = [];
var unexpectedConsoleErrors = [];

var formatConsoleArguments = (args) =>
  args
    .map((value) => {
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");

var consoleArgumentMatches = (expected, actual) => {
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(String(actual));
  }
  if (Object.is(expected, actual)) return true;
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object"
  ) {
    try {
      return JSON.stringify(expected) === JSON.stringify(actual);
    } catch {
      return false;
    }
  }
  return false;
};

// Register one exact console.error call. Matching the complete argument list
// keeps an intentional application error from masking an unrelated React
// warning emitted by the same test.
global.expectConsoleError = (...expectedArgs) => {
  expectedConsoleErrors.push(expectedArgs);
};

beforeEach(() => {
  expectedConsoleErrors = [];
  unexpectedConsoleErrors = [];
  console.error = (...actualArgs) => {
    var expectedIndex = expectedConsoleErrors.findIndex(
      (expectedArgs) =>
        expectedArgs.length === actualArgs.length &&
        expectedArgs.every((expected, index) =>
          consoleArgumentMatches(expected, actualArgs[index]),
        ),
    );

    if (expectedIndex >= 0) {
      expectedConsoleErrors.splice(expectedIndex, 1);
      return;
    }

    unexpectedConsoleErrors.push(actualArgs);
  };
});

afterEach(() => {
  console.error = originalConsoleError;

  var failures = [];
  if (unexpectedConsoleErrors.length > 0) {
    failures.push(
      `Unexpected console.error calls:\n${unexpectedConsoleErrors
        .map((args) => `  - ${formatConsoleArguments(args)}`)
        .join("\n")}`,
    );
  }
  if (expectedConsoleErrors.length > 0) {
    failures.push(
      `Expected console.error calls were not observed:\n${expectedConsoleErrors
        .map((args) => `  - ${formatConsoleArguments(args)}`)
        .join("\n")}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n\n"));
  }
});
