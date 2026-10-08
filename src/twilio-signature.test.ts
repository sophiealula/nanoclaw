import { describe, it, expect } from 'vitest';

import {
  computeTwilioSignature,
  verifyTwilioSignature,
} from './twilio-signature.js';

// Inputs from Twilio's webhook-security docs; expected value cross-checked against
// twilio-node's getExpectedTwilioSignature('12345', URL, PARAMS) on 2026-09-15.
const TOKEN = '12345';
const URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const PARAMS = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+14158675310',
  Digits: '1234',
  From: '+14158675310',
  To: '+18005551212',
};

describe('twilio signature', () => {
  it('matches the documented vector', () => {
    expect(computeTwilioSignature(TOKEN, URL, PARAMS)).toBe(
      'GvWf1cFY/Q7PnoempGyD5oXAezc=',
    );
  });
  it('verifies a correct signature and rejects a tampered one', () => {
    expect(
      verifyTwilioSignature(TOKEN, URL, PARAMS, 'GvWf1cFY/Q7PnoempGyD5oXAezc='),
    ).toBe(true);
    expect(
      verifyTwilioSignature(
        TOKEN,
        URL,
        { ...PARAMS, Digits: '9999' },
        'GvWf1cFY/Q7PnoempGyD5oXAezc=',
      ),
    ).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, undefined)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, 'short')).toBe(false);
  });
});
