// Runs after the test framework is installed, so the testing library's
// expect matchers can load. Provider startup (key generation, secure storage,
// registration) can exceed the library's 1s waitFor default when the project's
// validation checks share a starved CPU. Polling stops as soon as an expectation
// passes, so healthy runs are unaffected.
require("@testing-library/react-native").configure({ asyncUtilTimeout: 15_000 });
