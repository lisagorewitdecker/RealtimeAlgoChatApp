type AnalyticsData = Record<string, string | number | boolean>;

type AnalyticsGlobal = typeof globalThis & {
  document?: unknown;
  umami?: {
    track(name: string, data?: AnalyticsData): void;
  };
};

export function textLengthBucket(value: string): string {
  const length = value.length;

  if (length === 0) return "empty";
  if (length <= 40) return "1_40";
  if (length <= 160) return "41_160";
  if (length <= 500) return "161_500";
  return "over_500";
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  const browser = globalThis as AnalyticsGlobal;

  // Replit-hosted analytics is injected into published web experiences only.
  if (!browser.document) return;

  try {
    browser.umami?.track(name, data);
  } catch {
    // Analytics must never interfere with the product experience.
  }
}