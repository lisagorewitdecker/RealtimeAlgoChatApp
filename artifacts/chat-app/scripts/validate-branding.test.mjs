import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  candidateBuildFingerprint,
  extractProductName,
  parseNativeMetadata,
  validateBrandingFiles,
  validatePermissionDescriptions,
  validateBrandingValues,
  validateNativeArtifactMetadata,
  formatNativeBrandingSummary,
} from "./validate-branding.mjs";

const brandingPath = new URL("../constants/branding.ts", import.meta.url);
const appMetadataPath = new URL("../app.json", import.meta.url);

const approvedPermissionDescriptions = {
  camera: "RealtimeAlgoChatApp Studio uses your camera for video calls.",
  microphone:
    "RealtimeAlgoChatApp Studio uses your microphone for voice and video calls.",
};

/** Asserts the summary properties every failed native check must keep. */
function assertActionableFailure(summary, buildId) {
  assert.match(summary, /Status: \*\*FAIL\*\*/);
  assert.match(summary, new RegExp(`Candidate build ID: \`${buildId}\``));
  assert.match(
    summary,
    /Detailed report: \[native-branding-check\.md\]\(__NATIVE_BRANDING_REPORT_URL__\)/,
  );
}

test("runtime product name matches Expo app metadata", async () => {
  const productName = validateBrandingFiles({
    brandingSource: await readFile(brandingPath, "utf8"),
    appMetadataSource: await readFile(appMetadataPath, "utf8"),
  });

  assert.equal(productName, "RealtimeAlgoChatApp Studio");
});

test("reports both canonical sources when names diverge", () => {
  assert.throws(
    () =>
      validateBrandingValues({
        productName: "RealtimeAlgoChatApp Studio",
        appName: "A Different App",
      }),
    /artifacts\/chat-app\/constants\/branding\.ts.*artifacts\/chat-app\/app\.json/,
  );
});

test("rejects a missing Expo app name", () => {
  assert.throws(
    () =>
      validateBrandingValues({
        productName: "RealtimeAlgoChatApp Studio",
        appName: undefined,
      }),
    /expo\.name in artifacts\/chat-app\/app\.json/,
  );
});

test("reports the camera permission key when its branding drifts", () => {
  assert.throws(
    () =>
      validatePermissionDescriptions({
        productName: "RealtimeAlgoChatApp Studio",
        cameraUsageDescription: "The app uses your camera for video calls.",
        microphoneUsageDescription:
          "RealtimeAlgoChatApp Studio uses your microphone for video calls.",
      }),
    /app\.json ios\.infoPlist\.NSCameraUsageDescription.*branding\.ts/,
  );
});

test("reports the microphone permission key when its branding drifts", () => {
  assert.throws(
    () =>
      validatePermissionDescriptions({
        productName: "RealtimeAlgoChatApp Studio",
        cameraUsageDescription:
          "RealtimeAlgoChatApp Studio uses your camera for video calls.",
        microphoneUsageDescription:
          "The app uses your microphone for video calls.",
      }),
    /app\.json ios\.infoPlist\.NSMicrophoneUsageDescription.*branding\.ts/,
  );
});

test("extracts only the PRODUCT_NAME constant", () => {
  assert.equal(
    extractProductName(
      'const OTHER_NAME = "Compatibility value";\nexport const PRODUCT_NAME = "RealtimeAlgoChatApp Studio";',
    ),
    "RealtimeAlgoChatApp Studio",
  );
});

test("accepts native iOS labels and permission copy from built metadata", () => {
  assert.deepEqual(
    validateNativeArtifactMetadata({
      platform: "ios",
      productName: "RealtimeAlgoChatApp Studio",
      metadata: {
        CFBundleDisplayName: "RealtimeAlgoChatApp Studio",
        CFBundleName: "RealtimeAlgoChatApp Studio",
        NSCameraUsageDescription:
          "RealtimeAlgoChatApp Studio uses your camera for video calls.",
        NSMicrophoneUsageDescription:
          "RealtimeAlgoChatApp Studio uses your microphone for voice and video calls.",
      },
    }),
    {
      label: "RealtimeAlgoChatApp Studio",
      bundleName: "RealtimeAlgoChatApp Studio",
      cameraUsageDescription:
        "RealtimeAlgoChatApp Studio uses your camera for video calls.",
      microphoneUsageDescription:
        "RealtimeAlgoChatApp Studio uses your microphone for voice and video calls.",
    },
  );
});

