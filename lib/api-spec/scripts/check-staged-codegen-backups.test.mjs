import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  execFileSync("git", ["init", "--quiet"], { cwd: root, env: gitEnv });
  try {
    const result = action(root, gitEnv);
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        rmSync(root, { recursive: true, force: true });
      });
    }
    rmSync(root, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function stage(root, gitEnv, path, contents = "fixture\n") {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
  execFileSync("git", ["add", path], { cwd: root, env: gitEnv });
}

function runChecker(root, gitEnv, { enableTestWorkspace = true } = {}) {
  const result = spawnSync(
    process.execPath,
    [
      checkerPath,
      ...(enableTestWorkspace ? ["--enable-test-workspace"] : []),
    ],
    {
      env: { ...gitEnv, API_CODEGEN_CHECK_WORKSPACE: root },
      encoding: "utf8",
    },
  );
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function runCheckerWithoutWorkspaceOverride(gitEnv) {
  const env = { ...gitEnv };
  delete env.API_CODEGEN_CHECK_WORKSPACE;
  const result = spawnSync(process.execPath, [checkerPath], {
    env,
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function runCheckerFromWorkingDirectory(cwd, gitEnv, workspaceOverride) {
  const result = spawnSync(process.execPath, [checkerPath], {
    cwd,
    env: {
      ...gitEnv,
      API_CODEGEN_CHECK_WORKSPACE: workspaceOverride,
    },
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function runCommit(root, gitEnv, extraEnv = {}) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=staged-codegen-backups-fixture",
      "-c",
      "user.email=staged-codegen-backups-fixture@example.com",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    {
      cwd: root,
      env: { ...gitEnv, ...extraEnv },
      encoding: "utf8",
    },
  );
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function installRepositoryHookFixture(root, gitEnv) {
  const scripts = join(root, "lib", "api-spec", "scripts");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, ".githooks"));
  copyFileSync(
    fileURLToPath(new URL("../../../.githooks/pre-commit", import.meta.url)),
    join(root, ".githooks", "pre-commit"),
  );
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      scripts: {
        "validate:staged-codegen-backups":
          "node lib/api-spec/scripts/check-staged-codegen-backups.mjs",
      },
    })}\n`,
  );
  for (const script of [
    "check-staged-codegen-backups.mjs",
    "codegen-check-workspace.mjs",
    "staged-codegen-backups.mjs",
  ]) {
    copyFileSync(
      fileURLToPath(new URL(`./${script}`, import.meta.url)),
      join(scripts, script),
    );
  }
  execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
    cwd: root,
    env: gitEnv,
  });
}

function runHookInstaller(root, gitEnv, mode, extraEnv = {}) {
  const args = Array.isArray(mode) ? mode : [mode].filter(Boolean);
  const result = spawnSync(
    process.execPath,
    [hookInstallerPath, ...args],
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

function runHookInstallerAsync(root, gitEnv, mode, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookInstallerPath, mode], {
      env: {
        ...gitEnv,
        REPOSITORY_HOOKS_WORKSPACE: root,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

async function waitForPath(path, timeoutMilliseconds = 2_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for fixture path "${path}".`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function dispatcherStateSnapshot(root, gitEnv, hooks) {
  const files = existsSync(hooks)
    ? readdirSync(hooks, { recursive: true })
        .sort()
        .map((name) => {
          const path = join(hooks, name);
          const stat = statSync(path);
          return stat.isDirectory()
            ? { name, directory: true, mode: stat.mode & 0o777 }
            : {
                name,
                content: readFileSync(path, "base64"),
                mode: stat.mode & 0o777,
              };
        })
    : [];
  const config = execFileSync("git", ["config", "--local", "--list"], {
    cwd: root,
    env: gitEnv,
    encoding: "utf8",
  });
  return { files, config };
}

function assertStatusIsReadOnly(root, gitEnv, hooks, assertions) {
  const before = dispatcherStateSnapshot(root, gitEnv, hooks);
  const status = runHookInstaller(root, gitEnv, "--dispatcher-status");
  assert.equal(status.status, 0, status.output);
  assertions(status.output);
  assert.deepEqual(dispatcherStateSnapshot(root, gitEnv, hooks), before);
}

function assertJsonStatusIsReadOnly(root, gitEnv, hooks, assertions) {
  const before = dispatcherStateSnapshot(root, gitEnv, hooks);
  const status = runHookInstaller(
    root,
    gitEnv,
    ["--dispatcher-status", "--json"],
  );
  assert.equal(status.status, 0, status.output);
  assertions(JSON.parse(status.output));
  assert.deepEqual(dispatcherStateSnapshot(root, gitEnv, hooks), before);
}

test("dispatcher status does not configure hooks when core.hooksPath is unset", () => {
  withGitFixture((root, gitEnv) => {
    const hooks = join(root, ".git", "hooks");

    assertStatusIsReadOnly(root, gitEnv, hooks, (output) => {
      assert.match(output, new RegExp(`Repository: "${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(output, /Active pre-commit hook: absent/);
      assert.match(output, /Repository registration file: absent/);
      assert.match(output, /repositoryHooksDispatcher: absent/);
      assert.match(output, /repositoryHooksDispatcherHash: absent/);
      assert.match(output, /Consistency: clean/);
      assert.match(output, /No dispatcher installation or cleanup records remain/);
    });

    const configured = spawnSync(
      "git",
      ["config", "--local", "--get", "core.hooksPath"],
      { cwd: root, env: gitEnv, encoding: "utf8" },
    );
    assert.equal(configured.status, 1);
  });
});

test("dispatcher JSON status exposes the structured clean-state contract without changes", () => {
  withGitFixture((root, gitEnv) => {
    const hooks = join(root, ".git", "hooks");

    assertJsonStatusIsReadOnly(root, gitEnv, hooks, (status) => {
      assert.deepEqual(status, {
        repository: root,
        activeHook: {
          state: "absent",
          path: join(hooks, "pre-commit"),
        },
        preservedHook: {
          present: false,
          path: join(hooks, "pre-commit.replit-preserved"),
        },
        repositoryRegistration: {
          present: false,
          path: status.repositoryRegistration.path,
        },
        gitConfig: {
          "replit.repositoryHooksDispatcher": [],
          "replit.repositoryHooksDispatcherHash": null,
        },
        consistency: "clean",
        warnings: [],
        guidance: "No dispatcher installation or cleanup records remain.",
      });
      assert.match(
        status.repositoryRegistration.path,
        new RegExp(
          `${hooks.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[/\\\\]\\.replit-repository-hooks[/\\\\][a-f0-9]{64}\\.sh$`,
        ),
      );
    });
  });
});

test("dispatcher status warns about an orphaned preserved developer hook without changes", () => {
  withGitFixture((root, gitEnv) => {
    const hooks = join(root, ".git", "hooks");
    const preservedHook = join(hooks, "pre-commit.replit-preserved");
    writeFileSync(preservedHook, "#!/bin/sh\nprintf preserved\n", { mode: 0o755 });

    assertStatusIsReadOnly(root, gitEnv, hooks, (output) => {
      assert.match(output, /Preserved developer hook: present/);
      assert.match(output, /Consistency: inconsistent/);
      assert.match(output, /preserved developer hook remains/);
      assert.match(output, /status made no changes/);
    });
  });
});

test(
  "dispatcher status reports clean, installed, and partially cleaned states without changes",
  () => {
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

      assertStatusIsReadOnly(root, gitEnv, hooks, (output) => {
        assert.match(output, /Active pre-commit hook: absent/);
        assert.match(output, /Repository registration file: absent/);
        assert.match(output, /repositoryHooksDispatcher: absent/);
        assert.match(output, /repositoryHooksDispatcherHash: absent/);
        assert.match(output, /Consistency: clean/);
      });

      const developerHook = "#!/bin/sh\nprintf developer\n";
      writeFileSync(join(hooks, "pre-commit"), developerHook, { mode: 0o755 });
      const install = runHookInstaller(root, gitEnv, "--install-dispatcher");
      assert.equal(install.status, 0, install.output);
      assertStatusIsReadOnly(root, gitEnv, hooks, (output) => {
        assert.match(output, /Active pre-commit hook: dispatcher/);
        assert.match(output, /Preserved developer hook: present/);
        assert.match(output, /Repository registration file: present/);
        assert.match(output, /repositoryHooksDispatcher: "/);
        assert.match(output, /repositoryHooksDispatcherHash: "[a-f0-9]{64}"/);
        assert.match(output, /Consistency: installed/);
      });
      assertJsonStatusIsReadOnly(root, gitEnv, hooks, (status) => {
        assert.deepEqual(status.activeHook, {
          state: "dispatcher",
          path: join(hooks, "pre-commit"),
        });
        assert.deepEqual(status.preservedHook, {
          present: true,
          path: join(hooks, "pre-commit.replit-preserved"),
        });
        assert.equal(status.repositoryRegistration.present, true);
        assert.deepEqual(
          status.gitConfig["replit.repositoryHooksDispatcher"],
          [status.repositoryRegistration.path],
        );
        assert.match(
          status.gitConfig["replit.repositoryHooksDispatcherHash"],
          /^[a-f0-9]{64}$/,
        );
        assert.equal(status.consistency, "installed");
        assert.deepEqual(status.warnings, []);
      });

      const registrationPath = execFileSync(
        "git",
        ["config", "--local", "--get", "replit.repositoryHooksDispatcher"],
        { cwd: root, env: gitEnv, encoding: "utf8" },
      ).trim();
      rmSync(join(hooks, "pre-commit.replit-preserved"));
      writeFileSync(join(hooks, "pre-commit"), developerHook, { mode: 0o755 });
      assertStatusIsReadOnly(root, gitEnv, hooks, (output) => {
        assert.match(output, /Active pre-commit hook: developer hook/);
        assert.match(output, /Preserved developer hook: absent/);
        assert.match(output, /Repository registration file: present/);
        assert.match(
          output,
          new RegExp(
            registrationPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          ),
        );
        assert.match(output, /Consistency: partially cleaned/);
        assert.match(output, /Dispatcher cleanup is incomplete/);
        assert.match(output, /retry cleanup with "pnpm run hooks:dispatcher:uninstall"/);
      });
    });
  },
);

test("dispatcher status identifies this repository in a shared dispatcher without changes", () => {
  const fixture = mkdtempSync(join(tmpdir(), "shared-dispatcher-status-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(fixture, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const first = join(fixture, "first");
  const second = join(fixture, "second");
  const hooks = join(fixture, "shared-hooks");
  try {
    for (const repository of [first, second]) {
      mkdirSync(repository);
      execFileSync("git", ["init", "--quiet"], {
        cwd: repository,
        env: gitEnv,
      });
      mkdirSync(join(repository, ".githooks"));
      writeFileSync(
        join(repository, ".githooks", "pre-commit"),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o755 },
      );
    }
    execFileSync("git", ["config", "--global", "core.hooksPath", hooks], {
      cwd: fixture,
      env: gitEnv,
    });
    assert.equal(runHookInstaller(first, gitEnv, "--install-dispatcher").status, 0);
    assert.equal(runHookInstaller(second, gitEnv, "--install-dispatcher").status, 0);

    assertStatusIsReadOnly(first, gitEnv, hooks, (output) => {
      assert.match(output, /Active pre-commit hook: dispatcher/);
      assert.match(output, /Repository registration file: present/);
      assert.match(
        output,
        new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.match(output, /Consistency: shared/);
      assert.match(output, /consistently registered with a shared dispatcher/);
    });

    const firstRegistration = execFileSync(
      "git",
      ["config", "--local", "--get", "replit.repositoryHooksDispatcher"],
      { cwd: first, env: gitEnv, encoding: "utf8" },
    ).trim();
    rmSync(firstRegistration);
    assertStatusIsReadOnly(first, gitEnv, hooks, (output) => {
      assert.match(output, /Consistency: inconsistent/);
      assert.match(output, /no registration file for this repository/);
      assert.match(output, /repository hook will not run/);
      assert.match(output, /status made no changes/);
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("dispatcher status warns about mismatched registration records, missing hashes, and edited content", () => {
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
    assert.equal(
      runHookInstaller(root, gitEnv, "--install-dispatcher").status,
      0,
    );
    const hook = join(hooks, "pre-commit");
    const registrationPath = execFileSync(
      "git",
      ["config", "--local", "--get", "replit.repositoryHooksDispatcher"],
      { cwd: root, env: gitEnv, encoding: "utf8" },
    ).trim();

    execFileSync(
      "git",
      ["config", "--local", "--unset", "replit.repositoryHooksDispatcherHash"],
      { cwd: root, env: gitEnv },
    );
    execFileSync(
      "git",
      ["config", "--local", "--replace-all", "replit.repositoryHooksDispatcher", `${registrationPath}.wrong`],
      { cwd: root, env: gitEnv },
    );
    assertStatusIsReadOnly(root, gitEnv, hooks, (output) => {
      assert.match(output, /Consistency: inconsistent/);
      assert.match(output, /registration file is not listed in Git config/);
      assert.match(output, /lists a missing registration file/);
      assert.match(output, /dispatcher hash record is missing/i);
      assert.match(output, /status made no changes/);
    });

    execFileSync(
      "git",
      ["config", "--local", "--replace-all", "replit.repositoryHooksDispatcher", registrationPath],
      { cwd: root, env: gitEnv },
    );
    execFileSync(
      "git",
      ["config", "--local", "replit.repositoryHooksDispatcherHash", "0".repeat(64)],
      { cwd: root, env: gitEnv },
    );
    writeFileSync(hook, `${readFileSync(hook, "utf8")}# edited\n`, { mode: 0o755 });
    assertStatusIsReadOnly(root, gitEnv, hooks, (output) => {
      assert.match(output, /Consistency: inconsistent/);
      assert.match(output, /content does not match its recorded hash/);
      assert.match(output, /preserve any edits before recovery/);
    });
  });
});

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

test("dispatcher install rollback restores the hook when registration cleanup fails", () => {
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
    const preservedHook = join(hooks, "pre-commit.replit-preserved");
    const original = "#!/bin/sh\nprintf original\n";
    writeFileSync(hook, original, { mode: 0o755 });
    const preload = join(root, "fail-registration-cleanup.mjs");
    writeFileSync(
      preload,
      [
        'import childProcess from "node:child_process";',
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const spawnSync = childProcess.spawnSync;",
        "const rmSync = fs.rmSync;",
        "childProcess.spawnSync = (command, args, options) => {",
        '  if (command === "git" && args?.includes("replit.repositoryHooksDispatcher")) {',
        '    return { status: 1, stdout: "", stderr: "simulated setup failure\\n" };',
        "  }",
        "  return spawnSync(command, args, options);",
        "};",
        "fs.rmSync = (target, options) => {",
        '  if (/\\.replit-repository-hooks[/\\\\][a-f0-9]{64}\\.sh$/.test(String(target))) {',
        '    throw Object.assign(new Error("simulated registration removal failure"), { code: "EACCES" });',
        "  }",
        "  return rmSync(target, options);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );

    const install = runHookInstaller(root, gitEnv, "--install-dispatcher", {
      NODE_OPTIONS: `--import=${preload}`,
    });

    const registrationsDirectory = join(hooks, ".replit-repository-hooks");
    const registrations = readdirSync(registrationsDirectory);
    assert.equal(registrations.length, 1);
    const registrationPath = join(registrationsDirectory, registrations[0]);
    assert.notEqual(install.status, 0);
    assert.match(
      install.output,
      /Dispatcher installation failed: simulated setup failure/,
    );
    assert.match(
      install.output,
      /Unable to remove the failed repository registration: simulated registration removal failure/,
    );
    assert.match(
      install.output,
      new RegExp(
        `A repository registration may remain at "${registrationPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      ),
    );
    assert.match(
      install.output,
      new RegExp(
        `remove it manually with: rm -f '${registrationPath.replace(/'/g, "'\\\\''").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`,
      ),
    );
    assert.match(install.output, /original pre-commit hook was restored/);
    assert.equal(readFileSync(hook, "utf8"), original);
    assert.equal(existsSync(preservedHook), false);
    assert.match(
      readFileSync(registrationPath, "utf8"),
      /replit-repository-hook-registration/,
    );
  });
});

test("dispatcher install rollback restores the hook when registration temporary cleanup fails", () => {
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
    const preservedHook = join(hooks, "pre-commit.replit-preserved");
    const original = "#!/bin/sh\nprintf original\n";
    writeFileSync(hook, original, { mode: 0o755 });
    const preload = join(root, "fail-temporary-cleanup.mjs");
    writeFileSync(
      preload,
      [
        'import childProcess from "node:child_process";',
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const spawnSync = childProcess.spawnSync;",
        "const rmSync = fs.rmSync;",
        "childProcess.spawnSync = (command, args, options) => {",
        '  if (command === "git" && args?.includes("replit.repositoryHooksDispatcher")) {',
        '    return { status: 1, stdout: "", stderr: "simulated setup failure\\n" };',
        "  }",
        "  return spawnSync(command, args, options);",
        "};",
        "fs.rmSync = (target, options) => {",
        '  if (String(target).endsWith(".tmp")) {',
        '    throw Object.assign(new Error("simulated temporary cleanup failure"), { code: "EACCES" });',
        "  }",
        "  return rmSync(target, options);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );

    const install = runHookInstaller(root, gitEnv, "--install-dispatcher", {
      NODE_OPTIONS: `--import=${preload}`,
    });

    assert.notEqual(install.status, 0);
    assert.match(
      install.output,
      /Dispatcher installation failed: simulated setup failure/,
    );
    assert.match(
      install.output,
      /Unable to remove the temporary repository registration copy: simulated temporary cleanup failure/,
    );
    assert.match(install.output, /original pre-commit hook was restored/);
    assert.match(
      install.output,
      /remove it manually with: rm -f '/,
    );
    assert.equal(readFileSync(hook, "utf8"), original);
    assert.equal(existsSync(preservedHook), false);
  });
});

test("failed dispatcher reinstall preserves the working registration and records", () => {
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
    const firstInstall = runHookInstaller(
      root,
      gitEnv,
      "--install-dispatcher",
    );
    assert.equal(firstInstall.status, 0, firstInstall.output);
    const registrationPath = execFileSync(
      "git",
      ["config", "--local", "--get", "replit.repositoryHooksDispatcher"],
      { cwd: root, env: gitEnv, encoding: "utf8" },
    ).trim();
    const registration = readFileSync(registrationPath);
    const dispatcherHash = execFileSync(
      "git",
      ["config", "--local", "--get", "replit.repositoryHooksDispatcherHash"],
      { cwd: root, env: gitEnv, encoding: "utf8" },
    ).trim();
    const failRecordUpdate = join(root, "fail-record-update.mjs");
    writeFileSync(
      failRecordUpdate,
      [
        'import childProcess from "node:child_process";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const spawnSync = childProcess.spawnSync;",
        "childProcess.spawnSync = (command, args, options) => {",
        '  if (command === "git" && args?.includes("replit.repositoryHooksDispatcherHash") && !args?.includes("--get")) {',
        '    return { status: 1, stdout: "", stderr: "simulated config failure\\n" };',
        "  }",
        "  return spawnSync(command, args, options);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );

    const reinstall = runHookInstaller(
      root,
      gitEnv,
      "--install-dispatcher",
      { NODE_OPTIONS: `--import=${failRecordUpdate}` },
    );
    assert.notEqual(reinstall.status, 0);
    assert.deepEqual(readFileSync(registrationPath), registration);
    assert.equal(
      execFileSync(
        "git",
        ["config", "--local", "--get", "replit.repositoryHooksDispatcher"],
        { cwd: root, env: gitEnv, encoding: "utf8" },
      ).trim(),
      registrationPath,
    );
    assert.equal(
      execFileSync(
        "git",
        ["config", "--local", "--get", "replit.repositoryHooksDispatcherHash"],
        { cwd: root, env: gitEnv, encoding: "utf8" },
      ).trim(),
      dispatcherHash,
    );
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

test("rejects an inherited test workspace without explicit opt-in", () => {
  withGitFixture((root, gitEnv) => {
    stage(root, gitEnv, `${backupDirectoryPrefix}recovery/generated.ts`);

    const result = runChecker(root, gitEnv, { enableTestWorkspace: false });

    assert.notEqual(result.status, 0);
    assert.match(
      result.output,
      /Refusing API_CODEGEN_CHECK_WORKSPACE without the explicit --enable-test-workspace test subprocess opt-in\./,
    );
    assert.match(result.output, /No generated files were changed\./);
    assert.doesNotMatch(
      result.output,
      /recovery backup directories are staged:/,
      "the normal invocation must reject the inherited workspace before inspecting it",
    );
  });
});

test("keeps the production workspace when an empty override is inherited", () => {
  withGitFixture((root, gitEnv) => {
    stage(root, gitEnv, `${backupDirectoryPrefix}recovery/generated.ts`);

    const result = runCheckerFromWorkingDirectory(root, gitEnv, "");

    assert.equal(result.status, 0, result.output);
  });
});

test("the real pre-commit hook rejects inherited workspaces before checking the repository", () => {
  withGitFixture((root, gitEnv) => {
    installRepositoryHookFixture(root, gitEnv);
    stage(root, gitEnv, `${backupDirectoryPrefix}recovery/generated.ts`);

    const inheritedWorkspace = mkdtempSync(
      join(tmpdir(), "staged-codegen-inherited-workspace-"),
    );
    try {
      const inheritedWorkspaceRun = runCommit(root, gitEnv, {
        API_CODEGEN_CHECK_WORKSPACE: inheritedWorkspace,
      });
      assert.notEqual(inheritedWorkspaceRun.status, 0);
      assert.match(
        inheritedWorkspaceRun.output,
        /Refusing API_CODEGEN_CHECK_WORKSPACE without the explicit --enable-test-workspace test subprocess opt-in\./,
      );
      assert.doesNotMatch(
        inheritedWorkspaceRun.output,
        /recovery backup directories are staged:/,
        "the real hook must reject the inherited workspace before it can inspect the wrong repository",
      );

      const normalEnv = { ...gitEnv };
      delete normalEnv.API_CODEGEN_CHECK_WORKSPACE;
      const repositoryRun = runCommit(root, normalEnv);
      assert.notEqual(repositoryRun.status, 0);
      assert.match(repositoryRun.output, /recovery backup directories are staged:/);
      assert.match(repositoryRun.output, /\.api-codegen-check-recovery/);
      assert.doesNotMatch(
        repositoryRun.output,
        /Refusing API_CODEGEN_CHECK_WORKSPACE/,
        "the normal hook invocation must inspect the repository it is validating",
      );
    } finally {
      rmSync(inheritedWorkspace, { recursive: true, force: true });
    }
  });
});

test("uses the repository workspace when no override is inherited", () => {
  const result = runCheckerWithoutWorkspaceOverride(process.env);

  assert.equal(result.status, 0, result.output);
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
  assert.equal(
    packageJson.scripts["hooks:dispatcher:status"],
    "node lib/api-spec/scripts/install-repository-git-hooks.mjs --dispatcher-status",
  );
  assert.equal(
    packageJson.scripts["hooks:dispatcher:status:json"],
    "node lib/api-spec/scripts/install-repository-git-hooks.mjs --dispatcher-status --json",
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

    // Plain setup succeeds only in repositories with their own registration.
    for (const repository of [first, second]) {
      assert.equal(runHookInstaller(repository, gitEnv).status, 0);
    }
    assert.notEqual(runHookInstaller(unrelated, gitEnv).status, 0);

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

    // Each repository's record stays pointed at its own registration.
    const secondRegistration = join(
      hooks,
      ".replit-repository-hooks",
      `${createHash("sha256")
        .update(
          execFileSync(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-dir"],
            { cwd: second, env: gitEnv, encoding: "utf8" },
          ).trim(),
        )
        .digest("hex")}.sh`,
    );
    assert.equal(
      execFileSync(
        "git",
        ["config", "--local", "--get-all", "replit.repositoryHooksDispatcher"],
        { cwd: second, env: gitEnv, encoding: "utf8" },
      ).trim(),
      secondRegistration,
    );
    const firstRecord = spawnSync(
      "git",
      ["config", "--local", "--get-all", "replit.repositoryHooksDispatcher"],
      { cwd: first, env: gitEnv, encoding: "utf8" },
    );
    assert.equal(firstRecord.status, 1);
    // Unregistered repositories are no longer treated as protected.
    assert.notEqual(runHookInstaller(first, gitEnv).status, 0);
    assert.equal(runHookInstaller(second, gitEnv).status, 0);

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

test("a failed sibling worktree registration keeps the surviving dispatcher record", () => {
  const fixture = mkdtempSync(join(tmpdir(), "worktree-hooks-rollback-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(fixture, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const first = join(fixture, "first");
  const second = join(fixture, "second");
  const hooks = join(fixture, "shared-hooks");
  try {
    mkdirSync(first);
    execFileSync("git", ["init", "--quiet"], { cwd: first, env: gitEnv });
    // Both worktrees share the repository-local Git config, including the
    // configured hooks path and the dispatcher records.
    execFileSync("git", ["config", "--local", "core.hooksPath", hooks], {
      cwd: first,
      env: gitEnv,
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "init",
      ],
      { cwd: first, env: gitEnv },
    );
    execFileSync("git", ["worktree", "add", "--detach", "--quiet", second], {
      cwd: first,
      env: gitEnv,
    });
    mkdirSync(hooks);
    const original = "#!/bin/sh\nprintf original\n";
    writeFileSync(join(hooks, "pre-commit"), original, { mode: 0o755 });

    const firstInstall = runHookInstaller(
      first,
      gitEnv,
      "--install-dispatcher",
    );
    assert.equal(firstInstall.status, 0, firstInstall.output);
    const firstRegistration = join(
      hooks,
      ".replit-repository-hooks",
      `${createHash("sha256")
        .update(
          execFileSync(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-dir"],
            { cwd: first, env: gitEnv, encoding: "utf8" },
          ).trim(),
        )
        .digest("hex")}.sh`,
    );
    assert.equal(existsSync(firstRegistration), true);

    // Fail the sibling worktree's registration write. Rollback must re-point
    // the shared dispatcher record at the surviving registration instead of
    // unsetting it.
    const preload = join(fixture, "fail-sibling-registration.mjs");
    writeFileSync(
      preload,
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const renameSync = fs.renameSync;",
        "fs.renameSync = (source, destination) => {",
        '  if (/\\.replit-repository-hooks[/\\\\][a-f0-9]{64}\\.sh$/.test(String(destination))) {',
        '    throw Object.assign(new Error("simulated sibling registration failure"), { code: "EACCES" });',
        "  }",
        "  return renameSync(source, destination);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );
    const secondInstall = runHookInstaller(
      second,
      gitEnv,
      "--install-dispatcher",
      { NODE_OPTIONS: `--import=${preload}` },
    );
    assert.notEqual(secondInstall.status, 0);
    assert.match(secondInstall.output, /simulated sibling registration failure/);

    // The shared record still resolves to the surviving registration only,
    // and the sibling's failed registration left no file behind.
    assert.equal(
      execFileSync(
        "git",
        ["config", "--local", "--get-all", "replit.repositoryHooksDispatcher"],
        { cwd: first, env: gitEnv, encoding: "utf8" },
      ).trim(),
      firstRegistration,
    );
    assert.notEqual(
      execFileSync(
        "git",
        ["config", "--local", "--get", "replit.repositoryHooksDispatcherHash"],
        { cwd: first, env: gitEnv, encoding: "utf8" },
      ).trim(),
      "",
    );
    assert.equal(existsSync(firstRegistration), true);
    assert.equal(
      readdirSync(join(hooks, ".replit-repository-hooks")).filter((name) =>
        name.endsWith(".sh"),
      ).length,
      1,
    );

    // The surviving worktree is still protected and reports a consistent
    // installation.
    assert.equal(runHookInstaller(first, gitEnv).status, 0);
    const status = runHookInstaller(first, gitEnv, "--dispatcher-status");
    assert.equal(status.status, 0, status.output);
    assert.match(status.output, /Consistency: installed/);
    assert.doesNotMatch(status.output, /Warning:/);

    // The surviving worktree can still uninstall cleanly.
    const uninstall = runHookInstaller(first, gitEnv, "--uninstall-dispatcher");
    assert.equal(uninstall.status, 0, uninstall.output);
    assert.match(uninstall.output, /Restored the original pre-commit hook/);
    assert.equal(readFileSync(join(hooks, "pre-commit"), "utf8"), original);
    assert.equal(existsSync(join(hooks, ".replit-repository-hooks")), false);
    const record = spawnSync(
      "git",
      ["config", "--local", "--get-all", "replit.repositoryHooksDispatcher"],
      { cwd: first, env: gitEnv, encoding: "utf8" },
    );
    assert.equal(record.status, 1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("competing shared dispatcher registrations and unregister operations are serialized", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "competing-repository-hooks-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(fixture, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const hooks = join(fixture, "shared-hooks");
  const repositories = ["first", "second", "third"].map((name) =>
    join(fixture, name),
  );
  try {
    mkdirSync(hooks);
    writeFileSync(
      join(hooks, "pre-commit"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    execFileSync("git", ["config", "--global", "core.hooksPath", hooks], {
      cwd: fixture,
      env: gitEnv,
    });
    for (const repository of repositories) {
      mkdirSync(repository);
      execFileSync("git", ["init", "--quiet"], {
        cwd: repository,
        env: gitEnv,
      });
      mkdirSync(join(repository, ".githooks"));
      writeFileSync(
        join(repository, ".githooks", "pre-commit"),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o755 },
      );
    }

    const enteredCriticalSection = join(fixture, "entered-critical-section");
    const releaseCriticalSection = join(fixture, "release-critical-section");
    const delayAfterPreserve = join(fixture, "delay-after-preserve.mjs");
    writeFileSync(
      delayAfterPreserve,
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        `const entered = ${JSON.stringify(enteredCriticalSection)};`,
        `const release = ${JSON.stringify(releaseCriticalSection)};`,
        "const copyFileSync = fs.copyFileSync;",
        "fs.copyFileSync = (source, destination, mode) => {",
        "  const result = copyFileSync(source, destination, mode);",
        '  if (String(destination).endsWith("pre-commit.replit-preserved")) {',
        '    fs.writeFileSync(entered, "entered\\n");',
        "    while (!fs.existsSync(release)) {",
        "      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
        "    }",
        "  }",
        "  return result;",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );

    const firstInstall = runHookInstallerAsync(
      repositories[0],
      gitEnv,
      "--install-dispatcher",
      { NODE_OPTIONS: `--import=${delayAfterPreserve}` },
    );
    await waitForPath(enteredCriticalSection);
    const secondInstall = runHookInstallerAsync(
      repositories[1],
      gitEnv,
      "--install-dispatcher",
    );
    const secondFinishedBeforeRelease = await Promise.race([
      secondInstall.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(secondFinishedBeforeRelease, false);
    writeFileSync(releaseCriticalSection, "release\n");
    for (const result of await Promise.all([firstInstall, secondInstall])) {
      assert.equal(result.status, 0, result.output);
    }
    assert.equal(
      readdirSync(join(hooks, ".replit-repository-hooks")).filter((name) =>
        name.endsWith(".sh"),
      ).length,
      2,
    );

    const enteredUnregister = join(fixture, "entered-unregister");
    const releaseUnregister = join(fixture, "release-unregister");
    const installAttemptedLock = join(fixture, "install-attempted-lock");
    const delayUnregister = join(fixture, "delay-unregister.mjs");
    writeFileSync(
      delayUnregister,
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        `const entered = ${JSON.stringify(enteredUnregister)};`,
        `const release = ${JSON.stringify(releaseUnregister)};`,
        "const readdirSync = fs.readdirSync;",
        "fs.readdirSync = (path, ...args) => {",
        '  if (String(path).endsWith(".replit-repository-hooks")) {',
        '    fs.writeFileSync(entered, "entered\\n");',
        "    while (!fs.existsSync(release)) {",
        "      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
        "    }",
        "  }",
        "  return readdirSync(path, ...args);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );
    const recordInstallAttempt = join(fixture, "record-install-attempt.mjs");
    writeFileSync(
      recordInstallAttempt,
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        `const attempted = ${JSON.stringify(installAttemptedLock)};`,
        "const renameSync = fs.renameSync;",
        "fs.renameSync = (source, destination) => {",
        '  if (String(destination).endsWith(".replit-repository-hooks.lock")) {',
        '    fs.writeFileSync(attempted, "attempted\\n");',
        "  }",
        "  return renameSync(source, destination);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );

    const uninstall = runHookInstallerAsync(
      repositories[0],
      gitEnv,
      "--uninstall-dispatcher",
      { NODE_OPTIONS: `--import=${delayUnregister}` },
    );
    await waitForPath(enteredUnregister);
    const install = runHookInstallerAsync(
      repositories[2],
      gitEnv,
      "--install-dispatcher",
      { NODE_OPTIONS: `--import=${recordInstallAttempt}` },
    );
    await waitForPath(installAttemptedLock);
    const installFinishedBeforeUnregisterRelease = await Promise.race([
      install.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(installFinishedBeforeUnregisterRelease, false);
    writeFileSync(releaseUnregister, "release\n");
    const [uninstallResult, installResult] = await Promise.all([
      uninstall,
      install,
    ]);
    assert.equal(uninstallResult.status, 0, uninstallResult.output);
    assert.equal(installResult.status, 0, installResult.output);
    assert.match(
      readFileSync(join(hooks, "pre-commit"), "utf8"),
      /replit-repository-hook-dispatcher/,
    );
    assert.equal(
      readdirSync(join(hooks, ".replit-repository-hooks")).filter((name) =>
        name.endsWith(".sh"),
      ).length,
      2,
    );
    assert.equal(existsSync(join(hooks, ".replit-repository-hooks.lock")), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("dispatcher install recovers after interruption leaves a lock and preserved copy", () => {
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
    const interruptAfterPreserve = join(root, "interrupt-after-preserve.mjs");
    writeFileSync(
      interruptAfterPreserve,
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const copyFileSync = fs.copyFileSync;",
        "fs.copyFileSync = (source, destination, mode) => {",
        "  const result = copyFileSync(source, destination, mode);",
        '  if (String(destination).endsWith("pre-commit.replit-preserved")) {',
        "    process.exit(91);",
        "  }",
        "  return result;",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );

    const interrupted = runHookInstaller(
      root,
      gitEnv,
      "--install-dispatcher",
      { NODE_OPTIONS: `--import=${interruptAfterPreserve}` },
    );
    assert.equal(interrupted.status, 91, interrupted.output);
    assert.equal(readFileSync(hook, "utf8"), original);
    assert.equal(
      readFileSync(join(hooks, "pre-commit.replit-preserved"), "utf8"),
      original,
    );
    assert.equal(existsSync(join(hooks, ".replit-repository-hooks.lock")), true);

    const retry = runHookInstaller(root, gitEnv, "--install-dispatcher");
    assert.equal(retry.status, 0, retry.output);
    assert.match(readFileSync(hook, "utf8"), /replit-repository-hook-dispatcher/);
    assert.equal(existsSync(join(hooks, ".replit-repository-hooks.lock")), false);
  });
});

for (const matchingOwner of [false, true]) {
  test(`dispatcher lock fallback ${matchingOwner ? "keeps a genuinely active owner" : "recovers a reused process ID"}`, async () => {
    await withGitFixture(async (root, gitEnv) => {
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
      const lock = join(hooks, ".replit-repository-hooks.lock");
      mkdirSync(lock);
      writeFileSync(
        join(lock, "owner"),
        `${JSON.stringify({
          pid: process.pid,
          startIdentity: matchingOwner
            ? "ps:Mon Jan 1 00:00:00 2024"
            : "ps:Sun Dec 31 23:59:59 2023",
          token: "fixture-owner",
        })}\n`,
      );
      const forcePsFallback = join(root, "force-ps-start-identity.mjs");
      writeFileSync(
        forcePsFallback,
        [
          'import childProcess from "node:child_process";',
          'import fs from "node:fs";',
          'import { syncBuiltinESMExports } from "node:module";',
          "const readFileSync = fs.readFileSync;",
          "const spawnSync = childProcess.spawnSync;",
          "fs.readFileSync = (path, ...args) => {",
          '  if (String(path).startsWith("/proc/") && String(path).endsWith("/stat")) {',
          '    throw Object.assign(new Error("simulated macOS without proc"), { code: "ENOENT" });',
          "  }",
          "  return readFileSync(path, ...args);",
          "};",
          "childProcess.spawnSync = (command, args, options) => {",
          '  if (command === "ps" && args?.[0] === "-o" && args?.[1] === "lstart=") {',
          '    return { status: 0, stdout: "Mon Jan  1 00:00:00 2024\\n", stderr: "" };',
          "  }",
          "  return spawnSync(command, args, options);",
          "};",
          "syncBuiltinESMExports();",
          "",
        ].join("\n"),
      );

      const install = runHookInstallerAsync(
        root,
        gitEnv,
        "--install-dispatcher",
        { NODE_OPTIONS: `--import=${forcePsFallback}` },
      );
      if (matchingOwner) {
        const finishedWhileOwnerWasActive = await Promise.race([
          install.then(() => true),
          new Promise((settle) => setTimeout(() => settle(false), 100)),
        ]);
        assert.equal(finishedWhileOwnerWasActive, false);
        rmSync(lock, { recursive: true });
      }
      const result = await install;
      assert.equal(result.status, 0, result.output);
      assert.match(
        readFileSync(join(hooks, "pre-commit"), "utf8"),
        /replit-repository-hook-dispatcher/,
      );
    });
  });
}

test("dispatcher install recovers an ownerless lock left during acquisition", () => {
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
    const interruptBeforeOwner = join(root, "interrupt-before-owner.mjs");
    writeFileSync(
      interruptBeforeOwner,
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const writeFileSync = fs.writeFileSync;",
        "fs.writeFileSync = (path, ...args) => {",
        '  if (String(path).includes(".replit-repository-hooks.lock-") && String(path).endsWith("/owner")) {',
        "    process.exit(92);",
        "  }",
        "  return writeFileSync(path, ...args);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );

    const interrupted = runHookInstaller(
      root,
      gitEnv,
      "--install-dispatcher",
      { NODE_OPTIONS: `--import=${interruptBeforeOwner}` },
    );
    assert.equal(interrupted.status, 92, interrupted.output);
    assert.equal(existsSync(join(hooks, ".replit-repository-hooks.lock")), false);

    const retry = runHookInstaller(root, gitEnv, "--install-dispatcher");
    assert.equal(retry.status, 0, retry.output);
    assert.match(
      readFileSync(join(hooks, "pre-commit"), "utf8"),
      /replit-repository-hook-dispatcher/,
    );
  });
});

for (const cleanupMode of ["--install-dispatcher", "--uninstall-dispatcher"]) {
  test(`${cleanupMode.slice(2)} removes an abandoned lock candidate without touching a live candidate`, async () => {
    await withGitFixture(async (root, gitEnv) => {
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
      const initialInstall = runHookInstaller(
        root,
        gitEnv,
        "--install-dispatcher",
      );
      assert.equal(initialInstall.status, 0, initialInstall.output);

      const interruptBeforeOwner = join(
        root,
        `interrupt-candidate-${cleanupMode.slice(2)}.mjs`,
      );
      writeFileSync(
        interruptBeforeOwner,
        [
          'import fs from "node:fs";',
          'import { syncBuiltinESMExports } from "node:module";',
          "const writeFileSync = fs.writeFileSync;",
          "fs.writeFileSync = (path, ...args) => {",
          '  if (String(path).includes(".replit-repository-hooks.lock-") && String(path).endsWith("/owner")) {',
          "    process.exit(93);",
          "  }",
          "  return writeFileSync(path, ...args);",
          "};",
          "syncBuiltinESMExports();",
          "",
        ].join("\n"),
      );
      const interrupted = runHookInstaller(
        root,
        gitEnv,
        "--install-dispatcher",
        { NODE_OPTIONS: `--import=${interruptBeforeOwner}` },
      );
      assert.equal(interrupted.status, 93, interrupted.output);
      const abandonedCandidate = readdirSync(hooks).find((name) =>
        name.startsWith(".replit-repository-hooks.lock-"),
      );
      assert.ok(abandonedCandidate);

      const liveCandidate = join(
        hooks,
        `.replit-repository-hooks.lock-${process.pid}-00000000-0000-4000-8000-000000000000`,
      );
      mkdirSync(liveCandidate);

      const cleanup = runHookInstaller(root, gitEnv, cleanupMode);
      assert.equal(cleanup.status, 0, cleanup.output);
      assert.equal(existsSync(join(hooks, abandonedCandidate)), false);
      assert.equal(existsSync(liveCandidate), true);
    });
  });
}

test("worktrees of one repository register independently with a shared hooks folder", () => {
  const fixture = mkdtempSync(join(tmpdir(), "worktree-repository-hooks-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(fixture, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const main = join(fixture, "main");
  const sibling = join(fixture, "sibling");
  const hooks = join(fixture, "shared-hooks");
  try {
    mkdirSync(main);
    execFileSync("git", ["init", "--quiet"], { cwd: main, env: gitEnv });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: main, env: gitEnv },
    );
    execFileSync("git", ["worktree", "add", "--detach", sibling], {
      cwd: main,
      env: gitEnv,
    });
    assert.equal(
      execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: sibling, env: gitEnv, encoding: "utf8" },
      ).trim(),
      join(main, ".git"),
    );
    execFileSync("git", ["config", "--global", "core.hooksPath", hooks], {
      cwd: fixture,
      env: gitEnv,
    });
    mkdirSync(hooks);
    const original = '#!/bin/sh\nprintf shared >> "$SHARED_RUNS"\n';
    writeFileSync(join(hooks, "pre-commit"), original, { mode: 0o755 });

    // A legacy boolean record is shared by every worktree and must not mark
    // any of them as registered on its own.
    execFileSync(
      "git",
      ["config", "--local", "replit.repositoryHooksDispatcher", "true"],
      { cwd: main, env: gitEnv },
    );
    assert.notEqual(runHookInstaller(main, gitEnv).status, 0);
    assert.notEqual(runHookInstaller(sibling, gitEnv).status, 0);

    const gitDirectoryOf = (worktree) =>
      execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-dir"],
        { cwd: worktree, env: gitEnv, encoding: "utf8" },
      ).trim();
    const registrationPathOf = (worktree) =>
      join(
        hooks,
        ".replit-repository-hooks",
        `${createHash("sha256").update(gitDirectoryOf(worktree)).digest("hex")}.sh`,
      );
    const recordedRegistrations = (worktree) =>
      execFileSync(
        "git",
        ["config", "--local", "--get-all", "replit.repositoryHooksDispatcher"],
        { cwd: worktree, env: gitEnv, encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .toSorted();

    for (const [worktree, label] of [
      [main, "main"],
      [sibling, "sibling"],
    ]) {
      mkdirSync(join(worktree, ".githooks"));
      writeFileSync(
        join(worktree, ".githooks", "pre-commit"),
        `#!/bin/sh\nprintf ${label} >> "$REPOSITORY_RUNS"\n`,
        { mode: 0o755 },
      );
    }

    const installMain = runHookInstaller(main, gitEnv, "--install-dispatcher");
    assert.equal(installMain.status, 0, installMain.output);

    // Plain setup follows only the current worktree's own registration.
    assert.equal(runHookInstaller(main, gitEnv).status, 0);
    const unregisteredSibling = runHookInstaller(sibling, gitEnv);
    assert.notEqual(unregisteredSibling.status, 0);
    assert.match(unregisteredSibling.output, /hooks:dispatcher:install/);

    const installSibling = runHookInstaller(
      sibling,
      gitEnv,
      "--install-dispatcher",
    );
    assert.equal(installSibling.status, 0, installSibling.output);
    assert.equal(runHookInstaller(sibling, gitEnv).status, 0);
    assert.deepEqual(
      recordedRegistrations(main),
      [registrationPathOf(main), registrationPathOf(sibling)].toSorted(),
    );

    const registrationsDirectory = join(hooks, ".replit-repository-hooks");
    assert.equal(
      readdirSync(registrationsDirectory).filter((name) =>
        name.endsWith(".sh"),
      ).length,
      2,
    );

    const hook = join(hooks, "pre-commit");
    const repositoryRuns = join(fixture, "repository-runs");
    const sharedRuns = join(fixture, "shared-runs");
    const runDispatcher = (worktree) => {
      const run = spawnSync(hook, {
        cwd: worktree,
        env: {
          ...gitEnv,
          REPOSITORY_RUNS: repositoryRuns,
          SHARED_RUNS: sharedRuns,
        },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    };
    runDispatcher(main);
    runDispatcher(sibling);
    assert.equal(readFileSync(repositoryRuns, "utf8"), "mainsibling");
    assert.equal(readFileSync(sharedRuns, "utf8"), "sharedshared");

    const uninstallMain = runHookInstaller(
      main,
      gitEnv,
      "--uninstall-dispatcher",
    );
    assert.equal(uninstallMain.status, 0, uninstallMain.output);
    assert.match(
      readFileSync(hook, "utf8"),
      /replit-repository-hook-dispatcher/,
    );
    assert.match(
      execFileSync(
        "git",
        [
          "config",
          "--local",
          "--get",
          "replit.repositoryHooksDispatcherHash",
        ],
        { cwd: sibling, env: gitEnv, encoding: "utf8" },
      ).trim(),
      /^[a-f0-9]{64}$/,
    );
    // The shared record tracks only the surviving worktree's registration.
    assert.deepEqual(recordedRegistrations(sibling), [
      registrationPathOf(sibling),
    ]);
    // Plain setup in the unregistered worktree no longer passes silently.
    assert.notEqual(runHookInstaller(main, gitEnv).status, 0);
    assert.equal(runHookInstaller(sibling, gitEnv).status, 0);

    rmSync(repositoryRuns);
    runDispatcher(main);
    runDispatcher(sibling);
    assert.equal(readFileSync(repositoryRuns, "utf8"), "sibling");

    const uninstallSibling = runHookInstaller(
      sibling,
      gitEnv,
      "--uninstall-dispatcher",
    );
    assert.equal(uninstallSibling.status, 0, uninstallSibling.output);
    assert.equal(readFileSync(hook, "utf8"), original);
    assert.equal(existsSync(join(hooks, "pre-commit.replit-preserved")), false);
    assert.equal(existsSync(registrationsDirectory), false);
    const clearedRecord = spawnSync(
      "git",
      ["config", "--local", "--get-all", "replit.repositoryHooksDispatcher"],
      { cwd: sibling, env: gitEnv, encoding: "utf8" },
    );
    assert.equal(clearedRecord.status, 1);
    assert.equal(clearedRecord.stdout, "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a legacy linked-worktree registration migrates without double runs or blocking restoration", () => {
  const fixture = mkdtempSync(join(tmpdir(), "legacy-worktree-hooks-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(fixture, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const main = join(fixture, "main");
  const sibling = join(fixture, "sibling");
  const hooks = join(fixture, "shared-hooks");
  try {
    mkdirSync(main);
    execFileSync("git", ["init", "--quiet"], { cwd: main, env: gitEnv });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: main, env: gitEnv },
    );
    execFileSync("git", ["worktree", "add", "--detach", sibling], {
      cwd: main,
      env: gitEnv,
    });
    execFileSync("git", ["config", "--global", "core.hooksPath", hooks], {
      cwd: fixture,
      env: gitEnv,
    });
    mkdirSync(hooks);
    const original = '#!/bin/sh\nprintf shared >> "$SHARED_RUNS"\n';
    writeFileSync(join(hooks, "pre-commit"), original, { mode: 0o755 });

    for (const [worktree, label] of [
      [main, "main"],
      [sibling, "sibling"],
    ]) {
      mkdirSync(join(worktree, ".githooks"));
      writeFileSync(
        join(worktree, ".githooks", "pre-commit"),
        `#!/bin/sh\nprintf ${label} >> "$REPOSITORY_RUNS"\n`,
        { mode: 0o755 },
      );
    }

    // The previous installer run from the linked worktree recorded its
    // registration under the shared common-directory name, which is also
    // the primary worktree's per-worktree name.
    const installMain = runHookInstaller(main, gitEnv, "--install-dispatcher");
    assert.equal(installMain.status, 0, installMain.output);
    const registrationsDirectory = join(hooks, ".replit-repository-hooks");
    const legacyRegistration = join(
      registrationsDirectory,
      `${createHash("sha256").update(join(main, ".git")).digest("hex")}.sh`,
    );
    writeFileSync(
      legacyRegistration,
      [
        "#!/bin/sh",
        "# replit-repository-hook-registration",
        "set -u",
        `expected_repository='${sibling}'`,
        `repository_hook='${join(sibling, ".githooks", "pre-commit")}'`,
        "current_repository=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0",
        '[ "$current_repository" = "$expected_repository" ] || exit 0',
        'exec sh "$repository_hook" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const hook = join(hooks, "pre-commit");
    const repositoryRuns = join(fixture, "repository-runs");
    const sharedRuns = join(fixture, "shared-runs");
    const runDispatcher = (worktree) => {
      const run = spawnSync(hook, {
        cwd: worktree,
        env: {
          ...gitEnv,
          REPOSITORY_RUNS: repositoryRuns,
          SHARED_RUNS: sharedRuns,
        },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    };

    // The legacy file still runs for the sibling, but it must not register
    // the primary worktree.
    assert.notEqual(runHookInstaller(main, gitEnv).status, 0);
    runDispatcher(main);
    assert.equal(existsSync(repositoryRuns), false);
    runDispatcher(sibling);
    assert.equal(readFileSync(repositoryRuns, "utf8"), "sibling");

    // Reinstalling from the linked worktree migrates the legacy record
    // instead of leaving a duplicate registration behind.
    const reinstall = runHookInstaller(
      sibling,
      gitEnv,
      "--install-dispatcher",
    );
    assert.equal(reinstall.status, 0, reinstall.output);
    assert.equal(existsSync(legacyRegistration), false);
    assert.equal(
      readdirSync(registrationsDirectory).filter((name) =>
        name.endsWith(".sh"),
      ).length,
      1,
    );
    assert.equal(runHookInstaller(sibling, gitEnv).status, 0);
    assert.notEqual(runHookInstaller(main, gitEnv).status, 0);

    rmSync(repositoryRuns);
    runDispatcher(sibling);
    assert.equal(readFileSync(repositoryRuns, "utf8"), "sibling");

    // Both worktrees then register and unregister independently.
    const installMainAgain = runHookInstaller(
      main,
      gitEnv,
      "--install-dispatcher",
    );
    assert.equal(installMainAgain.status, 0, installMainAgain.output);
    assert.equal(runHookInstaller(main, gitEnv).status, 0);
    assert.equal(
      readdirSync(registrationsDirectory).filter((name) =>
        name.endsWith(".sh"),
      ).length,
      2,
    );

    const uninstallSibling = runHookInstaller(
      sibling,
      gitEnv,
      "--uninstall-dispatcher",
    );
    assert.equal(uninstallSibling.status, 0, uninstallSibling.output);
    assert.match(
      readFileSync(hook, "utf8"),
      /replit-repository-hook-dispatcher/,
    );

    const uninstallMain = runHookInstaller(
      main,
      gitEnv,
      "--uninstall-dispatcher",
    );
    assert.equal(uninstallMain.status, 0, uninstallMain.output);
    assert.equal(readFileSync(hook, "utf8"), original);
    assert.equal(existsSync(join(hooks, "pre-commit.replit-preserved")), false);
    assert.equal(existsSync(registrationsDirectory), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a worktree deleted without unregistering does not block hook restoration", () => {
  const fixture = mkdtempSync(join(tmpdir(), "deleted-worktree-hooks-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(fixture, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const main = join(fixture, "main");
  const sibling = join(fixture, "sibling");
  const hooks = join(fixture, "shared-hooks");
  try {
    mkdirSync(main);
    execFileSync("git", ["init", "--quiet"], { cwd: main, env: gitEnv });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: main, env: gitEnv },
    );
    execFileSync("git", ["worktree", "add", "--detach", sibling], {
      cwd: main,
      env: gitEnv,
    });
    execFileSync("git", ["config", "--global", "core.hooksPath", hooks], {
      cwd: fixture,
      env: gitEnv,
    });
    mkdirSync(hooks);
    const original = '#!/bin/sh\nprintf shared >> "$SHARED_RUNS"\n';
    writeFileSync(join(hooks, "pre-commit"), original, { mode: 0o755 });

    const gitDirectoryOf = (worktree) =>
      execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-dir"],
        { cwd: worktree, env: gitEnv, encoding: "utf8" },
      ).trim();
    const registrationsDirectory = join(hooks, ".replit-repository-hooks");
    const registrationPathOf = (worktree) =>
      join(
        registrationsDirectory,
        `${createHash("sha256").update(gitDirectoryOf(worktree)).digest("hex")}.sh`,
      );
    const liveRegistrationNames = () =>
      readdirSync(registrationsDirectory).filter((name) =>
        name.endsWith(".sh"),
      );

    for (const [worktree, label] of [
      [main, "main"],
      [sibling, "sibling"],
    ]) {
      mkdirSync(join(worktree, ".githooks"));
      writeFileSync(
        join(worktree, ".githooks", "pre-commit"),
        `#!/bin/sh\nprintf ${label} >> "$REPOSITORY_RUNS"\n`,
        { mode: 0o755 },
      );
    }

    const installMain = runHookInstaller(main, gitEnv, "--install-dispatcher");
    assert.equal(installMain.status, 0, installMain.output);
    const installSibling = runHookInstaller(
      sibling,
      gitEnv,
      "--install-dispatcher",
    );
    assert.equal(installSibling.status, 0, installSibling.output);
    const siblingRegistration = registrationPathOf(sibling);
    assert.equal(liveRegistrationNames().length, 2);

    // The developer deletes the worktree folder without unregistering first.
    rmSync(sibling, { recursive: true, force: true });

    // A later install from a live worktree prunes the dead registration.
    const reinstallMain = runHookInstaller(
      main,
      gitEnv,
      "--install-dispatcher",
    );
    assert.equal(reinstallMain.status, 0, reinstallMain.output);
    assert.equal(existsSync(siblingRegistration), false);
    assert.deepEqual(liveRegistrationNames(), [
      `${createHash("sha256").update(gitDirectoryOf(main)).digest("hex")}.sh`,
    ]);

    // Recreate the stale state (another deleted worktree that never
    // unregisters) so the unregister path is covered as well.
    writeFileSync(
      siblingRegistration,
      [
        "#!/bin/sh",
        "# replit-repository-hook-registration",
        "set -u",
        `expected_repository='${sibling}'`,
        `repository_hook='${join(sibling, ".githooks", "pre-commit")}'`,
        "current_repository=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0",
        '[ "$current_repository" = "$expected_repository" ] || exit 0',
        'exec sh "$repository_hook" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    // Unregistering the last live worktree still counts as the final
    // unregister: the dead registration is pruned and the original hook is
    // restored instead of the dispatcher staying installed forever.
    const uninstallMain = runHookInstaller(
      main,
      gitEnv,
      "--uninstall-dispatcher",
    );
    assert.equal(uninstallMain.status, 0, uninstallMain.output);
    const hook = join(hooks, "pre-commit");
    assert.equal(readFileSync(hook, "utf8"), original);
    assert.equal(existsSync(join(hooks, "pre-commit.replit-preserved")), false);
    assert.equal(existsSync(registrationsDirectory), false);
    const clearedRecord = spawnSync(
      "git",
      ["config", "--local", "--get-all", "replit.repositoryHooksDispatcher"],
      { cwd: main, env: gitEnv, encoding: "utf8" },
    );
    assert.equal(clearedRecord.status, 1);
    assert.equal(clearedRecord.stdout, "");
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
