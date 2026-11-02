import { Platform } from "react-native";
import { clerkTokenCache } from "../lib/clerkTokenCache";

const mockWebStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
};

describe("clerkTokenCache on web", () => {
  const originalPlatform = Platform.OS;
  let originalWindowDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: mockWebStorage },
    });
    Platform.OS = "web";
    mockWebStorage.getItem.mockReset().mockReturnValue("legacy-token");
    mockWebStorage.setItem.mockReset();
    mockWebStorage.removeItem.mockReset();
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("drops legacy storage and keeps tokens in memory until cleared", async () => {
    await expect(clerkTokenCache.getToken("legacy-session")).resolves.toBeNull();
    expect(mockWebStorage.removeItem).toHaveBeenCalledWith("legacy-session");
    expect(mockWebStorage.getItem).not.toHaveBeenCalled();

    await clerkTokenCache.saveToken("session", "token-value");
    await expect(clerkTokenCache.getToken("session")).resolves.toBe("token-value");
    await clerkTokenCache.clearToken("session");
    await expect(clerkTokenCache.getToken("session")).resolves.toBeNull();
    expect(mockWebStorage.setItem).not.toHaveBeenCalled();
  });
});
