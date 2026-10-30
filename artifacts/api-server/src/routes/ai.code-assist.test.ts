import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockStream = vi.hoisted(() => vi.fn());

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { stream: mockStream } },
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import aiRouter from "./ai.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", aiRouter);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  mockStream.mockReset();
});

const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });

describe("POST /api/ai/code-assist", () => {
  it("does not reveal upstream error details to the client", async () => {
    mockStream.mockImplementation(() => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error("401 invalid x-api-key sk-ant-secret request_id=req_123");
      },
    }));

    const response = await fetch(`${baseUrl}/code-assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = await response.text();

    expect(text).toContain(JSON.stringify({ error: "AI service error" }));
    expect(text).not.toContain("sk-ant-secret");
    expect(text).not.toContain("req_123");
  });

  it("aborts the upstream stream when the client disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined;
    mockStream.mockImplementation(
      (_params: unknown, options: { signal: AbortSignal }) => {
        upstreamSignal = options.signal;
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "partial" },
            };
            await new Promise<never>((_resolve, reject) => {
              options.signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
            });
          },
        };
      },
    );

    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/code-assist",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", (error) => {
        if (!req.destroyed) reject(error);
      });
      req.end(body);
    });

    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
  });
});
