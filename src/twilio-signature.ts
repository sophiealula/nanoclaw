import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Twilio signs every webhook: base64(HMAC-SHA1(authToken, url + concat(sorted POST params as key+value))).
 * For GET requests the query string is part of the URL and there are no body params.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
