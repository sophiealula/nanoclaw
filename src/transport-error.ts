/**
 * Detect raw transport-level errors returned by the Claude Code SDK as
 * `result` strings (e.g. `API Error: 529 {"type":"error",...}`).
 *
 * Why: when Anthropic's API returns an error (429/500/529/etc), the SDK
 * surfaces it in headless mode as `{status: 'success', result: 'API Error: ...'}`
 * — `status` is "success" because the SDK process itself ran to completion.
 * The orchestrator's "forward result to user" code paths must not relay these
 * to the user; they should be logged and routed to the error/retry path
 * instead.
 */
export function isRawTransportError(text: string): boolean {
  if (!text) return false;
  // Match both shapes the SDK is known to emit:
  //   1. Bare:    `API Error: 529 {"type":"error",...}`
  //   2. Wrapped: `Claude Code returned an error result: API Error: 400 {"type":"error",...}`
  // The `{"type":"error"` JSON anchor eliminates false positives — a legit
  // agent reply that happens to mention "API Error: 529" won't have the
  // SDK's exact envelope structure immediately following the status code.
  return /^\s*(?:Claude Code returned an error result:\s*)?API Error:\s*\d{3}\s*\{"type":"error"/.test(
    text,
  );
}
