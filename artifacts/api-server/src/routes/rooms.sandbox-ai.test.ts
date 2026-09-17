import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/express", () => ({
  getAuth: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
  roomsTable: {},
  roomMembersTable: {},
  roomTombstonesTable: {},
  userProfilesTable: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock("../socket", () => ({
  getRooms: vi.fn(),
  runRoomOperation: vi.fn(),
}));

vi.mock("../lib/embedTickets", () => ({
  issueEmbedTicket: vi.fn(),
  redeemEmbedTicket: vi.fn(),
}));

import {
  MAX_ASSISTANT_CONTEXT_LENGTH,
  MAX_ASSISTANT_FILE_LENGTH,
  MAX_ASSISTANT_PROMPT_LENGTH,
} from "../lib/assistantLimits.js";
import { buildSandboxHtmlWithAssistant } from "./rooms.js";

const ROOM_ID = "room-ai-doc";
const CAPABILITY = "capability-token-must-never-leave-auth";
const ROOM_KEY = "room-key-must-never-be-sent-to-the-model";

function renderSandbox() {
  return buildSandboxHtmlWithAssistant({
    roomId: ROOM_ID,
    username: "Ada",
    capability: CAPABILITY,
  });
}

describe("sandbox page", () => {
  it("includes a room-scoped collaborative editor with a capability-authenticated connection", () => {
    const html = buildSandboxHtmlWithAssistant({
      roomId: "room-<script>",
      username: "Ada <Admin>",
      capability: "test-capability",
    });

    expect(html).toContain('id="htmlEditor"');
    expect(html).toContain('id="cssEditor"');
    expect(html).toContain('id="jsEditor"');
    expect(html).toContain('id="previewFrame" sandbox="allow-scripts"');
    expect(html).toContain('<script src="/api/crypto-client.js"></script>');
    expect(html).toContain('<script src="/api/socket-client.js"></script>');
    expect(html).toContain(
      "socket=io({path:'/api/socket.io',auth:{token:CAPABILITY},reconnection:true,reconnectionAttempts:15,reconnectionDelay:1500})",
    );
    expect(html).toContain("socket.emit('join-room',{roomId:ROOM_ID,createIfMissing:true})");
    expect(html).toContain(
      "socket.emit('sandbox-update',{roomId:ROOM_ID,ciphertext:encrypted.ciphertextB64,nonce:encrypted.nonceB64})",
    );
    expect(html).toContain("socket.on('sandbox-update'");
    expect(html).toContain("Connection restored — you can retry your question.");
    expect(html).toContain("Retry when the room reconnects.");
    expect(html).toContain("DevStudioCrypto.decryptText");
    expect(html).toContain("DevStudioCrypto?.encryptText");
  });

  it("adds an AI tab whose requests carry the disclosure acknowledgement and nothing secret", () => {
    const html = renderSandbox();

    expect(html).toContain('<div class="tab" data-tab="ai">');
    expect(html).toContain('id="ai-pane"');
    for (const id of [
      "ai-notice",
      "aiAcceptBtn",
      "aiDeclineBtn",
      "ai-declined",
      "aiReviewBtn",
      "ai-composer",
      "ai-reminder",
      "aiTurnOffBtn",
      "aiPrompt",
      "aiAskBtn",
      "aiRetryBtn",
      "aiStopBtn",
      "ai-status",
      "aiOutput",
    ]) {
      expect(html, `#${id} should exist`).toContain(`id="${id}"`);
    }

    // The notice must say what leaves the room, that E2EE does not cover it,
    // and that nothing is sent before confirmation.
    expect(html).toContain("sent readable to the AI service");
    expect(html).toContain("outside this room's end-to-end encryption");
    expect(html).toContain("Nothing is sent until you confirm");
    expect(html).toContain("Not sent: chat messages, the room's encryption key, or your sign-in token.");

    const emit = html.match(/socket\.emit\('assistant-request',(\{[^}]*\})\)/);
    expect(emit).not.toBeNull();
    expect(emit![1]).toBe(
      "{requestId,roomId:ROOM_ID,prompt,files,disclosureAcknowledged:true}",
    );
    expect(emit![1]).not.toContain("CAPABILITY");
    expect(emit![1]).not.toContain("ROOM_KEY");
    expect(html).toContain("socket.emit('assistant-cancel',{requestId:aiActive.requestId,roomId:ROOM_ID})");

    // Client-side caps stay aligned with the server's.
    expect(html).toContain(`maxlength="${MAX_ASSISTANT_PROMPT_LENGTH}"`);
    expect(html).toContain(
      `AI_LIMITS={prompt:${MAX_ASSISTANT_PROMPT_LENGTH},file:${MAX_ASSISTANT_FILE_LENGTH},context:${MAX_ASSISTANT_CONTEXT_LENGTH}}`,
    );
  });

  it("never turns model output into markup", () => {
    const html = renderSandbox();
    const script = html.match(/<script>([\s\S]*)<\/script><\/body>/)![1];

    expect(script).toContain("aiOutput.appendChild(document.createTextNode(p.text))");
    expect(script).not.toContain("innerHTML");
    expect(script).not.toContain("outerHTML");
    expect(script).not.toContain("insertAdjacentHTML");
    expect(script).not.toContain("document.write");
    expect(script).not.toMatch(/\beval\(/);
    // The document is a server template, so the inline script must not leak
    // interpolation syntax or terminate itself early.
    expect(script).not.toContain("${");
    expect(script).not.toContain("</script>");
    expect(() => new Function(script)).not.toThrow();
  });

  it("keeps room identity HTML-escaped and out of executable template interpolation", () => {
    const html = buildSandboxHtmlWithAssistant({
      roomId: "room-<script>",
      username: "Ada <Admin>",
      capability: "test-capability",
    });

    expect(html).toContain("#room-&lt;script&gt;");
    expect(html).toContain("Ada &lt;Admin&gt;");
    expect(html).not.toContain("#room-<script>");
  });
});

