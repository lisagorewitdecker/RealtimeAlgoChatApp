import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const brandingPath = path.join(
  workspaceRoot,
  "artifacts/chat-app/constants/branding.ts",
);
const appMetadataPath = path.join(workspaceRoot, "artifacts/chat-app/app.json");

export function extractProductName(brandingSource) {
  const match = brandingSource.match(
    /export\s+const\s+PRODUCT_NAME\s*=\s*"([^"]+)"\s*;/,
  );
  if (!match) {
    throw new Error(
      "Could not find PRODUCT_NAME in artifacts/chat-app/constants/branding.ts.",
    );
  }
  return match[1];
}

export function validateBrandingValues({ productName, appName }) {
  if (typeof appName !== "string" || appName.length === 0) {
    throw new Error("Could not find expo.name in artifacts/chat-app/app.json.");
  }

  if (productName !== appName) {
    throw new Error(
      `App name mismatch: artifacts/chat-app/constants/branding.ts PRODUCT_NAME is "${productName}", but artifacts/chat-app/app.json expo.name is "${appName}".`,
    );
  }

  return productName;
}

export function validatePermissionDescriptions({
  productName,
  cameraUsageDescription,
  microphoneUsageDescription,
}) {
  const descriptions = [
    ["ios.infoPlist.NSCameraUsageDescription", cameraUsageDescription],
    ["ios.infoPlist.NSMicrophoneUsageDescription", microphoneUsageDescription],
  ];

  for (const [key, description] of descriptions) {
    if (typeof description !== "string" || !description.includes(productName)) {
      throw new Error(
        `Permission branding mismatch: artifacts/chat-app/app.json ${key} must include PRODUCT_NAME from artifacts/chat-app/constants/branding.ts ("${productName}").`,
      );
    }
  }
}

export function validateBrandingFiles({ brandingSource, appMetadataSource }) {
  const appMetadata = JSON.parse(appMetadataSource);
  const productName = extractProductName(brandingSource);
  const infoPlist = appMetadata?.expo?.ios?.infoPlist;

  validateBrandingValues({
    productName,
    appName: appMetadata?.expo?.name,
  });
  validatePermissionDescriptions({
    productName,
    cameraUsageDescription: infoPlist?.NSCameraUsageDescription,
    microphoneUsageDescription: infoPlist?.NSMicrophoneUsageDescription,
  });

  return productName;
}

