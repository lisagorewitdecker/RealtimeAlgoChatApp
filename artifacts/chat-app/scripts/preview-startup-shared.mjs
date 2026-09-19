// Helpers shared by the preview-startup preflight (validate-preview-startup.mjs)
// and the launch-evidence probe (preview-launch-evidence.mjs). They live apart
// from either script so that neither one imports the other's evidence readers.

// Five minutes is long enough for a cold CI preview while preventing a
// misconfigured job from waiting indefinitely.
export const MAX_PREVIEW_TIMEOUT_MS = 5 * 60_000;

export const READY_MARKERS = [/Starting Metro Bundler/i, /› Metro:/i];

export function parsePreviewTimeout(name, value, defaultValue) {
  if (value == null) return defaultValue;

  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `${name} must be a positive finite number of milliseconds.`,
    );
  }
  if (timeoutMs > MAX_PREVIEW_TIMEOUT_MS) {
    throw new Error(
      `${name} must be between 1 and ${MAX_PREVIEW_TIMEOUT_MS} milliseconds.`,
    );
  }

  return timeoutMs;
}
