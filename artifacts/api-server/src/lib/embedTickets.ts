import { randomBytes } from "node:crypto";

/**
 * Short-lived, single-use tickets that let an embedded page (a browser
 * `<iframe>`, which cannot set an Authorization header) load a protected
 * HTML surface. A ticket is bound to a specific user + room and expires
 * quickly; the sensitive material (socket token, room key) is still
 * delivered separately over postMessage, never through the URL.
 */

const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 5_000;

interface EmbedTicket {
  userId: string;
  roomId: string;
  scope: string;
  expiresAt: number;
}

const tickets = new Map<string, EmbedTicket>();

function sweep() {
  const now = Date.now();
  for (const [id, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(id);
  }
}

export function issueEmbedTicket(
  userId: string,
  roomId: string,
  scope: string,
): { ticket: string; expiresIn: number } {
  sweep();
  if (tickets.size >= MAX_TICKETS) {
    // Drop the oldest entry rather than growing without bound.
    const oldest = tickets.keys().next();
    if (!oldest.done) tickets.delete(oldest.value);
  }
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, {
    userId,
    roomId,
    scope,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return { ticket, expiresIn: Math.floor(TICKET_TTL_MS / 1000) };
}

/** Consumes a ticket. Returns the userId it was issued to, or null. */
export function redeemEmbedTicket(
  ticket: string,
  roomId: string,
  scope: string,
): string | null {
  sweep();
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (entry.expiresAt <= Date.now()) return null;
  if (entry.roomId !== roomId || entry.scope !== scope) return null;
  return entry.userId;
}
