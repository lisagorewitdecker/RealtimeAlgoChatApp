const mockConstants = {
  executionEnvironment: "bare",
  expoConfig: {
    version: "2.3.4",
    runtimeVersion: "57.1.0",
  },
  expoRuntimeVersion: "57.1.0",
  manifest: null,
  manifest2: {
    createdAt: "2026-09-12T10:30:00.000Z",
  },
};

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: mockConstants,
  ExecutionEnvironment: {
    Bare: "bare",
    Standalone: "standalone",
    StoreClient: "storeClient",
  },
}));

const mockReleaseMetadata = {
  buildId: undefined as string | undefined,
  createdAt: undefined as string | undefined,
};

jest.mock("@/constants/releaseCrashReporting", () => ({
  get RELEASE_SENTRY_BUILD_ID() {
    return mockReleaseMetadata.buildId;
  },
  get RELEASE_BUILD_CREATED_AT() {
    return mockReleaseMetadata.createdAt;
  },
}));

describe("getBuildIdentity", () => {
  beforeEach(() => {
    jest.resetModules();
    mockConstants.executionEnvironment = "bare";
    mockConstants.expoConfig = {
      version: "2.3.4",
      runtimeVersion: "57.1.0",
    };
    mockConstants.expoRuntimeVersion = "57.1.0";
    mockConstants.manifest = null;
    mockConstants.manifest2 = {
      createdAt: "2026-09-12T10:30:00.000Z",
    };
    mockReleaseMetadata.buildId = undefined;
    mockReleaseMetadata.createdAt = undefined;
  });

  it("reports the public build metadata from Expo constants", () => {
    const { getBuildIdentity } = require("../lib/buildIdentity");

    expect(getBuildIdentity()).toEqual({
      appVersion: "2.3.4",
      createdAt: "2026-09-12T10:30:00.000Z",
      runtimeVersion: "57.1.0",
      clientType: "Development preview",
      buildId: "Unavailable",
    });
  });

  it("identifies an embedded native candidate without a remote update manifest", () => {
    mockConstants.manifest2 = null as unknown as typeof mockConstants.manifest2;
    mockReleaseMetadata.buildId = "eas-build-candidate-a";
    mockReleaseMetadata.createdAt = "2026-09-12T11:45:00.000Z";
    const { getBuildIdentity } = require("../lib/buildIdentity");

    expect(getBuildIdentity()).toMatchObject({
      buildId: "eas-build-candidate-a",
      createdAt: "2026-09-12T11:45:00.000Z",
    });

    mockReleaseMetadata.buildId = "eas-build-candidate-b";
    expect(getBuildIdentity().buildId).toBe("eas-build-candidate-b");
  });

  it("uses explicit unavailable labels instead of leaking other manifest fields", () => {
    mockConstants.expoConfig = {} as typeof mockConstants.expoConfig;
    mockConstants.expoRuntimeVersion = null as unknown as string;
    mockConstants.manifest2 = {
      createdAt: "not-a-date",
      hostUri: "https://credential@example.test",
    } as typeof mockConstants.manifest2;
    const { getBuildIdentity } = require("../lib/buildIdentity");

    expect(getBuildIdentity()).toEqual({
      appVersion: "Unavailable",
      createdAt: "Unavailable",
      runtimeVersion: "Unavailable",
      clientType: "Development preview",
      buildId: "Unavailable",
    });
  });
});