test("accepts the Android application label and required permissions", () => {
  assert.deepEqual(
    validateNativeArtifactMetadata({
      platform: "android",
      productName: "RealtimeAlgoChatApp Studio",
      metadata: {
        applicationLabel: "RealtimeAlgoChatApp Studio",
        permissions: [
          "android.permission.CAMERA",
          "android.permission.RECORD_AUDIO",
          "android.permission.MODIFY_AUDIO_SETTINGS",
        ],
      },
    }),
    {
      label: "RealtimeAlgoChatApp Studio",
      permissions: [
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
      ],
    },
  );
});

test("rejects native label drift", () => {
  assert.throws(
    () =>
      validateNativeArtifactMetadata({
        platform: "ios",
        productName: "RealtimeAlgoChatApp Studio",
        metadata: {
          CFBundleDisplayName: "Old App",
          CFBundleName: "Old App",
          NSCameraUsageDescription: "Old App uses your camera.",
          NSMicrophoneUsageDescription: "Old App uses your microphone.",
        },
      }),
    /Native iOS label mismatch/,
  );
});

test("rejects native iOS permission-copy drift", () => {
  assert.throws(
    () =>
      validateNativeArtifactMetadata({
        platform: "ios",
        productName: "RealtimeAlgoChatApp Studio",
        expectedPermissionDescriptions: {
          camera:
            "RealtimeAlgoChatApp Studio uses your camera for video calls.",
          microphone:
            "RealtimeAlgoChatApp Studio uses your microphone for voice and video calls.",
        },
        metadata: {
          CFBundleDisplayName: "RealtimeAlgoChatApp Studio",
          CFBundleName: "chat-app",
          NSCameraUsageDescription:
            "RealtimeAlgoChatApp Studio uses your camera for a different reason.",
          NSMicrophoneUsageDescription:
            "RealtimeAlgoChatApp Studio uses your microphone for voice and video calls.",
        },
      }),
    /Native iOS permission copy mismatch/,
  );
});

test("rejects missing Android permission declarations", () => {
  assert.throws(
    () =>
      validateNativeArtifactMetadata({
        platform: "android",
        productName: "RealtimeAlgoChatApp Studio",
        metadata: {
          applicationLabel: "RealtimeAlgoChatApp Studio",
          permissions: ["android.permission.CAMERA"],
        },
      }),
    /compiled APK is missing android\.permission\.RECORD_AUDIO/,
  );
});

test("names the missing iOS label field before comparing branding", () => {
  assert.throws(
    () =>
      validateNativeArtifactMetadata({
        platform: "ios",
        productName: "RealtimeAlgoChatApp Studio",
        expectedPermissionDescriptions: approvedPermissionDescriptions,
        metadata: {
          CFBundleName: "RealtimeAlgoChatApp Studio",
          NSCameraUsageDescription: approvedPermissionDescriptions.camera,
          NSMicrophoneUsageDescription:
            approvedPermissionDescriptions.microphone,
        },
      }),
    /Native iOS metadata is missing CFBundleDisplayName/,
  );
});

test("names each missing iOS permission field", () => {
  for (const field of [
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
  ]) {
    const metadata = {
      CFBundleDisplayName: "RealtimeAlgoChatApp Studio",
      CFBundleName: "RealtimeAlgoChatApp Studio",
      NSCameraUsageDescription: approvedPermissionDescriptions.camera,
      NSMicrophoneUsageDescription: approvedPermissionDescriptions.microphone,
    };
    delete metadata[field];
    assert.throws(
      () =>
        validateNativeArtifactMetadata({
          platform: "ios",
          productName: "RealtimeAlgoChatApp Studio",
          expectedPermissionDescriptions: approvedPermissionDescriptions,
          metadata,
        }),
      new RegExp(`Native iOS metadata is missing ${field}`),
    );
  }
});

test("names the absent Android permission declarations", () => {
  assert.throws(
    () =>
      validateNativeArtifactMetadata({
        platform: "android",
        productName: "RealtimeAlgoChatApp Studio",
        expectedPermissions: ["android.permission.CAMERA"],
        metadata: { applicationLabel: "RealtimeAlgoChatApp Studio" },
      }),
    /Native Android metadata is missing permissions/,
  );
});

