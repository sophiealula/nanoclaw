#!/usr/bin/env tsx
/**
 * One-time Instacart login capture.
 *
 * Launches a headed Chromium with a persistent profile dir. You log in
 * manually (Instacart uses email magic links / SMS codes by default).
 * When you're done, close the browser window — the persistent profile is
 * what the scrape script will reuse.
 *
 * Why persistent context (not storageState): Instacart fingerprints beyond
 * cookies. Sharing a profile dir between auth and headless playback keeps
 * the fingerprint stable across runs.
 *
 * Run: npx tsx scripts/instacart-auth.ts
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".instacart-mcp", "profile");

async function main() {
  mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.instacart.com/");
  console.log("\n→ Browser opened to instacart.com.");
  console.log("→ Sign in (top-right). Use email/SMS code if prompted.");
  console.log("→ When you're logged in, close the browser window.\n");

  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
  });

  console.log(`✓ Profile saved to ${PROFILE_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
