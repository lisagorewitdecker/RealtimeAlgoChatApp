import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checkerPath = fileURLToPath(
  new URL("./check-staged-codegen-backups.mjs", import.meta.url),
);
const hookInstallerPath = fileURLToPath(
  new URL("./install-repository-git-hooks.mjs", import.meta.url),
);
const backupDirectoryPrefix = ".api-codegen-check-";

function withGitFixture(action) {
  const root = mkdtempSync(join(tmpdir(), "staged-codegen-backups-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root, env: gitEnv });
    action(root, gitEnv);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function stage(root, gitEnv, path, contents = "fixture\n") {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
  execFileSync("git", ["add", path], { cwd: root, env: gitEnv });
}

function runChecker(root, gitEnv) {
  const result = spawnSync(process.execPath, [checkerPath], {
    env: { ...gitEnv, API_CODEGEN_CHECK_WORKSPACE: root },
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function runHookInstaller(root, gitEnv, mode, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [hookInstallerPath, mode].filter(Boolean),
    {
      env: {
        ...gitEnv,
        REPOSITORY_HOOKS_WORKSPACE: root,
        ...extraEnv,
      },
      encoding: "utf8",
    },
  );
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

for (const executable of [true, false]) {
  test(`opt-in dispatcher preserves and runs an existing ${executable ? "executable" : "non-executable"} hook`, () => {
    withGitFixture((root, gitEnv) => {
      execFileSync(
        "git",
        ["config", "--local", "core.hooksPath", ".developer-hooks"],
        { cwd: root, env: gitEnv },
      );
      const hooks = join(root, ".developer-hooks");
      mkdirSync(hooks);
      mkdirSync(join(root, ".githooks"));
      writeFileSync(
        join(root, ".githooks", "pre-commit"),
        "#!/bin/sh\npnpm run validate:staged-codegen-backups\n",
        { mode: 0o755 },
      );
      const original = executable
        ? [
            "#!/usr/bin/env node",
            'const fs = require("node:fs");',
            'fs.appendFileSync("hook-runs", "developer");',
            'process.exit(process.env.FAIL_DEVELOPER === "1" ? 23 : 0);',
            "",
          ].join("\n")
        : "#!/bin/sh\nprintf developer >> hook-runs\n";
      const hook = join(hooks, "pre-commit");
      writeFileSync(hook, original, { mode: executable ? 0o755 : 0o644 });
      const originalMode = statSync(hook).mode & 0o777;

      const install = runHookInstaller(root, gitEnv, "--install-dispatcher");
      assert.equal(install.status, 0, install.output);
      assert.equal(
        runHookInstaller(root, gitEnv, "--install-dispatcher").status,
        0,
      );
      assert.equal(runHookInstaller(root, gitEnv).status, 0);
      assert.equal(
        readFileSync(join(hooks, "pre-commit.replit-preserved"), "utf8"),
        original,
      );
      assert.equal(
        statSync(join(hooks, "pre-commit.replit-preserved")).mode & 0o777,
        originalMode,
      );
      assert.match(
        readFileSync(hook, "utf8"),
        /replit-repository-hook-dispatcher/,
      );
      assert.match(
        execFileSync(
          "git",
          ["config", "--local", "--get", "replit.repositoryHooksDispatcherHash"],
          { cwd: root, env: gitEnv, encoding: "utf8" },
        ).trim(),
        /^[a-f0-9]{64}$/,
      );

      mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
      writeFileSync(
        join(root, "node_modules", ".bin", "pnpm"),
        '#!/bin/sh\nprintf repository >> hook-runs\n[ "${FAIL_REPOSITORY:-0}" -eq 0 ]\n',
        { mode: 0o755 },
      );
      const run = spawnSync(hook, {
        cwd: root,
        env: {
          ...gitEnv,
          PATH: `${join(root, "node_modules", ".bin")}:${process.env.PATH}`,
        },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
      assert.equal(
        readFileSync(join(root, "hook-runs"), "utf8"),
        executable ? "repositorydeveloper" : "repository",
      );

      rmSync(join(root, "hook-runs"));
      const failedRepositoryRun = spawnSync(hook, {
        cwd: root,
        env: {
          ...gitEnv,
          FAIL_REPOSITORY: "1",
          PATH: `${join(root, "node_modules", ".bin")}:${process.env.PATH}`,
        },
        encoding: "utf8",
      });
      assert.notEqual(failedRepositoryRun.status, 0);
      assert.equal(
        readFileSync(join(root, "hook-runs"), "utf8"),
        executable ? "repositorydeveloper" : "repository",
      );

      if (executable) {
        rmSync(join(root, "hook-runs"));
        const failedDeveloperRun = spawnSync(hook, {
          cwd: root,
          env: {
            ...gitEnv,
            FAIL_DEVELOPER: "1",
            PATH: `${join(root, "node_modules", ".bin")}:${process.env.PATH}`,
          },
          encoding: "utf8",
        });
        assert.equal(failedDeveloperRun.status, 23);
        assert.equal(
          readFileSync(join(root, "hook-runs"), "utf8"),
          "repositorydeveloper",
        );
      }

      const uninstall = runHookInstaller(
        root,
        gitEnv,
        "--uninstall-dispatcher",
      );
      assert.equal(uninstall.status, 0, uninstall.output);
      assert.notEqual(runHookInstaller(root, gitEnv).status, 0);
      assert.equal(readFileSync(hook, "utf8"), original);
      assert.equal(statSync(hook).mode & 0o777, originalMode);
      assert.equal(
        existsSync(join(hooks, "pre-commit.replit-preserved")),
        false,
      );
    });
  });
}

test("dispatcher uninstall preserves a dispatcher modified after installation", () => {
  withGitFixture((root, gitEnv) => {
    execFileSync(
      "git",
      ["config", "--local", "core.hooksPath", ".developer-hooks"],
      { cwd: root, env: gitEnv },
    );
    const hooks = join(root, ".developer-hooks");
    mkdirSync(hooks);
    mkdirSync(join(root, ".githooks"));
    writeFileSync(
      join(root, ".githooks", "pre-commit"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const hook = join(hooks, "pre-commit");
    const original = "#!/bin/sh\nprintf original\n";
    writeFileSync(hook, original, { mode: 0o755 });

    const install = runHookInstaller(root, gitEnv, "--install-dispatcher");
    assert.equal(install.status, 0, install.output);
    const modified = `${readFileSync(hook, "utf8")}# developer edit\n`;
    writeFileSync(hook, modified, { mode: 0o755 });

    const uninstall = runHookInstaller(root, gitEnv, "--uninstall-dispatcher");
    assert.notEqual(uninstall.status, 0);
    assert.match(uninstall.output, /changed after the dispatcher was installed/);
    assert.match(uninstall.output, /Preserve your edits by copying or moving/);
    assert.match(uninstall.output, /restore the original hook manually/);
    assert.equal(readFileSync(hook, "utf8"), modified);
    assert.equal(
      readFileSync(join(hooks, "pre-commit.replit-preserved"), "utf8"),
      original,
    );
  });
});

test("dispatcher uninstall keeps both hooks when restoring the original fails", () => {
  withGitFixture((root, gitEnv) => {
    execFileSync(
      "git",
      ["config", "--local", "core.hooksPath", ".developer-hooks"],
      { cwd: root, env: gitEnv },
    );
    const hooks = join(root, ".developer-hooks");
    mkdirSync(hooks);
    mkdirSync(join(root, ".githooks"));
    writeFileSync(
      join(root, ".githooks", "pre-commit"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const hook = join(hooks, "pre-commit");
    const preservedHook = join(hooks, "pre-commit.replit-preserved");
    const original = "#!/bin/sh\nprintf original\n";
    writeFileSync(hook, original, { mode: 0o755 });

    const install = runHookInstaller(root, gitEnv, "--install-dispatcher");
    assert.equal(install.status, 0, install.output);
    const dispatcher = readFileSync(hook, "utf8");
    const preload = join(root, "fail-hook-restore.mjs");
    writeFileSync(
      preload,
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const renameSync = fs.renameSync;",
        "fs.renameSync = (source, destination) => {",
        '  if (String(source).endsWith("pre-commit.replit-preserved")) {',
        '    throw Object.assign(new Error("simulated restore permission failure"), { code: "EACCES" });',
        "  }",
        "  return renameSync(source, destination);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );

    const uninstall = runHookInstaller(
      root,
      gitEnv,
      "--uninstall-dispatcher",
      { NODE_OPTIONS: `--import=${preload}` },
    );

    assert.notEqual(uninstall.status, 0);
    assert.match(uninstall.output, /Unable to restore the original pre-commit hook/);
    assert.match(uninstall.output, /active dispatcher remains/);
    assert.match(uninstall.output, /original hook remains recoverable/);
    assert.match(uninstall.output, /restore it manually/);
    assert.match(uninstall.output, /No dispatcher registration.*removed/);
    assert.equal(readFileSync(hook, "utf8"), dispatcher);
    assert.equal(readFileSync(preservedHook, "utf8"), original);
    assert.equal(
      runHookInstaller(root, gitEnv, "--uninstall-dispatcher").status,
      0,
    );
    assert.equal(readFileSync(hook, "utf8"), original);
  });
});

test("dispatcher install rollback keeps both hooks when restoring the original fails", () => {
  withGitFixture((root, gitEnv) => {
    execFileSync(
      "git",
      ["config", "--local", "core.hooksPath", ".developer-hooks"],
      { cwd: root, env: gitEnv },
    );
    const hooks = join(root, ".developer-hooks");
    mkdirSync(hooks);
    mkdirSync(join(root, ".githooks"));
    writeFileSync(
      join(root, ".githooks", "pre-commit"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const hook = join(hooks, "pre-commit");
    const preservedHook = join(hooks, "pre-commit.replit-preserved");
    const original = "#!/bin/sh\nprintf original\n";
    writeFileSync(hook, original, { mode: 0o755 });
    const preload = join(root, "fail-dispatcher-install-rollback.mjs");
    writeFileSync(
      preload,
      [
        'import childProcess from "node:child_process";',
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const spawnSync = childProcess.spawnSync;",
        "const renameSync = fs.renameSync;",
        "childProcess.spawnSync = (command, args, options) => {",
        '  if (command === "git" && args?.includes("replit.repositoryHooksDispatcher")) {',
        '    return { status: 1, stdout: "", stderr: "simulated config failure\\n" };',
        "  }",
        "  return spawnSync(command, args, options);",
        "};",
        "fs.renameSync = (source, destination) => {",
        '  if (String(source).endsWith("pre-commit.replit-preserved")) {',
        '    throw Object.assign(new Error("simulated restore permission failure"), { code: "EACCES" });',
        "  }",
        "  return renameSync(source, destination);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );

    const install = runHookInstaller(root, gitEnv, "--install-dispatcher", {
      NODE_OPTIONS: `--import=${preload}`,
    });

    assert.notEqual(install.status, 0);
    assert.match(install.output, /Dispatcher installation failed/);
    assert.match(install.output, /Unable to restore the original pre-commit hook/);
    assert.match(install.output, /active dispatcher remains/);
    assert.match(install.output, /original hook remains recoverable/);
    assert.match(install.output, /restore it manually/);
    assert.match(readFileSync(hook, "utf8"), /replit-repository-hook-dispatcher/);
    assert.equal(readFileSync(preservedHook, "utf8"), original);
  });
});

for (const failure of ["registration directory", "Git config"]) {
  test(`dispatcher uninstall retries cleanup after a ${failure} failure`, () => {
    withGitFixture((root, gitEnv) => {
      execFileSync(
        "git",
        ["config", "--local", "core.hooksPath", ".developer-hooks"],
        { cwd: root, env: gitEnv },
      );
      const hooks = join(root, ".developer-hooks");
      mkdirSync(hooks);
      mkdirSync(join(root, ".githooks"));
      writeFileSync(join(root, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      const hook = join(hooks, "pre-commit");
      const original = "#!/bin/sh\nprintf original\n";
      writeFileSync(hook, original, { mode: 0o755 });

      const install = runHookInstaller(root, gitEnv, "--install-dispatcher");
      assert.equal(install.status, 0, install.output);
      const preload = join(root, "fail-hook-cleanup.mjs");
      writeFileSync(
        preload,
        failure === "registration directory"
          ? [
              'import fs from "node:fs";',
              'import { syncBuiltinESMExports } from "node:module";',
              "const rmSync = fs.rmSync;",
              "fs.rmSync = (path, options) => {",
              '  if (String(path).endsWith(".replit-repository-hooks") && options?.recursive) {',
              '    throw Object.assign(new Error("simulated directory permission failure"), { code: "EACCES" });',
              "  }",
              "  return rmSync(path, options);",
              "};",
              "syncBuiltinESMExports();",
              "",
            ].join("\n")
          : [
              'import childProcess from "node:child_process";',
              'import { syncBuiltinESMExports } from "node:module";',
              "const spawnSync = childProcess.spawnSync;",
              "childProcess.spawnSync = (command, args, options) => {",
              '  if (command === "git" && args?.includes("--unset") && args?.includes("replit.repositoryHooksDispatcherHash")) {',
              '    return { status: 1, stdout: "", stderr: "simulated Git config lock failure\\n" };',
              "  }",
              "  return spawnSync(command, args, options);",
              "};",
              "syncBuiltinESMExports();",
              "",
            ].join("\n"),
      );

      const uninstall = runHookInstaller(
        root,
        gitEnv,
        "--uninstall-dispatcher",
        { NODE_OPTIONS: `--import=${preload}` },
      );
      assert.notEqual(uninstall.status, 0);
      assert.match(uninstall.output, /original pre-commit hook is already restored/);
      assert.match(uninstall.output, new RegExp(failure));
      assert.match(uninstall.output, /Remove it manually with:/);
      assert.match(uninstall.output, /safely retry/);
      assert.match(uninstall.output, /does not replace the restored developer hook/);
      assert.equal(readFileSync(hook, "utf8"), original);

      const retry = runHookInstaller(
        root,
        gitEnv,
        "--uninstall-dispatcher",
      );
      assert.equal(retry.status, 0, retry.output);
      assert.match(retry.output, /hook .* was left unchanged/);
      assert.equal(readFileSync(hook, "utf8"), original);
      assert.equal(existsSync(join(hooks, ".replit-repository-hooks")), false);
    });
  });
}

test("rejects a staged root-level recovery directory with recovery-first guidance", () => {
  withGitFixture((root, gitEnv) => {
    stage(root, gitEnv, `${backupDirectoryPrefix}recovery/generated.ts`);

    const result = runChecker(root, gitEnv);

    assert.notEqual(result.status, 0);
    assert.match(result.output, /recovery backup directories are staged:/);
    assert.match(result.output, /\.api-codegen-check-recovery/);
    assert.match(
      result.output,
      /may contain the only recovery copy of local generated-client edits/,
    );
    assert.match(
      result.output,
      /Review and recover any needed files, then remove the backup folders from the workspace and Git staging/,
    );
  });
});

test("allows ordinary staged files", () => {
  withGitFixture((root, gitEnv) => {
    stage(root, gitEnv, "ordinary-file.txt");
    assert.equal(runChecker(root, gitEnv).status, 0);
  });
});

test("allows the backup prefix below a normal root directory", () => {
  withGitFixture((root, gitEnv) => {
    stage(root, gitEnv, `fixtures/${backupDirectoryPrefix}example/file.txt`);
    assert.equal(runChecker(root, gitEnv).status, 0);
  });
});

test("keeps recovery backup directories visible to git status", () => {
  const gitignore = readFileSync(
    new URL("../../../.gitignore", import.meta.url),
    "utf8",
  );
  assert.equal(gitignore.includes(backupDirectoryPrefix), false);
});

test("fresh clones install and run the staged-backup repository pre-commit hook", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const hook = readFileSync(
    new URL("../../../.githooks/pre-commit", import.meta.url),
    "utf8",
  );

  withGitFixture((root, gitEnv) => {
    assert.equal(runHookInstaller(root, gitEnv).status, 0);
    assert.equal(
      execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
        cwd: root,
        env: gitEnv,
        encoding: "utf8",
      }).trim(),
      ".githooks",
    );
  });

  assert.equal(
    packageJson.scripts.prepare,
    "node lib/api-spec/scripts/install-repository-git-hooks.mjs",
  );
  assert.equal(
    packageJson.scripts["validate:staged-codegen-backups"],
    "node lib/api-spec/scripts/check-staged-codegen-backups.mjs",
  );
  assert.match(hook, /pnpm run validate:staged-codegen-backups/);
});

test("preconfigured custom hooks are preserved and setup succeeds after chaining is acknowledged", () => {
  withGitFixture((root, gitEnv) => {
    execFileSync(
      "git",
      ["config", "--local", "core.hooksPath", ".developer-hooks"],
      { cwd: root, env: gitEnv },
    );

    const result = runHookInstaller(root, gitEnv);

    assert.notEqual(result.status, 0);
    assert.equal(
      execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
        cwd: root,
        env: gitEnv,
        encoding: "utf8",
      }).trim(),
      ".developer-hooks",
    );
    assert.match(result.output, /left that configuration unchanged/);
    assert.match(result.output, /Chain "\.githooks\/pre-commit"/);
    assert.match(result.output, /pnpm run validate:staged-codegen-backups/);
    assert.match(
      result.output,
      /git config --local replit\.repositoryHooksChained true/,
    );

    execFileSync(
      "git",
      ["config", "--local", "replit.repositoryHooksChained", "true"],
      { cwd: root, env: gitEnv },
    );

    const subsequentResult = runHookInstaller(root, gitEnv);
    assert.equal(subsequentResult.status, 0);
    assert.equal(subsequentResult.output, "");
    assert.equal(
      execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
        cwd: root,
        env: gitEnv,
        encoding: "utf8",
      }).trim(),
      ".developer-hooks",
    );
  });
});

test("globally configured custom hooks are preserved without a local override", () => {
  withGitFixture((root, gitEnv) => {
    execFileSync(
      "git",
      ["config", "--global", "core.hooksPath", ".developer-global-hooks"],
      { cwd: root, env: gitEnv },
    );

    const result = runHookInstaller(root, gitEnv);

    assert.notEqual(result.status, 0);
    assert.match(
      result.output,
      /Git hooks are already configured at "\.developer-global-hooks"/,
    );
    assert.match(result.output, /left that configuration unchanged/);
    assert.match(result.output, /Chain "\.githooks\/pre-commit"/);

    const install = runHookInstaller(root, gitEnv, "--install-dispatcher");
    assert.equal(install.status, 0, install.output);
    assert.equal(
      existsSync(join(root, ".developer-global-hooks", "pre-commit")),
      true,
    );

    const localConfig = spawnSync(
      "git",
      ["config", "--local", "--get", "core.hooksPath"],
      { cwd: root, env: gitEnv, encoding: "utf8" },
    );
    assert.equal(localConfig.status, 1);
    assert.equal(localConfig.stdout, "");
  });
});

test("two repositories independently share a global hooks dispatcher", () => {
  const fixture = mkdtempSync(join(tmpdir(), "shared-repository-hooks-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(fixture, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const first = join(fixture, "first");
  const second = join(fixture, "second");
  const unrelated = join(fixture, "unrelated");
  const hooks = join(fixture, "shared-hooks");
  try {
    for (const repository of [first, second, unrelated]) {
      mkdirSync(repository);
      execFileSync("git", ["init", "--quiet"], {
        cwd: repository,
        env: gitEnv,
      });
    }
    execFileSync("git", ["config", "--global", "core.hooksPath", hooks], {
      cwd: fixture,
      env: gitEnv,
    });
    mkdirSync(hooks);
    const original = '#!/bin/sh\nprintf shared >> "$SHARED_RUNS"\n';
    writeFileSync(join(hooks, "pre-commit"), original, { mode: 0o755 });

    for (const [repository, label] of [
      [first, "first"],
      [second, "second"],
    ]) {
      mkdirSync(join(repository, ".githooks"));
      writeFileSync(
        join(repository, ".githooks", "pre-commit"),
        `#!/bin/sh\nprintf ${label} >> "$REPOSITORY_RUNS"\n`,
        { mode: 0o755 },
      );
      const install = runHookInstaller(
        repository,
        gitEnv,
        "--install-dispatcher",
      );
      assert.equal(install.status, 0, install.output);
    }

    const hook = join(hooks, "pre-commit");
    const repositoryRuns = join(fixture, "repository-runs");
    const sharedRuns = join(fixture, "shared-runs");
    for (const repository of [first, second, unrelated]) {
      const run = spawnSync(hook, {
        cwd: repository,
        env: {
          ...gitEnv,
          REPOSITORY_RUNS: repositoryRuns,
          SHARED_RUNS: sharedRuns,
        },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    }
    assert.equal(readFileSync(repositoryRuns, "utf8"), "firstsecond");
    assert.equal(readFileSync(sharedRuns, "utf8"), "sharedsharedshared");

    const uninstallFirst = runHookInstaller(
      first,
      gitEnv,
      "--uninstall-dispatcher",
    );
    assert.equal(uninstallFirst.status, 0, uninstallFirst.output);
    assert.match(
      readFileSync(hook, "utf8"),
      /replit-repository-hook-dispatcher/,
    );

    rmSync(repositoryRuns);
    for (const repository of [first, second]) {
      const run = spawnSync(hook, {
        cwd: repository,
        env: {
          ...gitEnv,
          REPOSITORY_RUNS: repositoryRuns,
          SHARED_RUNS: sharedRuns,
        },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    }
    assert.equal(readFileSync(repositoryRuns, "utf8"), "second");

    const uninstallSecond = runHookInstaller(
      second,
      gitEnv,
      "--uninstall-dispatcher",
    );
    assert.equal(uninstallSecond.status, 0, uninstallSecond.output);
    assert.equal(readFileSync(hook, "utf8"), original);
    assert.equal(existsSync(join(hooks, "pre-commit.replit-preserved")), false);
    assert.equal(existsSync(join(hooks, ".replit-repository-hooks")), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("repository-matched conditional hook includes are preserved without a local override", () => {
  withGitFixture((root, gitEnv) => {
    const includedConfig = join(root, "repository-hooks.gitconfig");
    execFileSync(
      "git",
      [
        "config",
        "--file",
        gitEnv.GIT_CONFIG_GLOBAL,
        `includeIf.gitdir:${root}/.path`,
        includedConfig,
      ],
      { cwd: root, env: gitEnv },
    );
    execFileSync(
      "git",
      [
        "config",
        "--file",
        includedConfig,
        "core.hooksPath",
        ".developer-conditional-hooks",
      ],
      { cwd: root, env: gitEnv },
    );

    assert.equal(
      execFileSync("git", ["config", "--get", "core.hooksPath"], {
        cwd: root,
        env: gitEnv,
        encoding: "utf8",
      }).trim(),
      ".developer-conditional-hooks",
    );

    const result = runHookInstaller(root, gitEnv);

    assert.notEqual(result.status, 0);
    assert.match(
      result.output,
      /Git hooks are already configured at "\.developer-conditional-hooks"/,
    );
    assert.match(result.output, /left that configuration unchanged/);
    assert.match(result.output, /Chain "\.githooks\/pre-commit"/);

    const localConfig = spawnSync(
      "git",
      ["config", "--local", "--get", "core.hooksPath"],
      { cwd: root, env: gitEnv, encoding: "utf8" },
    );
    assert.equal(localConfig.status, 1);
    assert.equal(localConfig.stdout, "");
  });
});
