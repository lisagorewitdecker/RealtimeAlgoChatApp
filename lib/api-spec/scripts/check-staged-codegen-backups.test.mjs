import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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

test("dispatcher status does not configure hooks when core.hooksPath is unset", () => {
  withGitFixture((root, gitEnv) => {
    const hooks = join(root, ".git", "hooks");

    assertStatusIsReadOnly(root, gitEnv, hooks, (output) => {
      assert.match(output, new RegExp(`Repository: "${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(output, /Active pre-commit hook: absent/);
      assert.match(output, /Repository registration file: absent/);
      assert.match(output, /repositoryHooksDispatcher: absent/);
      assert.match(output, /repositoryHooksDispatcherHash: absent/);
    });

    const configured = spawnSync(
      "git",
      ["config", "--local", "--get", "core.hooksPath"],
      { cwd: root, env: gitEnv, encoding: "utf8" },
    );
    assert.equal(configured.status, 1);
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
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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
