#!/usr/bin/env tsx
/**
 * Identify which Instacart account is logged into the bot's persistent profile.
 */
import { chromium } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".instacart-mcp", "profile");

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto("https://www.instacart.com/store/account", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const body = document.body.innerText;
    const emails = Array.from(body.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)).map((m) => m[0]);
    const headings = Array.from(document.querySelectorAll("h1, h2, h3")).map(
      (h) => h.textContent?.trim().slice(0, 80),
    );
    return { emails, headings: headings.slice(0, 10), url: location.href };
  });

  console.log("URL:", info.url);
  console.log("Emails found on page:", JSON.stringify(info.emails.slice(0, 5)));
  console.log("Headings:", JSON.stringify(info.headings));

  await context.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
