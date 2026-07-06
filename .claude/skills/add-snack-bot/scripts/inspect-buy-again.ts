#!/usr/bin/env tsx
/**
 * Diagnostic: dump the structure of one Buy It Again item card so we can
 * find the real Add button.
 */
import { chromium } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const PROFILE_DIR = join(homedir(), ".instacart-mcp", "profile");
const OUT_DIR = join(process.cwd(), "scratch");

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto("https://www.instacart.com/store/costco/buy_it_again", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Pull the outerHTML of the first role="group" container with an item card anchor.
  const groupHtml = await page.evaluate(() => {
    const a = document.querySelector('a[data-item-card-button="true"]');
    if (!a) return "(no anchor found)";
    const group = a.closest('[role="group"]') ?? a.parentElement;
    return group ? (group as HTMLElement).outerHTML : "(no group)";
  });

  // List all <button> elements on the page with their text + aria-label.
  const buttons = await page.$$eval("button", (btns) =>
    btns.slice(0, 50).map((b) => ({
      text: (b as HTMLButtonElement).innerText.slice(0, 40),
      aria: (b as HTMLButtonElement).getAttribute("aria-label")?.slice(0, 60) ?? null,
      testid: (b as HTMLButtonElement).getAttribute("data-testid") ?? null,
    })),
  );

  writeFileSync(join(OUT_DIR, "first-group.html"), groupHtml);
  writeFileSync(join(OUT_DIR, "all-buttons.json"), JSON.stringify(buttons, null, 2));

  console.log("Wrote scratch/first-group.html and scratch/all-buttons.json");
  console.log("\n=== Sample of buttons on page ===");
  for (const b of buttons.slice(0, 30)) {
    console.log(`  text="${b.text}" aria="${b.aria}" testid="${b.testid}"`);
  }

  await context.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
