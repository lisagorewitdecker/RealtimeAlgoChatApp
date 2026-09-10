import { textLengthBucket, trackEvent } from "@/utils/analytics";

type TestAnalyticsGlobal = {
  document?: unknown;
  umami?: {
    track: jest.Mock;
  };
};

const analyticsGlobal = globalThis as unknown as TestAnalyticsGlobal;
const originalDocument = analyticsGlobal.document;
const originalUmami = analyticsGlobal.umami;

afterEach(() => {
  if (originalDocument === undefined) {
    delete analyticsGlobal.document;
  } else {
    analyticsGlobal.document = originalDocument;
  }

  if (originalUmami === undefined) {
    delete analyticsGlobal.umami;
  } else {
    analyticsGlobal.umami = originalUmami;
  }
});

describe("analytics", () => {
  it("groups text lengths without exposing text", () => {
    expect(textLengthBucket("")).toBe("empty");
    expect(textLengthBucket("a".repeat(40))).toBe("1_40");
    expect(textLengthBucket("a".repeat(41))).toBe("41_160");
    expect(textLengthBucket("a".repeat(161))).toBe("161_500");
    expect(textLengthBucket("a".repeat(501))).toBe("over_500");
  });

  it("does nothing outside a browser", () => {
    delete analyticsGlobal.document;
    analyticsGlobal.umami = { track: jest.fn() };

    trackEvent("message_sent", { length_bucket: "1_40" });

    expect(analyticsGlobal.umami.track).not.toHaveBeenCalled();
  });

  it("forwards custom events to the injected web tracker", () => {
    const track = jest.fn();
    analyticsGlobal.document = {};
    analyticsGlobal.umami = { track };

    trackEvent("room_joined", { entry_mode: "join" });

    expect(track).toHaveBeenCalledWith("room_joined", {
      entry_mode: "join",
    });
  });

  it("never lets tracker failures break the app", () => {
    analyticsGlobal.document = {};
    analyticsGlobal.umami = {
      track: jest.fn(() => {
        throw new Error("tracker unavailable");
      }),
    };

    expect(() => trackEvent("call_opened")).not.toThrow();
  });
});