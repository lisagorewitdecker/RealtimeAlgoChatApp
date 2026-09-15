/**
 * AI coding assistant route.
 * POST /api/ai/code-assist — streaming Claude response for coding questions.
 * The conversation history is kept client-side; the server is stateless.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { anthropic } from "@workspace/integrations-anthropic-ai";

const router = Router();

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export const SYSTEM_PROMPT = `You are RealtimeAlgoChatApp Studio's AI coding assistant — a senior software engineer who specializes in helping developers debug, design, and ship code.

Guidelines:
- Give clear, concise answers focused on the question asked.
- Always include working code examples when relevant.
- When showing code, use appropriate language syntax highlighting markers.
- If you spot a bug or potential issue in shared code, point it out proactively.
- For architecture questions, consider tradeoffs and explain your reasoning.
- Keep responses focused and actionable — avoid unnecessary preamble.`;

// POST /api/ai/code-assist
router.post("/code-assist", requireAuth, async (req: Request, res: Response) => {
  const { messages } = req.body as { messages?: unknown };

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array required" });
    return;
  }

  // Validate and sanitize messages
  const chatMessages: ChatMessage[] = [];
  for (const m of messages) {
    if (
      typeof m !== "object" ||
      m === null ||
      !["user", "assistant"].includes((m as Record<string, unknown>).role as string) ||
      typeof (m as Record<string, unknown>).content !== "string"
    ) {
      res.status(400).json({ error: "Invalid message format" });
      return;
    }
    chatMessages.push({
      role: (m as Record<string, unknown>).role as "user" | "assistant",
      content: ((m as Record<string, unknown>).content as string).slice(0, 16000),
    });
  }

  // Limit conversation depth to 20 messages to manage tokens
  const trimmed = chatMessages.slice(-20);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: trimmed,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI service error";
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.end();
  }
});

export default router;