function requireNativeValue(metadata, key, platform) {
  const value = metadata?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Native ${platform} metadata is missing ${key}; inspect the built release artifact rather than the source app.json.`,
    );
  }
  return value;
}

function validateNativeIosMetadata({
  metadata,
  productName,
  expectedPermissionDescriptions,
}) {
  const displayName = requireNativeValue(metadata, "CFBundleDisplayName", "iOS");
  const bundleName = requireNativeValue(metadata, "CFBundleName", "iOS");

  if (displayName !== productName) {
    throw new Error(
      `Native iOS label mismatch: expected CFBundleDisplayName to be "${productName}", received "${displayName}".`,
    );
  }

  const cameraUsageDescription = requireNativeValue(
    metadata,
    "NSCameraUsageDescription",
    "iOS",
  );
  const microphoneUsageDescription = requireNativeValue(
    metadata,
    "NSMicrophoneUsageDescription",
    "iOS",
  );
  validatePermissionDescriptions({
    productName,
    cameraUsageDescription,
    microphoneUsageDescription,
  });

  if (
    expectedPermissionDescriptions?.camera &&
    cameraUsageDescription !== expectedPermissionDescriptions.camera
  ) {
    throw new Error(
      `Native iOS permission copy mismatch: NSCameraUsageDescription is "${cameraUsageDescription}", expected the approved copy "${expectedPermissionDescriptions.camera}".`,
    );
  }
  if (
    expectedPermissionDescriptions?.microphone &&
    microphoneUsageDescription !== expectedPermissionDescriptions.microphone
  ) {
    throw new Error(
      `Native iOS permission copy mismatch: NSMicrophoneUsageDescription is "${microphoneUsageDescription}", expected the approved copy "${expectedPermissionDescriptions.microphone}".`,
    );
  }

  return {
    label: displayName,
    bundleName,
    cameraUsageDescription,
    microphoneUsageDescription,
  };
}

function nativeAndroidPermissions(metadata) {
  const permissions = metadata?.permissions;
  if (!Array.isArray(permissions)) {
    throw new Error(
      "Native Android metadata is missing permissions; inspect the compiled APK manifest.",
    );
  }
  return permissions.filter((permission) => typeof permission === "string");
}

function validateNativeAndroidMetadata({
  metadata,
  productName,
  expectedPermissions = [
    "android.permission.CAMERA",
    "android.permission.RECORD_AUDIO",
  ],
}) {
  const label = requireNativeValue(metadata, "applicationLabel", "Android");
  if (label !== productName) {
    throw new Error(
      `Native Android label mismatch: expected applicationLabel to be "${productName}", received "${label}".`,
    );
  }

  const permissions = nativeAndroidPermissions(metadata);
  for (const permission of expectedPermissions) {
    if (!permissions.includes(permission)) {
      throw new Error(
        `Native Android permission mismatch: compiled APK is missing ${permission}.`,
      );
    }
  }

  return {
    label,
    permissions,
  };
}

export function validateNativeArtifactMetadata({
  platform,
  metadata,
  productName,
  expectedPermissionDescriptions,
  expectedPermissions,
}) {
  if (platform === "ios") {
    return validateNativeIosMetadata({
      metadata,
      productName,
      expectedPermissionDescriptions,
    });
  }
  if (platform === "android") {
    return validateNativeAndroidMetadata({
      metadata,
      productName,
      expectedPermissions,
    });
  }
  throw new Error(`Unsupported native branding platform: ${platform}.`);
}

function nativeBrandingReport({
  platform,
  buildId,
  metadataPath,
  productName,
  status,
  details,
  error,
}) {
  const lines = [
    "# Native branding validation",
    "",
    `- Platform: **${platform}**`,
    `- Candidate build ID: \`${buildId}\``,
    `- Status: **${status}**`,
    `- Approved product name: \`${productName}\``,
    `- Inspected metadata: \`${metadataPath}\``,
  ];

  if (details) {
    lines.push("", "## Inspected values", "");
    if (details.label) {
      lines.push(`- Native label: \`${details.label}\``);
    }
    if (details.bundleName) {
      lines.push(`- Bundle name: \`${details.bundleName}\``);
    }
    if (details.cameraUsageDescription) {
      lines.push(
        `- Camera permission copy: \`${details.cameraUsageDescription}\``,
      );
    }
    if (details.microphoneUsageDescription) {
      lines.push(
        `- Microphone permission copy: \`${details.microphoneUsageDescription}\``,
      );
    }
    if (details.permissions) {
      lines.push(
        `- Declared camera/microphone permissions: \`${details.permissions
          .filter(
            (permission) =>
              permission === "android.permission.CAMERA" ||
              permission === "android.permission.RECORD_AUDIO",
          )
          .join(", ")}\``,
      );
    }
  }

  if (error) {
    lines.push("", "## Failure", "", `\`${error.message}\``);
  }

  lines.push(
    "",
    "The representative-device permission prompt and launcher rendering remain a manual supplement; platform UI is not fully represented in build metadata.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function parseNativeArguments(argv) {
  const argumentsByName = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}.`);
    }
    argumentsByName.set(name, value);
    index += 1;
  }
  return argumentsByName;
}

function runNativeValidation() {
  const argumentsByName = parseNativeArguments(
    process.argv
      .slice(2)
      .filter((argument) => argument !== "--native" && argument !== "--"),
  );
  const platform = argumentsByName.get("platform");
  const metadataPath = argumentsByName.get("metadata");
  const buildId = argumentsByName.get("build-id");
  const resultsDir = argumentsByName.get("results-dir");

  for (const [name, value] of [
    ["platform", platform],
    ["metadata", metadataPath],
    ["build-id", buildId],
    ["results-dir", resultsDir],
  ]) {
    if (!value) {
      throw new Error(`Native branding validation requires --${name}.`);
    }
  }

  const brandingSource = readFileSync(brandingPath, "utf8");
  const appMetadataSource = readFileSync(appMetadataPath, "utf8");
  const appMetadata = JSON.parse(appMetadataSource);
  const productName = validateBrandingFiles({
    brandingSource,
    appMetadataSource,
  });
  const reportPath = path.join(resultsDir, "native-branding-check.md");
  let report;

  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const details = validateNativeArtifactMetadata({
      platform,
      metadata,
      productName,
      expectedPermissionDescriptions: {
        camera: appMetadata?.expo?.ios?.infoPlist?.NSCameraUsageDescription,
        microphone:
          appMetadata?.expo?.ios?.infoPlist?.NSMicrophoneUsageDescription,
      },
      expectedPermissions: appMetadata?.expo?.android?.permissions,
    });
    report = nativeBrandingReport({
      platform,
      buildId,
      metadataPath,
      productName,
      status: "PASS",
      details,
    });
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(reportPath, report);
    console.log(`Native ${platform} branding matches: ${productName}`);
  } catch (error) {
    report = nativeBrandingReport({
      platform,
      buildId,
      metadataPath,
      productName,
      status: "FAIL",
      error,
    });
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(reportPath, report);
    throw error;
  }
}

function main() {
  const productName = validateBrandingFiles({
    brandingSource: readFileSync(brandingPath, "utf8"),
    appMetadataSource: readFileSync(appMetadataPath, "utf8"),
  });
  console.log(`Branding metadata matches: ${productName}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--native")) {
    runNativeValidation();
  } else {
    main();
  }
}
