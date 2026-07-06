#!/usr/bin/env tsx
/**
 * Instacart Costco "Buy It Again" scraper — POC.
 *
 * Reuses the persistent profile from `scripts/instacart-auth.ts`. Navigates
 * to the Costco storefront on Instacart, opens Buy It Again, scrapes items.
 *
 * Default: headed (research suggests pure --headless triggers more
 * fingerprinting). Pass --headless to override.
 *
 * Two questions this POC answers:
 *   1. Does Playwright with a persistent profile reach Instacart's Costco
 *      Buy It Again page without bot challenges?
 *   2. Is the DOM stable enough to parse cleanly?
 *
 * If we get blocked or scrape 0 items, dumps screenshots + HTML under ./scratch/.
 *
 * Run: npx tsx scripts/instacart-snack-cart.ts            (headed by default)
 *      npx tsx scripts/instacart-snack-cart.ts --headless
 */

import { chromium, type Page, type BrowserContext } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".instacart-mcp", "profile");
const SCRATCH_DIR = join(process.cwd(), "scratch");

const COSTCO_STOREFRONT_URLS = [
  "https://www.instacart.com/store/costco/storefront",
  "https://www.instacart.com/store/costco-business-center/storefront",
];

const BUY_AGAIN_PATH_HINTS = [
  "buy_it_again",
  "buy-it-again",
  "your-items",
  "previously-purchased",
];

const BUY_AGAIN_URL_CANDIDATES = [
  "https://www.instacart.com/store/costco/buy_it_again",
  "https://www.instacart.com/store/costco/buy-it-again",
  "https://www.instacart.com/store/costco/your-items",
  "https://www.instacart.com/store/your-items",
];

interface ScrapedItem {
  name: string;
  qty: number | null;
  price: string | null;
  unavailable: boolean;
  productId: string | null;
  href: string | null;
  raw: string;
}

