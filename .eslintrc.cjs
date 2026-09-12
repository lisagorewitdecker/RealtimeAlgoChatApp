const tsParser = process.env.ESLINT_PACKAGE_ROOT
  ? require.resolve("@typescript-eslint/parser", {
      paths: [process.env.ESLINT_PACKAGE_ROOT],
    })
  : "@typescript-eslint/parser";

module.exports = {
  root: true,
  ignorePatterns: [
    "**/node_modules/**",
    "artifacts/chat-app/static-build/**",
    "artifacts/mockup-sandbox/src/.generated/**",
  ],
  overrides: [
    {
      files: ["**/*.{js,jsx,mjs,cjs}"],
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
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
  ],
};
