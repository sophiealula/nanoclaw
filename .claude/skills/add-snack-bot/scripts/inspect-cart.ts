#!/usr/bin/env tsx
import { chromium } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const PROFILE_DIR = join(homedir(), ".instacart-mcp", "profile");

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // Go to Buy It Again first
  await page.goto("https://www.instacart.com/store/costco/buy_it_again", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Open cart sidebar
  await page.locator('[data-testid="floating-cart-button"]').first().click({ timeout: 5000 });
  await page.waitForTimeout(2000);

  // Click "Go to checkout" inside the sidebar
  await page.getByText(/Go to checkout/i).first().click({ timeout: 5000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "scratch/checkout-aisle.png", fullPage: false });

  const info = await page.evaluate(() => {
    const url = location.href;
    const buttons = Array.from(document.querySelectorAll("button, a"))
      .filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .slice(0, 60)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().slice(0, 60),
        aria: el.getAttribute("aria-label")?.slice(0, 80) ?? null,
        href: (el as HTMLAnchorElement).href ?? null,
      }));
    return { url, buttons };
  });
  console.log("URL:", info.url);
  console.log("\n=== Visible buttons/anchors ===");
  for (const b of info.buttons) {
    if (b.text || b.aria) {
      console.log(`  ${b.tag} text="${b.text}" aria="${b.aria}" href="${b.href?.slice(0, 60) ?? ""}"`);
    }
  }
  writeFileSync(
    join(process.cwd(), "scratch", "cart-buttons.json"),
    JSON.stringify(info, null, 2),
  );
  await context.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
