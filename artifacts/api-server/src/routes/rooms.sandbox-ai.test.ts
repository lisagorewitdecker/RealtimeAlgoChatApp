import { describe, expect, it, vi } from "vitest";

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

import { buildSandboxHtmlWithAssistant } from "./rooms.js";

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
      "socket=io({path:'/api/socket.io',auth:{token:CAPABILITY},reconnection:false})",
    );
    expect(html).toContain("socket.emit('join-room',{roomId:ROOM_ID,createIfMissing:true})");
    expect(html).toContain(
      "socket.emit('sandbox-update',{roomId:ROOM_ID,ciphertext:encrypted.ciphertextB64,nonce:encrypted.nonceB64})",
    );
    expect(html).toContain("socket.on('sandbox-update'");
    expect(html).toContain("DevStudioCrypto.decryptText");
    expect(html).toContain("DevStudioCrypto?.encryptText");
    expect(html).not.toContain("assistant-request");
    expect(html).not.toContain("files:{html:");
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