interface RecordedEmit {
  event: string;
  payload: unknown;
}

declare global {
  interface Window {
    __emits: RecordedEmit[];
    __fire: (event: string, payload: unknown) => void;
    __socket: { connect: () => void; disconnect: () => void };
  }
}

type SandboxBrowserWindow = {
  __emits: RecordedEmit[];
  __fire: (event: string, payload: unknown) => void;
  __socket: { connect: () => void; disconnect: () => void };
};

const FAKE_SOCKET_CLIENT = [
  "window.__emits=[];window.__handlers={};",
  "window.io=function(){const s={connected:true,",
  "on(ev,fn){(window.__handlers[ev]=window.__handlers[ev]||[]).push(fn);return s},",
  "emit(ev,p){window.__emits.push({event:ev,payload:JSON.parse(JSON.stringify(p))});return s},",
  "connect(){if(s.connected)return;s.connected=true;(window.__handlers.connect||[]).forEach(fn=>fn());return s},",
  "disconnect(){if(!s.connected)return;s.connected=false;(window.__handlers.disconnect||[]).forEach(fn=>fn());return s}};window.__socket=s;return s};",
  "window.__socket=null;",
  "window.__fire=(ev,p)=>{if(window.__socket&&ev==='disconnect')window.__socket.connected=false;if(window.__socket&&ev==='connect')window.__socket.connected=true;(window.__handlers[ev]||[]).forEach(fn=>fn(p));};",
].join("");

const FAKE_CRYPTO_CLIENT =
  "window.DevStudioCrypto={decryptText:()=>null,encryptText:()=>null};";

