import { describe, it, expect } from 'vitest';

import { isAllowedProxyClient } from './credential-proxy.js';

describe('isAllowedProxyClient', () => {
  it('allows loopback and container bridges', () => {
    for (const a of [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '192.168.64.7',
      '::ffff:192.168.64.2',
      '172.17.0.2',
    ]) {
      expect(isAllowedProxyClient(a), a).toBe(true);
    }
  });
  it('rejects LAN, public, and missing addresses', () => {
    for (const a of [
      '192.168.1.20',
      '10.0.0.5',
      '8.8.8.8',
      '::ffff:192.168.0.9',
      '',
      undefined,
    ]) {
      expect(isAllowedProxyClient(a), String(a)).toBe(false);
    }
  });
});
