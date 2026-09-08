import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    // Support the "workspace" custom condition used by workspace packages.
    conditions: ["workspace", "node", "import", "require"],
  },
});