describe("sandbox AI tab in a browser", () => {
  let browser: Browser;
  const html = renderSandbox();

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function openSandbox(options: { installClock?: boolean } = {}) {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
    if (options.installClock) await page.clock.install();
    await page.addInitScript(
      (key) => {
        const globals = globalThis as unknown as Record<string, unknown>;
        globals["__DEVSTUDIO_ROOM_KEY__"] = key;
        const storage = (globalThis as unknown as { localStorage: Storage })
          .localStorage;
        const sessionStorage = (
          globalThis as unknown as { sessionStorage: Storage }
        ).sessionStorage;
        if (sessionStorage.getItem("__sandbox_test_reset") !== "yes") {
          storage.removeItem("devstudio.sandbox-ai-disclosure.v1");
          sessionStorage.setItem("__sandbox_test_reset", "yes");
        }
      },
      ROOM_KEY,
    );
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.endsWith("/api/socket-client.js")) {
        return route.fulfill({
          contentType: "application/javascript",
          body: FAKE_SOCKET_CLIENT,
        });
      }
      if (url.endsWith("/api/crypto-client.js")) {
        return route.fulfill({
          contentType: "application/javascript",
          body: FAKE_CRYPTO_CLIENT,
        });
      }
      return route.fulfill({ contentType: "text/html", body: html });
    });
    await page.goto("http://sandbox.devstudio.test/api/rooms/sandbox");
    return page;
  }

  const emitsOf = (page: Page, event: string) =>
    page.evaluate(
      (name) =>
        (globalThis as unknown as SandboxBrowserWindow).__emits.filter(
          (emit: RecordedEmit) => emit.event === name,
        ),
      event,
    );

  const fire = (page: Page, event: string, payload: unknown) =>
    page.evaluate(
      ([name, data]) =>
        (globalThis as unknown as SandboxBrowserWindow).__fire(
          name as string,
          data,
        ),
      [event, payload],
    );

  const status = (page: Page) => page.locator("#ai-status").innerText();

  async function acceptDisclosure(page: Page) {
    await page.click('.tab[data-tab="ai"]');
    await page.click("#aiAcceptBtn");
    await expect(page.locator("#ai-composer").isVisible()).resolves.toBe(true);
  }

  async function ask(page: Page, prompt: string) {
    await page.fill("#aiPrompt", prompt);
    await page.click("#aiAskBtn");
    const requests = await emitsOf(page, "assistant-request");
    const last = requests.at(-1)?.payload as { requestId: string } | undefined;
    return last!.requestId;
  }

  it("shows the notice first, sends nothing until confirmed, and remembers the choice per device", async () => {
    const page = await openSandbox();

    await page.click('.tab[data-tab="ai"]');
    expect(await page.locator("#ai-notice").isVisible()).toBe(true);
    expect(await page.locator("#ai-composer").isVisible()).toBe(false);
    expect(await page.locator("#ai-notice").innerText()).toContain(
      "sent readable to the AI service",
    );

    await page.click("#aiDeclineBtn");
    expect(await page.locator("#ai-declined").isVisible()).toBe(true);
    expect(await page.locator("#ai-composer").isVisible()).toBe(false);
    expect(await page.locator("#aiPrompt").count()).toBe(1);
    expect(await page.locator("#aiPrompt").isVisible()).toBe(false);

    // Declining is remembered and the rest of the sandbox keeps working.
    await page.reload();
    await page.fill("#htmlEditor", "<p>still editable</p>");
    await page.click('.tab[data-tab="ai"]');
    expect(await page.locator("#ai-declined").isVisible()).toBe(true);
    expect(await page.locator("#ai-notice").isVisible()).toBe(false);

    await page.click("#aiReviewBtn");
    expect(await page.locator("#ai-notice").isVisible()).toBe(true);
    await page.click("#aiAcceptBtn");
    expect(await page.locator("#ai-composer").isVisible()).toBe(true);
    expect(await page.locator("#ai-reminder").innerText()).toContain(
      "outside this room's end-to-end encryption",
    );

    await page.reload();
    await page.click('.tab[data-tab="ai"]');
    expect(await page.locator("#ai-notice").isVisible()).toBe(false);
    expect(await page.locator("#ai-composer").isVisible()).toBe(true);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("devstudio.sandbox-ai-disclosure.v1"),
      ),
    ).toBe("accepted");

    // Turning it off again from the reminder hides the composer.
    await page.click("#aiTurnOffBtn");
    expect(await page.locator("#ai-declined").isVisible()).toBe(true);
    expect(await emitsOf(page, "assistant-request")).toEqual([]);
    await page.close();
  });

  it("sends only the current files and prompt with the acknowledgement, and renders replies as text", async () => {
    const page = await openSandbox();
    await page.fill("#htmlEditor", "<button class=\"go\">Go</button>");
    await page.click('.tab[data-tab="css"]');
    await page.fill("#cssEditor", ".go{width:120%}");
    await page.click('.tab[data-tab="js"]');
    await page.fill("#jsEditor", "console.log('hi')");
    await acceptDisclosure(page);

    const requestId = await ask(page, "Why does the button overflow?");
    const requests = await emitsOf(page, "assistant-request");
    expect(requests).toHaveLength(1);
    const payload = requests[0]!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "disclosureAcknowledged",
      "files",
      "prompt",
      "requestId",
      "roomId",
    ]);
    expect(payload).toMatchObject({
      roomId: ROOM_ID,
      prompt: "Why does the button overflow?",
      files: {
        html: "<button class=\"go\">Go</button>",
        css: ".go{width:120%}",
        js: "console.log('hi')",
      },
      disclosureAcknowledged: true,
    });
    expect(requestId).toMatch(/^[a-zA-Z0-9_-]{8,80}$/);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(CAPABILITY);
    expect(serialized).not.toContain(ROOM_KEY);

    expect(await page.locator("#aiAskBtn").isDisabled()).toBe(true);
    expect(await page.locator("#aiStopBtn").isVisible()).toBe(true);

    const hostile = "Use flex.\n<img src=x onerror=\"document.title='pwned'\"><script>alert(1)</script>";
    await fire(page, "assistant-chunk", { requestId, text: "Answer: " });
    await fire(page, "assistant-chunk", { requestId, text: hostile });
    await fire(page, "assistant-chunk", { requestId: "someone-elses-request", text: "IGNORED" });
    expect(await page.locator("#aiOutput").textContent()).toBe("Answer: " + hostile);
    expect(await page.locator("#aiOutput img, #aiOutput script").count()).toBe(0);
    expect(await page.title()).toBe("Sandbox");

    await fire(page, "assistant-done", { requestId, cancelled: false });
    expect(await status(page)).toBe("Done.");
    expect(await page.locator("#aiAskBtn").isDisabled()).toBe(false);
    expect(await page.locator("#aiStopBtn").isVisible()).toBe(false);
    await page.close();
  });

  it("stops a running reply, counts down rate limits, and surfaces failures clearly", async () => {
    const page = await openSandbox({ installClock: true });
    await acceptDisclosure(page);

    const first = await ask(page, "Explain this code.");
    await fire(page, "assistant-chunk", { requestId: first, text: "Partial" });
    await page.click("#aiStopBtn");
    expect(await emitsOf(page, "assistant-cancel")).toEqual([
      { event: "assistant-cancel", payload: { requestId: first, roomId: ROOM_ID } },
    ]);
    await fire(page, "assistant-done", { requestId: first, cancelled: true });
    expect(await status(page)).toContain("Stopped");
    expect(await page.locator("#aiOutput").textContent()).toBe("Partial");
    expect(await page.locator("#aiStopBtn").isVisible()).toBe(false);

    const second = await ask(page, "Explain this code again.");
    await fire(page, "assistant-error", {
      requestId: second,
      code: "RATE_LIMITED",
      retryAfterSeconds: 3,
      message: "The AI service is rate limited right now.",
    });
    expect(await status(page)).toContain("ask again in 3 s");
    expect(await page.locator("#aiAskBtn").isDisabled()).toBe(true);
    expect(await page.locator("#aiRetryBtn").isHidden()).toBe(true);
    await page.click("#aiAskBtn", { force: true });
    expect(await emitsOf(page, "assistant-request")).toHaveLength(2);
    await page.clock.runFor(3_000);
    expect(await status(page)).toBe("You can ask again now.");
    expect(await page.locator("#aiAskBtn").isDisabled()).toBe(false);

    const third = await ask(page, "One more time.");
    await fire(page, "assistant-error", {
      requestId: third,
      code: "TIMEOUT",
      message: "The assistant did not finish within 45 seconds. Any partial answer is kept; please try again.",
    });
    expect(await status(page)).toContain("did not finish within 45 seconds");
    expect(await page.locator("#aiAskBtn").isDisabled()).toBe(false);
    expect(await page.locator("#aiRetryBtn").isVisible()).toBe(true);

    await page.click('.tab[data-tab="html"]');
    await page.fill("#htmlEditor", "<main>latest</main>");
    await page.click('.tab[data-tab="ai"]');
    await page.click("#aiRetryBtn");
    const retryRequest = (await emitsOf(page, "assistant-request"))[3];
    const retryPayload = retryRequest.payload as {
      requestId: string;
      prompt: string;
      files: { html: string };
      disclosureAcknowledged: boolean;
    };
    expect(retryPayload).toMatchObject({
      prompt: "One more time.",
      files: { html: "<main>latest</main>" },
      disclosureAcknowledged: true,
    });
    expect(await page.locator("#aiRetryBtn").isHidden()).toBe(true);

    await fire(page, "assistant-error", {
      requestId: retryPayload.requestId,
      code: "SERVICE_ERROR",
      message: "The AI service is temporarily unavailable. Please try again.",
    });
    expect(await page.locator("#aiRetryBtn").isVisible()).toBe(true);

    // A server-side gate rejection re-opens the notice instead of looping.
    const fourth = await ask(page, "And again.");
    await fire(page, "assistant-error", {
      requestId: fourth,
      code: "DISCLOSURE_REQUIRED",
      message: "Confirm the AI privacy notice first.",
    });
    expect(await page.locator("#aiRetryBtn").isHidden()).toBe(true);
    expect(await page.locator("#ai-notice").isVisible()).toBe(true);
    expect(await page.locator("#ai-composer").isVisible()).toBe(false);
    await page.close();
  });

  it("offers a guarded retry after an interrupted reply reconnects", async () => {
    const page = await openSandbox();
    await acceptDisclosure(page);

    const interrupted = await ask(page, "Explain this after reconnecting.");
    await page.evaluate(() => {
      (globalThis as unknown as SandboxBrowserWindow).__socket.disconnect();
    });
    expect(await status(page)).toBe(
      "Connection lost — the reply was interrupted. Retry when the room reconnects.",
    );
    expect(await page.locator("#aiRetryBtn").isVisible()).toBe(true);
    expect(await page.locator("#aiRetryBtn").isDisabled()).toBe(true);
    expect(await emitsOf(page, "assistant-request")).toHaveLength(1);

    await page.evaluate(() => {
      (globalThis as unknown as SandboxBrowserWindow).__socket.connect();
    });
    expect(await page.locator("#aiRetryBtn").isDisabled()).toBe(true);
    await fire(page, "room-joined", {});
    expect(await status(page)).toBe(
      "Connection restored — you can retry your question.",
    );
    expect(await page.locator("#aiRetryBtn").isDisabled()).toBe(false);

    // Events from the interrupted request can arrive after the room has
    // rejoined. None of them may replace the restored retry state.
    await fire(page, "assistant-chunk", {
      requestId: interrupted,
      text: "stale answer",
    });
    await fire(page, "assistant-done", {
      requestId: interrupted,
      cancelled: false,
    });
    await fire(page, "assistant-error", {
      requestId: interrupted,
      code: "SERVICE_ERROR",
      message: "Stale failure from the interrupted request.",
    });
    expect(await page.locator("#aiOutput").textContent()).toBe("");
    expect(await status(page)).toBe(
      "Connection restored — you can retry your question.",
    );
    expect(await page.locator("#aiRetryBtn").isVisible()).toBe(true);
    expect(await page.locator("#aiRetryBtn").isDisabled()).toBe(false);

    await page.click('.tab[data-tab="html"]');
    await page.fill("#htmlEditor", "<main>after reconnect</main>");
    await page.click('.tab[data-tab="ai"]');
    await page.click("#aiRetryBtn");

    const requests = await emitsOf(page, "assistant-request");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.payload).toMatchObject({
      prompt: "Explain this after reconnecting.",
      files: { html: "<main>after reconnect</main>" },
      disclosureAcknowledged: true,
    });
    expect((requests[1]!.payload as { requestId: string }).requestId).not.toBe(
      interrupted,
    );
    await page.close();
  });

  it("refuses to send empty prompts or files over the server limits", async () => {
    const page = await openSandbox();
    await acceptDisclosure(page);

    await page.click("#aiAskBtn");
    expect(await status(page)).toBe("Type a question first.");

    await page.click('.tab[data-tab="html"]');
    await page.fill("#htmlEditor", "x".repeat(MAX_ASSISTANT_FILE_LENGTH + 1));
    await page.click('.tab[data-tab="ai"]');
    await page.fill("#aiPrompt", "Is this too big?");
    await page.click("#aiAskBtn");
    expect(await status(page)).toContain("too large");
    expect(await emitsOf(page, "assistant-request")).toEqual([]);

    await page.click('.tab[data-tab="html"]');
    await page.fill("#htmlEditor", "x".repeat(MAX_ASSISTANT_FILE_LENGTH));
    await page.click('.tab[data-tab="css"]');
    await page.fill("#cssEditor", "y".repeat(MAX_ASSISTANT_FILE_LENGTH));
    await page.click('.tab[data-tab="js"]');
    await page.fill("#jsEditor", "z".repeat(MAX_ASSISTANT_CONTEXT_LENGTH - 2 * MAX_ASSISTANT_FILE_LENGTH + 1));
    await page.click('.tab[data-tab="ai"]');
    await page.click("#aiAskBtn");
    expect(await status(page)).toContain("too large");
    expect(await emitsOf(page, "assistant-request")).toEqual([]);

    await page.click('.tab[data-tab="js"]');
    await page.fill("#jsEditor", "");
    await page.click('.tab[data-tab="ai"]');
    await page.click("#aiAskBtn");
    expect(await emitsOf(page, "assistant-request")).toHaveLength(1);
    await page.close();
  });
});