test("reports malformed native metadata with a fixed reason", () => {
  // Parser messages quote the input; the candidate metadata carries private
  // identifiers that must not reach the report, summary, or workflow log.
  const privateIdentifier = "com.example.private-app-id";
  assert.throws(
    () =>
      parseNativeMetadata({
        platform: "ios",
        source: `{ "CFBundleIdentifier": "${privateIdentifier}", `,
      }),
    (error) => {
      assert.match(error.message, /Native iOS metadata is not valid JSON/);
      assert.doesNotMatch(error.message, new RegExp(privateIdentifier));
      assert.doesNotMatch(error.message, /position|token/i);
      return true;
    },
  );
  assert.throws(
    () =>
      parseNativeMetadata({
        platform: "android",
        source: `not json ${privateIdentifier}`,
      }),
    (error) => {
      assert.match(error.message, /Native Android metadata is not valid JSON/);
      assert.doesNotMatch(error.message, new RegExp(privateIdentifier));
      return true;
    },
  );
  assert.throws(
    () => parseNativeMetadata({ platform: "android", source: "[]" }),
    /Native Android metadata is not a JSON object/,
  );
  assert.deepEqual(
    parseNativeMetadata({ platform: "ios", source: '{"CFBundleName":"x"}' }),
    { CFBundleName: "x" },
  );
});

test("formats an iOS native branding summary with permission-copy status", () => {
  const summary = formatNativeBrandingSummary({
    platform: "ios",
    buildId: "ios-candidate-build-id",
    productName: "RealtimeAlgoChatApp Studio",
    status: "PASS",
    metadata: {
      CFBundleDisplayName: "RealtimeAlgoChatApp Studio",
      NSCameraUsageDescription:
        "RealtimeAlgoChatApp Studio uses your camera for video calls.",
      NSMicrophoneUsageDescription:
        "RealtimeAlgoChatApp Studio uses your microphone for voice and video calls.",
    },
    expectedPermissionDescriptions: {
      camera: "RealtimeAlgoChatApp Studio uses your camera for video calls.",
      microphone:
        "RealtimeAlgoChatApp Studio uses your microphone for voice and video calls.",
    },
  });

  assert.match(summary, /Status: \*\*PASS\*\*/);
  assert.match(
    summary,
    /Candidate build ID: `ios-candidate-build-id`/,
  );
  assert.match(
    summary,
    new RegExp(
      `Candidate build fingerprint \\(SHA-256\\): \`${candidateBuildFingerprint("ios-candidate-build-id")}\``,
    ),
  );
  assert.match(summary, /Native label: `RealtimeAlgoChatApp Studio`/);
  assert.match(summary, /Permission copy: \*\*PASS\*\*/);
});

test("shows the non-secret candidate build ID in the step-summary fragment", () => {
  const summary = formatNativeBrandingSummary({
    platform: "ios",
    productName: "RealtimeAlgoChatApp Studio",
    status: "FAIL",
    metadata: { CFBundleDisplayName: "Old App" },
    expectedPermissionDescriptions: {},
    error: new Error("Native iOS label mismatch."),
    buildId: "ios-candidate-build-id",
  });

  assert.match(summary, /Candidate build ID: `ios-candidate-build-id`/);
});

test("formats a failed Android summary with the mismatched declaration", () => {
  const summary = formatNativeBrandingSummary({
    platform: "android",
    buildId: "android-candidate-build-id",
    productName: "RealtimeAlgoChatApp Studio",
    status: "FAIL",
    metadata: {
      applicationLabel: "Old App",
      permissions: ["android.permission.CAMERA"],
    },
    expectedPermissions: [
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
    ],
    error: new Error(
      'Native Android label mismatch: expected applicationLabel to be "RealtimeAlgoChatApp Studio", received "Old App".',
    ),
  });

  assert.match(summary, /Status: \*\*FAIL\*\*/);
  assert.match(summary, /Permission declarations: \*\*FAIL\*\*/);
  assert.match(
    summary,
    /mismatched field|missing: android\.permission\.RECORD_AUDIO/,
  );
  assert.match(summary, /native-branding-check\.md/);
});

