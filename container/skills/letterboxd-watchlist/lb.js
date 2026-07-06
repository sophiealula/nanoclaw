#!/usr/bin/env node
// Letterboxd watchlist CLI — uses the official API via refresh-token auth.
// Creds live in /workspace/group/.letterboxd-api.json (override with $LB_CREDS).
//
// Usage:
//   lb.js add "<title>"
//   lb.js list [--limit N]
//   lb.js search "<title>"

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.letterboxd.com/api/v0';
const CREDS_PATH = process.env.LB_CREDS || '/workspace/group/.letterboxd-api.json';

// ---------- low-level HTTP ----------

function request(method, urlPath, { headers = {}, body = null, formBody = null } = {}) {
  const url = new URL(API_BASE + urlPath);
  const opts = {
    method,
    hostname: url.hostname,
    path: url.pathname + url.search,
    headers: { Accept: 'application/json', ...headers },
  };
  let payload = null;
  if (formBody) {
    payload = new URLSearchParams(formBody).toString();
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.headers['Content-Length'] = Buffer.byteLength(payload);
  } else if (body !== null) {
    payload = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- creds & token caching ----------

function loadCreds() {
  if (!fs.existsSync(CREDS_PATH)) {
    fail(`No Letterboxd creds at ${CREDS_PATH}. Capture them once via mitmproxy — see README.`);
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
}

function saveCreds(c) {
  const tmp = CREDS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CREDS_PATH);
}

async function getAccessToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  if (creds.access_token && creds.access_token_expires_at && creds.access_token_expires_at > now + 60) {
    return creds.access_token;
  }
  const basic = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64');
  const res = await request('POST', '/auth/token', {
    headers: { Authorization: `Basic ${basic}` },
    formBody: { grant_type: 'refresh_token', refresh_token: creds.refresh_token },
  });
  if (res.status !== 200 || !res.body || !res.body.access_token) {
    fail(`token refresh failed (status ${res.status}): ${res.raw}`);
  }
  creds.access_token = res.body.access_token;
  creds.access_token_expires_at = now + (res.body.expires_in || 3600);
  if (res.body.refresh_token) creds.refresh_token = res.body.refresh_token;
  saveCreds(creds);
  return creds.access_token;
}

async function authed(method, urlPath, opts = {}) {
  const creds = loadCreds();
  const token = await getAccessToken(creds);
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  return request(method, urlPath, { ...opts, headers });
}

// ---------- helpers ----------

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function findFilm(title) {
  const q = new URLSearchParams({ input: title, include: 'FilmSearchItem', perPage: '5' });
  const res = await authed('GET', `/search?${q}`);
  if (res.status !== 200) fail(`search failed (${res.status}): ${res.raw}`);
  const items = (res.body.items || []).filter((i) => i.type === 'FilmSearchItem' && i.film);
  if (!items.length) return null;
  return items[0].film; // { id, name, releaseYear, ... }
}

async function getMemberId() {
  const res = await authed('GET', '/me');
  if (res.status !== 200) fail(`/me failed (${res.status}): ${res.raw}`);
  return res.body.member.id;
}

// ---------- commands ----------

async function cmdAdd(title) {
  if (!title) fail('usage: lb.js add "<title>"');
  const film = await findFilm(title);
  if (!film) { console.log(`couldn't find "${title}" on letterboxd`); process.exit(2); }

  const relRes = await authed('GET', `/film/${film.id}/me`);
  if (relRes.status === 200 && relRes.body && relRes.body.inWatchlist) {
    console.log(`${film.name} (${film.releaseYear}) is already on your watchlist`);
    return;
  }

  const res = await authed('PATCH', `/film/${film.id}/me`, { body: { inWatchlist: true } });
  if (res.status >= 200 && res.status < 300) {
    console.log(`Added ${film.name} (${film.releaseYear}) to your watchlist`);
  } else {
    fail(`add failed (${res.status}): ${res.raw}`);
  }
}

async function cmdList(limit = 20) {
  const memberId = await getMemberId();
  const collected = [];
  let cursor = null;
  while (collected.length < limit) {
    const params = new URLSearchParams({ perPage: '100' });
    if (cursor) params.set('cursor', cursor);
    const res = await authed('GET', `/member/${memberId}/watchlist?${params}`);
    if (res.status !== 200) fail(`watchlist fetch failed (${res.status}): ${res.raw}`);
    const items = res.body.items || [];
    for (const f of items) {
      collected.push(f);
      if (collected.length >= limit) break;
    }
    cursor = res.body.next;
    if (!cursor || items.length === 0) break;
  }
  if (!collected.length) { console.log('your watchlist is empty'); return; }
  for (const f of collected) {
    console.log(`• ${f.name}${f.releaseYear ? ` (${f.releaseYear})` : ''}`);
  }
  console.log(`\n${collected.length} film${collected.length === 1 ? '' : 's'} shown`);
}

async function cmdRemove(title) {
  if (!title) fail('usage: lb.js remove "<title>"');
  const film = await findFilm(title);
  if (!film) { console.log(`couldn't find "${title}" on letterboxd`); process.exit(2); }
  const rel = await authed('GET', `/film/${film.id}/me`);
  if (rel.status === 200 && rel.body && !rel.body.inWatchlist) {
    console.log(`${film.name} (${film.releaseYear}) wasn't on your watchlist`);
    return;
  }
  const res = await authed('PATCH', `/film/${film.id}/me`, { body: { inWatchlist: false } });
  if (res.status >= 200 && res.status < 300) {
    console.log(`Removed ${film.name} (${film.releaseYear}) from your watchlist`);
  } else {
    fail(`remove failed (${res.status}): ${res.raw}`);
  }
}

async function cmdCheck(title) {
  if (!title) fail('usage: lb.js check "<title>"');
  const film = await findFilm(title);
  if (!film) { console.log(`couldn't find "${title}" on letterboxd`); process.exit(2); }
  const rel = await authed('GET', `/film/${film.id}/me`);
  if (rel.status !== 200) fail(`check failed (${rel.status}): ${rel.raw}`);
  const label = `${film.name} (${film.releaseYear})`;
  console.log(rel.body && rel.body.inWatchlist ? `${label} is on your watchlist` : `${label} is NOT on your watchlist`);
}

// Alias → predicate. Each short name maps to displayNames it should accept.
// Designed to exclude near-namesakes (e.g. "max" must not match "Cinemax",
// "paramount" must not match "Paramount+ with Showtime").
const SERVICE_ALIASES = {
  netflix:    (n) => /^netflix( standard with ads)?$/i.test(n),
  hulu:       (n) => /^hulu$/i.test(n),
  max:        (n) => /^(hbo )?max$/i.test(n),
  'hbo max':  (n) => /^(hbo )?max$/i.test(n),
  hbo:        (n) => /^(hbo )?max$/i.test(n),
  prime:      (n) => /^amazon prime video$/i.test(n),
  'amazon prime': (n) => /^amazon prime video$/i.test(n),
  disney:     (n) => /^disney\+$/i.test(n),
  'disney+':  (n) => /^disney\+$/i.test(n),
  peacock:    (n) => /^peacock( premium)?( plus)?$/i.test(n),
  paramount:  (n) => /^paramount\+$/i.test(n),
  'paramount+': (n) => /^paramount\+$/i.test(n),
  'apple tv': (n) => /^apple tv\+$/i.test(n),
  'apple tv+': (n) => /^apple tv\+$/i.test(n),
  kanopy:     (n) => /^kanopy$/i.test(n),
  mubi:       (n) => /^mubi$/i.test(n),
  criterion:  (n) => /^the criterion channel$/i.test(n),
};

function matchService(displayName, wanted) {
  if (!displayName) return null;
  for (const w of wanted) {
    const pred = SERVICE_ALIASES[w];
    if (pred && pred(displayName)) return w;
    if (!pred && displayName.toLowerCase().includes(w)) return w; // fallback for unknown aliases
  }
  return null;
}

async function cmdStreaming(servicesArg) {
  if (!servicesArg) fail('usage: lb.js streaming "netflix" or "netflix,hulu"');
  const wanted = servicesArg.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

  const memberId = await getMemberId();
  const films = [];
  let cursor = null;
  while (true) {
    const params = new URLSearchParams({ perPage: '100' });
    if (cursor) params.set('cursor', cursor);
    const res = await authed('GET', `/member/${memberId}/watchlist?${params}`);
    if (res.status !== 200) fail(`watchlist fetch failed (${res.status}): ${res.raw}`);
    const items = res.body.items || [];
    films.push(...items);
    cursor = res.body.next;
    if (!cursor || items.length === 0) break;
  }

  const seen = new Set(); // dedup (filmId|serviceKey)
  const matches = [];
  let errors = 0;
  const concurrency = 6;
  let i = 0;
  async function worker() {
    while (i < films.length) {
      const film = films[i++];
      const res = await authed('GET', `/film/${film.id}/availability`);
      if (res.status !== 200) { errors++; continue; }
      const offers = res.body.items || [];
      for (const o of offers) {
        if (o.country !== 'USA') continue;
        if (!(o.types || []).includes('stream')) continue;
        const svcKey = matchService(o.displayName, wanted);
        if (!svcKey) continue;
        const dedupKey = `${film.id}|${svcKey}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        matches.push({
          name: film.name,
          year: film.releaseYear,
          service: o.displayName,
          serviceKey: svcKey,
          url: o.url || '',
        });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  if (errors) console.error(`(${errors} films couldn't be checked)`);
  if (!matches.length) {
    console.log(`nothing on your watchlist is currently streaming on ${servicesArg}`);
    return;
  }
  for (const m of matches) {
    console.log(`${m.name}\t${m.year || ''}\t${m.service}\t${m.url}`);
  }
}

async function cmdTrailer(title) {
  if (!title) fail('usage: lb.js trailer "<title>"');
  const film = await findFilm(title);
  if (!film) { console.log(`couldn't find "${title}" on letterboxd`); process.exit(2); }
  const res = await authed('GET', `/film/${film.id}`);
  if (res.status !== 200) fail(`film fetch failed (${res.status}): ${res.raw}`);
  const t = res.body.trailer;
  if (!t || !t.url) {
    console.log(`no trailer on letterboxd for ${film.name} (${film.releaseYear})`);
    return;
  }
  console.log(`${film.name} (${film.releaseYear})`);
  console.log(t.url);
}

async function cmdBrowse(limit = 100) {
  const memberId = await getMemberId();
  const collected = [];
  let cursor = null;
  while (collected.length < limit) {
    const params = new URLSearchParams({ perPage: '100' });
    if (cursor) params.set('cursor', cursor);
    const res = await authed('GET', `/member/${memberId}/watchlist?${params}`);
    if (res.status !== 200) fail(`browse fetch failed (${res.status}): ${res.raw}`);
    const items = res.body.items || [];
    for (const f of items) {
      const genres = (f.genres || []).map((g) => g.name).join(',');
      const year = f.releaseYear || '';
      console.log(`${f.name}\t${year}\t${genres}`);
      collected.push(f);
      if (collected.length >= limit) break;
    }
    cursor = res.body.next;
    if (!cursor || items.length === 0) break;
  }
}

async function cmdSearch(title) {
  if (!title) fail('usage: lb.js search "<title>"');
  const q = new URLSearchParams({ input: title, include: 'FilmSearchItem', perPage: '5' });
  const res = await authed('GET', `/search?${q}`);
  if (res.status !== 200) fail(`search failed (${res.status}): ${res.raw}`);
  const items = (res.body.items || []).filter((i) => i.type === 'FilmSearchItem' && i.film);
  if (!items.length) { console.log(`no results for "${title}"`); return; }
  for (const i of items) console.log(`${i.film.id}\t${i.film.name} (${i.film.releaseYear || '?'})`);
}

// ---------- entrypoint ----------

(async () => {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === 'add') return await cmdAdd(rest.join(' '));
    if (cmd === 'remove') return await cmdRemove(rest.join(' '));
    if (cmd === 'check') return await cmdCheck(rest.join(' '));
    if (cmd === 'trailer') return await cmdTrailer(rest.join(' '));
    if (cmd === 'streaming') return await cmdStreaming(rest.join(' '));
    if (cmd === 'search') return await cmdSearch(rest.join(' '));
    if (cmd === 'list' || cmd === 'browse') {
      const limIdx = rest.indexOf('--limit');
      const defaultLimit = cmd === 'browse' ? 100 : 20;
      const limit = limIdx >= 0 ? parseInt(rest[limIdx + 1], 10) || defaultLimit : defaultLimit;
      return cmd === 'browse' ? await cmdBrowse(limit) : await cmdList(limit);
    }
    fail('usage: lb.js {add|remove|list|browse|check|search|trailer|streaming} ...');
  } catch (e) {
    fail(`error: ${e.message}`);
  }
})();
