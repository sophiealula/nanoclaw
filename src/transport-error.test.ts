import { describe, it, expect } from 'vitest';
import { isRawTransportError } from './transport-error.js';

describe('isRawTransportError', () => {
  it('matches the 529 Overloaded shape that leaked to Telegram on 2026-05-14', () => {
    expect(
      isRawTransportError(
        'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Cb3Px"}',
      ),
    ).toBe(true);
  });

  it('matches the 400 surrogate-pair invalid_request_error shape', () => {
    expect(
      isRawTransportError(
        'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"no low surrogate"}}',
      ),
    ).toBe(true);
  });

  it('matches when the SDK adds leading whitespace', () => {
    expect(
      isRawTransportError('  API Error: 503 {"type":"error","error":{}}'),
    ).toBe(true);
  });

  it('matches the WRAPPED "Claude Code returned an error result:" form', () => {
    // Reviewer-identified shape: SDK sometimes prefixes the envelope with this
    // wrapper string. Hardened regex must catch both bare and wrapped forms.
    expect(
      isRawTransportError(
        'Claude Code returned an error result: API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"x"}}',
      ),
    ).toBe(true);
  });

  it('does NOT match a reply that quotes the status code without the SDK envelope', () => {
    // Hardened-regex anchor: false-positive elimination. A legit reply might
    // start with "API Error: 529" but won't have the literal `{"type":"error"`
    // JSON immediately following — that's only the SDK envelope.
    expect(
      isRawTransportError(
        "API Error: 529 happens when Anthropic's servers are overloaded.",
      ),
    ).toBe(false);
  });

  it('does NOT match when the agent legitimately answers a question that mentions "API Error"', () => {
    // e.g. user asks "what does API Error 529 mean?" and the agent explains —
    // the response wouldn't START with the literal SDK envelope prefix.
    expect(
      isRawTransportError(
        "An API Error 529 means Anthropic's servers are overloaded; the request was rejected.",
      ),
    ).toBe(false);
  });

  it('does NOT match a non-numeric status code suffix (defensive)', () => {
    expect(isRawTransportError('API Error: abc — something went wrong')).toBe(
      false,
    );
  });

  it('returns false on empty/falsy input', () => {
    expect(isRawTransportError('')).toBe(false);
  });
});
