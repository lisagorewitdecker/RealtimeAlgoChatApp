import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStableReactResolutions,
  inspectReactResolutions,
} from "./validate-mockup-clean.mjs";

function dependency(name, version, path, dependencies = {}) {
  return {
    [name]: {
      version,
      path,
      dependencies,
    },
  };
}

test("accepts one React runtime and type resolution", () => {
  const listOutput = [
    {
      devDependencies: {
        ...dependency("react", "19.1.0", "/store/react-19.1.0"),
        ...dependency("react-dom", "19.1.0", "/store/react-dom-19.1.0", {
          ...dependency("react", "19.1.0", "/store/react-19.1.0"),
        }),
        ...dependency("@types/react", "19.2.18", "/store/types-react-19.2.18"),
        ...dependency(
          "@types/react-dom",
          "19.2.5",
          "/store/types-react-dom-19.2.5",
          {
            ...dependency(
              "@types/react",
              "19.2.18",
              "/store/types-react-19.2.18",
            ),
          },
        ),
      },
    },
  ];

  assert.doesNotThrow(() =>
    assertStableReactResolutions(inspectReactResolutions(listOutput)),
  );
});

test("reports actionable React type resolution drift", () => {
  const listOutput = [
    {
      devDependencies: {
        ...dependency("react", "19.1.0", "/store/react-19.1.0"),
        ...dependency("react-dom", "19.1.0", "/store/react-dom-19.1.0"),
        ...dependency("@types/react", "19.2.18", "/store/types-react-19.2.18"),
        ...dependency(
          "@types/react-dom",
          "19.2.5",
          "/store/types-react-dom-19.2.5",
          {
            ...dependency(
              "@types/react",
              "19.1.17",
              "/store/types-react-19.1.17",
            ),
          },
        ),
      },
    },
  ];

  assert.throws(
    () => assertStableReactResolutions(inspectReactResolutions(listOutput)),
    (error) => {
      assert.equal(error.name, "ReactResolutionDriftError");
      assert.match(error.message, /@types\/react: 19\.1\.17, 19\.2\.18/);
      assert.match(error.message, /regenerate pnpm-lock\.yaml/);
      return true;
    },
  );
});
