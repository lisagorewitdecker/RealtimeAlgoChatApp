import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function makeLoggingWorkerPathsRelocatable(distDir) {
  const bundledFiles = (await readdir(distDir)).filter((file) =>
    file.endsWith(".mjs"),
  );
  const absoluteOutputDir = `const outputDir = ${JSON.stringify(distDir)};`;
  const relativeOutputDir = "const outputDir = globalThis.__dirname;";
  let replacements = 0;

  await Promise.all(
    bundledFiles.map(async (file) => {
      const filePath = path.join(distDir, file);
      const contents = await readFile(filePath, "utf8");
      if (!contents.includes(absoluteOutputDir)) return;

      const updated = contents.replaceAll(absoluteOutputDir, relativeOutputDir);
      replacements +=
        contents.split(absoluteOutputDir).length -
        updated.split(absoluteOutputDir).length;
      await writeFile(filePath, updated);
    }),
  );

  if (replacements === 0) {
    throw new Error(
      "Pino bundle did not contain the expected logging-worker path declaration.",
    );
  }
}

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [
      path.resolve(artifactDir, "src/index.ts"),
      path.resolve(artifactDir, "src/instrument.ts"),
    ],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    // The preload (instrument.mjs) and the application (index.mjs) share one
    // copy of Sentry, pino and the logger through a common chunk. Without
    // splitting each entry would carry its own copy: the Sentry client the
    // preload initializes would not be the one the application reports
    // through, and each copy of the logger would spawn its own transport
    // worker.
    splitting: true,
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
      // @sentry/node and express are deliberately bundled. Leaving them
      // external would let Sentry's import hooks instrument Express for
      // tracing, but tracing is disabled (see src/instrument.ts), and loading
      // them from node_modules costs thousands of small file reads on every
      // cold start — the dominant part of production startup time.
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
  await makeLoggingWorkerPathsRelocatable(distDir);

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/cryptoClient.ts")],
    platform: "browser",
    bundle: true,
    format: "iife",
    outfile: path.resolve(distDir, "crypto-client.js"),
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