test("summarizes a missing iOS label as unavailable while keeping permission results", () => {
  const summary = formatNativeBrandingSummary({
    platform: "ios",
    buildId: "ios-no-label-build",
    productName: "RealtimeAlgoChatApp Studio",
    status: "FAIL",
    metadata: {
      CFBundleName: "RealtimeAlgoChatApp Studio",
      NSCameraUsageDescription: approvedPermissionDescriptions.camera,
      NSMicrophoneUsageDescription: approvedPermissionDescriptions.microphone,
    },
    expectedPermissionDescriptions: approvedPermissionDescriptions,
    error: new Error(
      "Native iOS metadata is missing CFBundleDisplayName; inspect the built release artifact rather than the source app.json.",
    ),
  });

  assertActionableFailure(summary, "ios-no-label-build");
  assert.match(summary, /Native label: `Unavailable`/);
  assert.match(summary, /Permission copy: \*\*PASS\*\* \(camera and microphone\)/);
  assert.match(summary, /Mismatch: `Native iOS metadata is missing CFBundleDisplayName/);
});

test("separates unavailable iOS permission fields from mismatched copy", () => {
  const summary = formatNativeBrandingSummary({
    platform: "ios",
    buildId: "ios-no-permission-build",
    productName: "RealtimeAlgoChatApp Studio",
    status: "FAIL",
    metadata: {
      CFBundleDisplayName: "RealtimeAlgoChatApp Studio",
      CFBundleName: "RealtimeAlgoChatApp Studio",
      NSMicrophoneUsageDescription: "Old copy for the microphone.",
    },
    expectedPermissionDescriptions: approvedPermissionDescriptions,
    error: new Error(
      "Native iOS metadata is missing NSCameraUsageDescription; inspect the built release artifact rather than the source app.json.",
    ),
  });

  assertActionableFailure(summary, "ios-no-permission-build");
  assert.match(summary, /Native label: `RealtimeAlgoChatApp Studio`/);
  assert.match(
    summary,
    /Permission copy: \*\*FAIL\*\* \(unavailable field: NSCameraUsageDescription; mismatched field: NSMicrophoneUsageDescription\)/,
  );
  assert.doesNotMatch(summary, /mismatched field: NSCameraUsageDescription/);
});

test("summarizes unparsed native metadata as unavailable rather than mismatched", () => {
  for (const [platform, permissionLabel] of [
    ["ios", "Permission copy"],
    ["android", "Permission declarations"],
  ]) {
    const summary = formatNativeBrandingSummary({
      platform,
      buildId: `${platform}-malformed-build`,
      productName: "RealtimeAlgoChatApp Studio",
      status: "FAIL",
      metadata: null,
      expectedPermissionDescriptions: approvedPermissionDescriptions,
      expectedPermissions: [
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
      ],
      error: new Error(
        `Native ${platform === "ios" ? "iOS" : "Android"} metadata is not valid JSON; inspect the uploaded native metadata file rather than the source app.json.`,
      ),
    });

    assertActionableFailure(summary, `${platform}-malformed-build`);
    assert.match(summary, /Native label: `Unavailable`/);
    assert.match(
      summary,
      new RegExp(
        `${permissionLabel}: \\*\\*UNAVAILABLE\\*\\* \\(native metadata could not be inspected\\)`,
      ),
    );
    assert.match(summary, /Mismatch: `Native (iOS|Android) metadata is not valid JSON/);
    assert.doesNotMatch(summary, /mismatched field|missing: android/);
  }
});

test("summarizes absent Android declarations as an unavailable field", () => {
  const summary = formatNativeBrandingSummary({
    platform: "android",
    buildId: "android-no-declarations-build",
    productName: "RealtimeAlgoChatApp Studio",
    status: "FAIL",
    metadata: { applicationLabel: "RealtimeAlgoChatApp Studio" },
    expectedPermissions: [
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
    ],
    error: new Error(
      "Native Android metadata is missing permissions; inspect the compiled APK manifest.",
    ),
  });

  assertActionableFailure(summary, "android-no-declarations-build");
  assert.match(summary, /Native label: `RealtimeAlgoChatApp Studio`/);
  assert.match(
    summary,
    /Permission declarations: \*\*FAIL\*\* \(unavailable field: permissions\)/,
  );
  assert.doesNotMatch(summary, /missing: android\.permission/);
  assert.match(summary, /Mismatch: `Native Android metadata is missing permissions/);
});
