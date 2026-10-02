const tsParser = process.env.ESLINT_PACKAGE_ROOT
  ? require.resolve("@typescript-eslint/parser", {
      paths: [process.env.ESLINT_PACKAGE_ROOT],
    })
  : "@typescript-eslint/parser";

module.exports = {
  root: true,
  extends: ["eslint:recommended"],
  env: {
    browser: true,
    es2021: true,
    jest: true,
    node: true,
  },
  ignorePatterns: [
    "**/node_modules/**",
    "artifacts/chat-app/static-build/**",
    "artifacts/mockup-sandbox/dist/**",
    "artifacts/mockup-sandbox/src/.generated/**",
  ],
  overrides: [
    {
      files: ["**/*.cjs"],
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "script",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    {
      files: ["**/*.{js,jsx,mjs}"],
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    {
      files: ["**/*.{ts,tsx}"],
      parser: tsParser,
      plugins: ["@typescript-eslint"],
      extends: ["plugin:@typescript-eslint/recommended"],
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    {
      files: ["**/__tests__/**/*.{ts,tsx,js,jsx}", "**/*.test.{ts,tsx,js,jsx}"],
      rules: {
        "@typescript-eslint/no-require-imports": "off",
        "@typescript-eslint/no-explicit-any": "off",
      },
    },
  ],
};