async function dumpDebug(page: Page, label: string) {
  if (!existsSync(SCRATCH_DIR)) mkdirSync(SCRATCH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const png = join(SCRATCH_DIR, `${label}-${stamp}.png`);
  const html = join(SCRATCH_DIR, `${label}-${stamp}.html`);
  await page.screenshot({ path: png, fullPage: true }).catch(() => {});
  writeFileSync(html, await page.content());
  console.error(`  → screenshot: ${png}`);
  console.error(`  → html dump:  ${html}`);
}

async function findBuyAgainLink(page: Page): Promise<string | null> {
  const hrefs = await page.$$eval("a[href]", (links) =>
    links.map((a) => (a as HTMLAnchorElement).href),
  );
  const match = hrefs.find((h) =>
    BUY_AGAIN_PATH_HINTS.some((hint) => h.includes(hint)),
  );
  return match ?? null;
}

async function scrapeItems(page: Page): Promise<ScrapedItem[]> {
  return await page.$$eval(
    'a[data-item-card-button="true"]',
    (anchors) => {
      const items: ScrapedItem[] = [];
      const seen = new Set<string>();

      for (const anchor of anchors) {
        const a = anchor as HTMLAnchorElement;
        const href = a.getAttribute("href") ?? null;

        // Walk up to the surrounding card container so innerText includes the
        // product name + price + quantity + stock indicator.
        const card =
          (a.closest('[role="group"]') as HTMLElement | null) ??
          (a.parentElement as HTMLElement | null) ??
          (a as HTMLElement);

        const img = a.querySelector("img[data-testid='item-card-image']") as
          | HTMLImageElement
          | null;
        const name = img?.getAttribute("alt")?.trim() ?? "";

        const text = (card.innerText ?? "").trim();
        const dedupeKey = href ?? name ?? text.slice(0, 80);
        if (!dedupeKey || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        // Price: prefer "$X.XX" form, fall back to "Current price: $X.XX".
        const priceMatch =
          text.match(/\$\d+(?:\.\d{2})?\b/) ??
          text.match(/current price:\s*(\$\d+(?:\.\d{2})?)/i);
        const price = priceMatch ? priceMatch[0].replace(/.*\$/, "$") : null;

        // Last-purchased quantity hint: e.g. "Bought X times" / "Last bought X".
        const qtyMatch =
          text.match(/(?:qty|quantity)[^\d]{0,4}(\d+)/i) ??
          text.match(/bought\s+(\d+)\s+times?/i);
        const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : null;

        const unavailable = /unavailable|out of stock|sold out/i.test(text);

        // Product id from /products/<id>-<slug>
        const idMatch = href?.match(/\/products\/(\d+)-/);
        const productId = idMatch ? idMatch[1] : null;

        items.push({
          name,
          qty,
          price,
          unavailable,
          productId,
          href,
          raw: text.slice(0, 160),
        });
      }
      return items;
    },
  ) as ScrapedItem[];
}

async function main() {
  if (!existsSync(PROFILE_DIR)) {
    console.error(
      `No saved profile at ${PROFILE_DIR}.\n` +
        `Run: npx tsx scripts/instacart-auth.ts`,
    );
    process.exit(2);
  }

  const headless = process.argv.includes("--headless");
  const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] ?? (await context.newPage());

  console.error("→ Opening Instacart home...");
  await page.goto("https://www.instacart.com/", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(1500);

  if (/login|signin/i.test(page.url())) {
    console.error("→ Looks like the session is no longer valid (redirected to login).");
    console.error("  Re-run scripts/instacart-auth.ts to refresh.");
    await dumpDebug(page, "logged-out");
    await context.close();
    process.exit(3);
  }

  console.error("→ Navigating to Costco storefront...");
  let storefrontReached = false;
  for (const candidate of COSTCO_STOREFRONT_URLS) {
    try {
      await page.goto(candidate, { waitUntil: "domcontentloaded", timeout: 20000 });
      const finalUrl = page.url();
      if (/costco/i.test(finalUrl) && !/login/i.test(finalUrl)) {
        storefrontReached = true;
        console.error(`  → ${finalUrl}`);
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!storefrontReached) {
    console.error("→ Could not reach a Costco storefront URL.");
    await dumpDebug(page, "no-storefront");
    await context.close();
    process.exit(4);
  }

  console.error("→ Looking for Buy It Again...");
  // Try direct URL navigation first; cheaper than DOM hunting.
  let buyAgainReached = false;
  for (const candidate of BUY_AGAIN_URL_CANDIDATES) {
    try {
      await page.goto(candidate, { waitUntil: "domcontentloaded", timeout: 20000 });
      const finalUrl = page.url();
      // A successful Buy Again page should keep the path containing one of our hints
      // and not redirect to login or a 404 page.
      if (
        BUY_AGAIN_PATH_HINTS.some((h) => finalUrl.includes(h)) &&
        !/login|signin|404|not.?found/i.test(finalUrl)
      ) {
        console.error(`  → ${finalUrl}`);
        buyAgainReached = true;
        break;
      }
    } catch {
      /* try next */
    }
  }

  if (!buyAgainReached) {
    // Fall back to DOM link discovery from storefront.
    await page.goto("https://www.instacart.com/store/costco/storefront", {
      waitUntil: "domcontentloaded",
    });
    const buyAgainHref = await findBuyAgainLink(page);
    if (buyAgainHref) {
      console.error(`  → fallback link: ${buyAgainHref}`);
      await page.goto(buyAgainHref, { waitUntil: "domcontentloaded" });
      buyAgainReached = true;
    }
  }

  if (!buyAgainReached) {
    console.error("  → Could not reach Buy It Again. Dumping for debug.");
    await dumpDebug(page, "no-buy-again");
    await context.close();
    process.exit(6);
  }

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  console.error("→ Scraping items...");
  const items = await scrapeItems(page);

  if (items.length === 0) {
    console.error("→ Got 0 items. Dumping debug artifacts...");
    await dumpDebug(page, "zero-items");
    await context.close();
    process.exit(5);
  }

  console.error(`→ Found ${items.length} item(s). Printing JSON...\n`);
  console.log(JSON.stringify(items, null, 2));

  await context.close();
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
