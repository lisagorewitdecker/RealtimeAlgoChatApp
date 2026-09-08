import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "./ai";

describe("AI coding assistant branding", () => {
  it("identifies the assistant as part of RealtimeAlgoChatApp Studio", () => {
    expect(SYSTEM_PROMPT).toContain(
      "You are RealtimeAlgoChatApp Studio's AI coding assistant",
    );
    expect(SYSTEM_PROMPT).not.toContain("DevStudio");
    expect(SYSTEM_PROMPT).not.toContain("ChatSphere");
  });
});