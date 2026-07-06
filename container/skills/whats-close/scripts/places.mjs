#!/usr/bin/env node
// Tiny place store + proximity query for the whats-close skill.
//
//   node places.mjs add '<place-json or array>'     append to the store (dedupes)
//   node places.mjs near <lat> <lon> [limit]        distance-sorted matches
//
// Place shape: { name, lat, lon, address?, city?, note?, source?, added? }
// Store: PLACES_FILE env var, default /workspace/group/places.json

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FILE = process.env.PLACES_FILE || '/workspace/group/places.json';

function load() {
  if (!existsSync(FILE)) return [];
  return JSON.parse(readFileSync(FILE, 'utf8'));
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'add') {
  const input = JSON.parse(args[0] || readFileSync(0, 'utf8'));
  const incoming = Array.isArray(input) ? input : [input];
  const places = load();
  const key = (p) =>
    `${p.name.toLowerCase()}|${p.lat?.toFixed(3)}|${p.lon?.toFixed(3)}`;
  const seen = new Set(places.map(key));
  let added = 0;
  for (const p of incoming) {
    if (!p.name || p.lat == null || p.lon == null)
      throw new Error(`place needs name+lat+lon: ${JSON.stringify(p)}`);
    if (seen.has(key(p))) continue;
    seen.add(key(p));
    places.push({ added: p.added || new Date().toISOString().slice(0, 10), ...p });
    added++;
  }
  writeFileSync(FILE, JSON.stringify(places, null, 2) + '\n');
  console.log(`${added} added, ${places.length} total`);
} else if (cmd === 'near') {
  const [lat, lon, limit] = [parseFloat(args[0]), parseFloat(args[1]), parseInt(args[2] || '8', 10)];
  if (Number.isNaN(lat) || Number.isNaN(lon)) throw new Error('usage: near <lat> <lon> [limit]');
  const ranked = load()
    .map((p) => ({ ...p, meters: haversineMeters(lat, lon, p.lat, p.lon) }))
    .sort((a, b) => a.meters - b.meters)
    .slice(0, limit)
    .map((p) => ({
      ...p,
      distance: p.meters < 1000 ? `${p.meters}m` : `${(p.meters / 1000).toFixed(1)}km`,
      walkMin: Math.max(1, Math.round(p.meters / 80)),
    }));
  console.log(JSON.stringify(ranked, null, 2));
} else {
  console.error('usage: places.mjs add <json> | near <lat> <lon> [limit]');
  process.exit(1);
}
