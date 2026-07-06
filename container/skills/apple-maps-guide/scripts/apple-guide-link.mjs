#!/usr/bin/env node
// Generate Apple Maps guide share links entirely offline.
//
// The whole guide (name + places) is a base64 protobuf carried in the URL —
// no server state, no auth. Schema reverse-engineered by James Remeika (2020),
// still current in 2026 (verified against a live gotoapplemaps.com link):
//
//   message Collection {
//     string name = 1;
//     message Location {
//       int32 lsp = 1;            // observed: 9902
//       uint64 appleMapsId = 2;   // numeric "muid" — hex of a MapKit Place ID (I<hex>)
//       string address = 3;
//       Coordinates coordinates = 4;  // { double latitude = 1; double longitude = 2; }
//       string name = 5;
//     }
//     repeated Location location = 2;
//   }
//
// A place needs EITHER appleMapsId (links to the real place card) OR
// name + address and/or coordinates (drops a labeled pin).
//
// Deployment copy — canonical source: ~/projects/personal/create_my_map/src/apple-guide-link.js
// Usage:
//   node apple-guide-link.js '{"name":"Guide","places":[{"name":"Spot","address":"123 St, City","lat":45.5,"lon":-73.6}]}'
//   echo '<json>' | node apple-guide-link.js
//   Place fields: name, address, lat, lon, appleMapsId (decimal string or "I<hex>" MapKit Place ID)

import { readFileSync } from 'node:fs';

function varint(nBig) {
  let n = BigInt(nBig);
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return Buffer.from(out);
}

function lenDelim(fieldNo, buf) {
  return Buffer.concat([varint(BigInt(fieldNo << 3) | 2n), varint(BigInt(buf.length)), buf]);
}

function varintField(fieldNo, value) {
  return Buffer.concat([varint(BigInt(fieldNo << 3) | 0n), varint(value)]);
}

function doubleField(fieldNo, value) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(value);
  return Buffer.concat([varint(BigInt(fieldNo << 3) | 1n), b]);
}

function encodePlace(p) {
  const parts = [varintField(1, 9902n)]; // lsp — constant observed in live links
  if (p.appleMapsId) {
    const id = String(p.appleMapsId);
    const muid = id.startsWith('I') ? BigInt('0x' + id.slice(1)) : BigInt(id);
    parts.push(varintField(2, muid));
  }
  if (p.address) parts.push(lenDelim(3, Buffer.from(p.address, 'utf8')));
  if (p.lat != null && p.lon != null) {
    parts.push(lenDelim(4, Buffer.concat([doubleField(1, p.lat), doubleField(2, p.lon)])));
  }
  if (p.name) parts.push(lenDelim(5, Buffer.from(p.name, 'utf8')));
  return Buffer.concat(parts);
}

function guideLink(guide) {
  if (!guide.name) throw new Error('guide.name is required');
  if (!Array.isArray(guide.places) || guide.places.length === 0)
    throw new Error('guide.places must be a non-empty array');
  for (const p of guide.places) {
    if (!p.appleMapsId && !(p.name && (p.address || (p.lat != null && p.lon != null))))
      throw new Error(`place "${p.name || '?'}" needs appleMapsId, or name + address/coords`);
  }
  const msg = Buffer.concat([
    lenDelim(1, Buffer.from(guide.name, 'utf8')),
    ...guide.places.map((p) => lenDelim(2, encodePlace(p))),
  ]);
  return 'https://maps.apple.com/guides?user=' + encodeURIComponent(msg.toString('base64'));
}

export { guideLink };

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] || readFileSync(0, 'utf8');
  console.log(guideLink(JSON.parse(input)));
}
