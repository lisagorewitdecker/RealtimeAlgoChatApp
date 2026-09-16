/**
 * Limits shared by the Socket.IO assistant handler (which enforces them) and
 * the generated sandbox document (which checks them before sending, so users
 * get an immediate message instead of a server rejection).
 *
 * This module deliberately has no imports: tests mock the assistant streaming
 * helper and the socket module, and the limits must stay real under both.
 */
export const MAX_ASSISTANT_PROMPT_LENGTH = 2_000;
export const MAX_ASSISTANT_FILE_LENGTH = 12_000;
export const MAX_ASSISTANT_CONTEXT_LENGTH = 24_000;
export const ASSISTANT_TIMEOUT_MS = 45_000;
export const ASSISTANT_REQUEST_COOLDOWN_MS = 1_000;

/**
 * Payload field a sandbox client sets to `true` once the user has confirmed
 * the AI disclosure notice. The server never contacts the model without it.
 */
export const ASSISTANT_DISCLOSURE_FIELD = "disclosureAcknowledged";

export const ASSISTANT_DISCLOSURE_REQUIRED_MESSAGE =
  "Confirm the AI privacy notice first: your sandbox files and question are sent readable to the AI service, outside this room's end-to-end encryption.";
