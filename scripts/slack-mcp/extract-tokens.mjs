#!/usr/bin/env node
// Drives a headed Chromium so Sophie can log into 2389 Slack, then extracts
// the session tokens korotovsky/slack-mcp-server needs:
//   xoxd = the `d` cookie   (domain .slack.com)
//   xoxc = the per-workspace token from localStorage.localConfig_v2
// Writes them to ./tokens.env (chmod 600, gitignored). Host-only; never enters a container.

import { chromium } from 'playwright';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(HERE, '.pw-profile');
const OUT = join(HERE, 'tokens.env');
mkdirSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://app.slack.com/client', { waitUntil: 'domcontentloaded' });

console.log('\n>>> A Chromium window opened. Log into the 2389 Slack workspace.');
console.log('>>> Once you can see channels, leave it; I detect login automatically.\n');

// Poll localStorage for any xoxc- token. Slack moves the exact key around, so
// scan every localStorage value, not just localConfig_v2.
const DEADLINE = Date.now() + 8 * 60 * 1000; // 8 min
let teams = null;
let lastDiag = 0;
while (Date.now() < DEADLINE) {
  try {
    teams = await page.evaluate(() => {
      const found = new Map(); // token -> {id,name,domain,token}
      // 1) Structured: localConfig_v2.teams[].token
      try {
        const cfg = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
        for (const [id, t] of Object.entries(cfg.teams || {})) {
          if (t && typeof t.token === 'string' && t.token.startsWith('xoxc-')) {
            found.set(t.token, { id, name: t.name || t.domain || id, domain: t.domain || '', token: t.token });
          }
        }
      } catch {}
      // 2) Brute force: any xoxc- token anywhere in localStorage values
      const re = /xoxc-[A-Za-z0-9-]+/g;
      for (let i = 0; i < localStorage.length; i++) {
        const v = localStorage.getItem(localStorage.key(i)) || '';
        for (const m of v.match(re) || []) {
          if (!found.has(m)) found.set(m, { id: '?', name: '(unknown)', domain: '', token: m });
        }
      }
      return found.size ? [...found.values()] : null;
    });
  } catch { /* page mid-navigation */ }
  if (teams) break;
  // every ~20s emit a one-line diagnostic so we know if login is happening
  if (Date.now() - lastDiag > 20000) {
    lastDiag = Date.now();
    try {
      const diag = await page.evaluate(() => ({
        url: location.href,
        lsKeys: localStorage.length,
        hasLocalConfig: !!localStorage.getItem('localConfig_v2'),
      }));
      console.log(`   …waiting (url=${diag.url.slice(0, 60)} lsKeys=${diag.lsKeys} localConfig=${diag.hasLocalConfig})`);
    } catch {}
  }
  await page.waitForTimeout(2000);
}

if (!teams) {
  console.error('\n!!! Timed out waiting for login / no xoxc token found. Re-run when ready.');
  await ctx.close();
  process.exit(1);
}

// xoxd = the `d` cookie
const cookies = await ctx.cookies();
const dCookie = cookies.find((c) => c.name === 'd' && c.domain.includes('slack.com'));
if (!dCookie) {
  console.error('\n!!! Logged in but no `d` cookie found. Re-run.');
  await ctx.close();
  process.exit(1);
}

console.log('\nWorkspaces found in this session:');
teams.forEach((t, i) => console.log(`  [${i}] ${t.name}  (${t.domain}.slack.com)  token=${t.token.slice(0, 18)}…`));

// Pick the 2389 workspace if obvious, else the first.
let pick = teams.findIndex((t) => /2389/i.test(t.name) || /2389/i.test(t.domain));
if (pick < 0) pick = 0;
const chosen = teams[pick];

const body =
  `# Extracted ${new Date().toISOString()} — workspace: ${chosen.name} (${chosen.domain}.slack.com)\n` +
  `SLACK_MCP_XOXC_TOKEN=${chosen.token}\n` +
  `SLACK_MCP_XOXD_TOKEN=${dCookie.value}\n`;
writeFileSync(OUT, body, { mode: 0o600 });
chmodSync(OUT, 0o600);

console.log(`\n✓ Picked [${pick}] ${chosen.name}. Wrote tokens to ${OUT} (chmod 600).`);
console.log(`  xoxc=${chosen.token.slice(0, 18)}…  xoxd=${dCookie.value.slice(0, 12)}… (len ${dCookie.value.length})`);
await ctx.close();
process.exit(0);
