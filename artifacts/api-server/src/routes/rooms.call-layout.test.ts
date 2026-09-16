import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { buildCallHtml } from "./rooms";

const viewports = [
  { name: "android-small", width: 320, height: 568 },
  { name: "iphone-se", width: 375, height: 667 },
] as const;

const stripScripts = (input: string): string => {
  let sanitized = input;
  let previous: string;
  do {
    previous = sanitized;
    sanitized = sanitized.replace(/<script[\s\S]*?<\/script>/g, "");
  } while (sanitized !== previous);
  return sanitized;
};

describe("embedded call large-text layout", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  for (const viewport of viewports) {
    it(`keeps call controls reachable at 140% on ${viewport.name}`, async () => {
      const page = await browser.newPage({
        viewport,
        reducedMotion: "reduce",
        forcedColors: "active",
      });
      const html = stripScripts(
        buildCallHtml({
          roomId: "native-layout-smoke",
          userId: "user-layout-smoke",
          username:
            "A very long platform-specific display name for layout checking",
          capability: "not-used-by-layout-test",
        }),
      );

      await page.setContent(html);
      await page.addStyleTag({
        content:
          "html{-webkit-text-size-adjust:140%!important;text-size-adjust:140%!important}",
      });

      const selectors = [
        "#status",
        "#nameTag",
        "#controls",
        "#muteBtn",
        "#cameraBtn",
        "#endBtn",
      ];
      for (const selector of selectors) {
        const box = await page.locator(selector).boundingBox();
        expect(box, `${selector} should render`).not.toBeNull();
        expect(
          box!.x,
          `${selector} should not clip left`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          box!.y,
          `${selector} should not clip above`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          box!.x + box!.width,
          `${selector} should not clip right`,
        ).toBeLessThanOrEqual(viewport.width + 0.5);
        expect(
          box!.y + box!.height,
          `${selector} should not clip below`,
        ).toBeLessThanOrEqual(viewport.height + 0.5);
      }

      const controls = await page.locator("#controls").boundingBox();
      const videos = await page.locator("#videos").boundingBox();
      expect(videos!.y + videos!.height).toBeLessThanOrEqual(controls!.y + 0.5);

      const outputDir =
        process.env["NATIVE_SMOKE_CALL_SCREENSHOT_DIR"] ??
        path.resolve("test-results/native-large-text-call");
      await fs.mkdir(outputDir, { recursive: true });
      await page.screenshot({
        path: path.join(outputDir, `${viewport.name}-140-percent.png`),
      });
      await page.close();
    }, 30_000);
  }
});
