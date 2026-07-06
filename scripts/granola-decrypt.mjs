#!/usr/bin/env node
// Decrypt modern Granola encrypted state on macOS.
// Chain: keychain "Granola Safe Storage" pw -> AES-128-CBC decrypt storage.dek -> base64 -> 32-byte DEK
//        -> AES-256-GCM decrypt stored-accounts.json.enc -> tokens JSON
//
// The DEK is CACHED (~/.local/share/granola-dek, 0600) and reused, so normal runs do NOT touch the
// macOS keychain — that avoids the every-5-min keychain authorization popup (which recurs whenever a
// Granola app update resets the keychain ACL). The keychain is read only on cache-miss or if the cached
// DEK ever fails to decrypt (i.e. Granola genuinely rotated storage.dek) — then one popup, re-cache, done.
//
// Prints ONLY structure (no secret values) unless --emit is passed (writes the token to a 0600 file).
// SECURITY: never log token values or raw decrypted plaintext — this script's stdout/stderr is a log file.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.umask(0o077);
const G = path.join(os.homedir(), 'Library/Application Support/Granola');
const SHARE = path.join(os.homedir(), '.local/share');
const DEK_CACHE = path.join(SHARE, 'granola-dek');
const emit = process.argv.includes('--emit');
const out = (...a) => console.log(...a);

function b64urlDecode(seg) {
  const s = seg.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64');
}

function keychainPassword() {
  // NOTE: in a GUI session this may pop a one-time authorization dialog; over SSH it errors out.
  const pw = execFileSync('security', ['find-generic-password', '-w', '-s', 'Granola Safe Storage', '-a', 'Granola Key'], { encoding: 'utf8' });
  return pw.replace(/\n$/, '');
}

function decryptSafeStorage(blob, password) {
  // Chromium OSCrypt: strip "v10"/"v11", AES-128-CBC, key=PBKDF2-HMAC-SHA1(pw,"saltysalt",1003,16), IV=16 spaces
  const prefix = blob.slice(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') throw new Error('unexpected safeStorage prefix: ' + prefix);
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([d.update(blob.slice(3)), d.final()]);
}

function gcmDecrypt(dek, data) {
  // Granola layout: [12-byte nonce][ciphertext][16-byte GCM tag]; fall back to 16-byte IV.
  if (data.length < 28) throw new Error(`enc file too short (${data.length}B) — truncated?`);
  const reasons = [];
  for (const ivLen of [12, 16]) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', dek, data.slice(0, ivLen));
      d.setAuthTag(data.slice(data.length - 16));
      return Buffer.concat([d.update(data.slice(ivLen, data.length - 16)), d.final()]);
    } catch (e) { reasons.push(`iv${ivLen}: ${e.code || e.message}`); }
  }
  throw new Error('GCM decrypt failed — ' + reasons.join(' | '));
}

function dekFromKeychain() {
  const pw = keychainPassword();
  out('keychain read OK (pw len', pw.length + ')');
  let dek = decryptSafeStorage(fs.readFileSync(path.join(G, 'storage.dek')), pw);
  if (dek.length !== 32) {
    const b64 = Buffer.from(dek.toString('utf8').trim(), 'base64');
    if (b64.length !== 32) throw new Error(`DEK is ${dek.length}B raw / ${b64.length}B base64; expected 32`);
    dek = b64;
  }
  return dek;
}

function loadCachedDek() {
  try {
    const dek = Buffer.from(fs.readFileSync(DEK_CACHE, 'utf8').trim(), 'base64');
    return dek.length === 32 ? dek : null;
  } catch { return null; }
}

function cacheDek(dek) {
  fs.mkdirSync(SHARE, { recursive: true });
  fs.writeFileSync(DEK_CACHE, dek.toString('base64'), { mode: 0o600 });
  fs.chmodSync(DEK_CACHE, 0o600);
}

try {
  const enc = fs.readFileSync(path.join(G, 'stored-accounts.json.enc'));
  out('stored-accounts.json.enc size:', enc.length);

  // Prefer the cached DEK so we never touch the keychain on the normal path (no popup).
  let pt = null;
  const cached = loadCachedDek();
  if (cached) {
    try { pt = gcmDecrypt(cached, enc); out('decrypted with CACHED DEK (no keychain access)'); }
    catch { out('cached DEK no longer works (Granola may have rotated it) — re-reading keychain'); }
  }
  if (!pt) {
    const dek = dekFromKeychain();   // may pop a one-time keychain dialog in a GUI session
    pt = gcmDecrypt(dek, enc);       // throws (safely) if it still fails
    cacheDek(dek);
    out('DEK cached for future runs — keychain will not be read again unless this DEK stops working');
  }

  let accs;
  try {
    const j = JSON.parse(pt.toString('utf8'));
    accs = typeof j.accounts === 'string' ? JSON.parse(j.accounts) : j.accounts;
  } catch {
    throw new Error('decrypted plaintext is not the expected JSON (Granola may have changed its schema)');
  }
  out('accounts:', Array.isArray(accs) ? accs.length : '(unexpected shape)');

  for (const a of (accs || [])) {
    let t = a.tokens;
    try { t = typeof t === 'string' ? JSON.parse(t) : t; } catch { out('  account: tokens unparseable, skipping'); continue; }
    const at = t.access_token || '';
    let exp = null;
    try { exp = JSON.parse(b64urlDecode(at.split('.')[1]).toString()).exp; } catch {}
    const hrs = exp ? Math.round((exp - Date.now() / 1000) / 360) / 10 : null;
    out(`  account: AT len ${at.length}, exp ${exp} (${hrs}h from now), has RT: ${!!t.refresh_token}`);
    if (emit) {
      if (!at) { out('  SKIP emit: empty access_token (kept previous token file)'); continue; }
      fs.mkdirSync(SHARE, { recursive: true });
      const outPath = path.join(SHARE, 'granola-token.json');
      // refresh_token carried but MUST NOT be exchanged here — WorkOS rotates RTs and breaks Granola's own refresh.
      fs.writeFileSync(outPath, JSON.stringify({ access_token: at, refresh_token: t.refresh_token, expires_at: exp }), { mode: 0o600 });
      fs.chmodSync(outPath, 0o600);
      out('  EMITTED', outPath);
    }
  }
} catch (e) {
  out('ERROR:', e.message);
  process.exit(1);
}
