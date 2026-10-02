import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const generatedFiles = [
  "lib/api-client-react/src/generated/api.schemas.ts",
  "lib/api-client-react/src/generated/api.ts",
  "lib/api-zod/src/generated/api.ts",
  "lib/api-zod/src/index.ts",
];

const generatedApiWildcardExport =
  /^\s*export\s+\*\s+from\s+["']\.\/generated\/api["'];\s*$/;

export function normalizeZodIndex(content) {
  return (
    content
      .split(/\r?\n/)
      .filter((line) => !generatedApiWildcardExport.test(line))
      .join("\n")
      .trimEnd() + "\n"
  );
}

async function main() {
  for (const relativePath of generatedFiles) {
    const filePath = new URL(`../../../${relativePath}`, import.meta.url);
    let content = await readFile(filePath, "utf8");

    if (relativePath === "lib/api-zod/src/generated/api.ts") {
      content = content.replace(
        "import * as zod from 'zod';",
        "import * as zod from 'zod/v4';",
      );
    } else if (relativePath === "lib/api-zod/src/index.ts") {
      content = normalizeZodIndex(content);
    }

    await writeFile(filePath, `${content.trimEnd()}\n`);
  }

  console.log(`Post-processed generated API files in ${workspaceRoot}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}