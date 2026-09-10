import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extractProductName,
  validateBrandingFiles,
  validatePermissionDescriptions,
  validateBrandingValues,
  validateNativeArtifactMetadata,
  formatNativeBrandingSummary,
} from "./validate-branding.mjs";

const brandingPath = new URL("../constants/branding.ts", import.meta.url);
const appMetadataPath = new URL("../app.json", import.meta.url);

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

test("formats an iOS native branding summary with permission-copy status", () => {
  const summary = formatNativeBrandingSummary({
    platform: "ios",
    buildId: "ios-build",
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
  assert.match(summary, /Candidate build ID: `ios-build`/);
  assert.match(summary, /Native label: `RealtimeAlgoChatApp Studio`/);
  assert.match(summary, /Permission copy: \*\*PASS\*\*/);
});

test("formats a failed Android summary with the mismatched declaration", () => {
  const summary = formatNativeBrandingSummary({
    platform: "android",
    buildId: "android-build",
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
  assert.match(summary, /mismatched field|missing: android\.permission\.RECORD_AUDIO/);
  assert.match(summary, /native-branding-check\.md/);
});
