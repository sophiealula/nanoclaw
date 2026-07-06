#!/usr/bin/env tsx
/**
 * Slack-driven Instacart Costco snack ordering bot — AUTONOMOUS MODE.
 *
 * Sophie says "order costco snacks" or "add X, Y, Z" in #snax. The bot
 * scrapes / matches, adds items to her real Instacart Costco cart, walks
 * to checkout, runs verification gates, and places the order using the
 * card on file. Reports CONFIRMED / LIKELY / UNCONFIRMED — never claims
 * success without page-side evidence.
 *
 * Safety gates:
 *   - Owner-only writes (colleagues can read but not trigger)
 *   - $400 hard spend cap (aborts before Place Order)
 *   - 5-min idempotency window (rejects repeat triggers)
 *   - Ambiguous matches → skip the item, continue with the rest
 *   - Semantic LLM matches require confidence >= 0.75
 *
 * Env (~/.instacart-mcp/.env + project .env):
 *   SLACK_BOT_TOKEN          xoxb-...
 *   SLACK_DM_CHANNEL_ID      C... (channel ID despite the name)
 *   SLACK_OWNER_USER_ID      U...
 *   SLACK_BOT_USER_ID        U...
 *   ANTHROPIC_API_KEY        (project .env, for semantic match)
 *   DRY_RUN                  set to "1" to skip the actual Place Order click
 *
 * Run: npx tsx scripts/snack-bot.ts
 *      DRY_RUN=1 npx tsx scripts/snack-bot.ts
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- env ----------

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const ENV: Record<string, string> = {
  ...loadEnv(join(process.cwd(), ".env")),
  ...loadEnv(join(homedir(), ".instacart-mcp", ".env")),
};
const SLACK_BOT_TOKEN = ENV.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = ENV.SLACK_DM_CHANNEL_ID; // (env name kept for backward compat)
const SLACK_OWNER_USER_ID = ENV.SLACK_OWNER_USER_ID;
const SLACK_BOT_USER_ID = ENV.SLACK_BOT_USER_ID;
const ANTHROPIC_API_KEY = ENV.ANTHROPIC_API_KEY ?? "";
const DRY_RUN = process.env.DRY_RUN === "1" || ENV.DRY_RUN === "1";
const PROFILE_DIR = join(homedir(), ".instacart-mcp", "profile");
const SCRATCH_DIR = join(process.cwd(), "scratch");

// Safety constants
const SPEND_CAP_USD = 400;
const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const SEMANTIC_CONFIDENCE_THRESHOLD = 0.75;
const MIN_SUCCESS_RATE = 0.7; // at least 70% of items must add successfully
const SUBSTITUTION_SETTINGS_URL =
  "https://www.instacart.com/store/account/preferences/replacements";

for (const [k, v] of Object.entries({
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID,
  SLACK_OWNER_USER_ID,
  SLACK_BOT_USER_ID,
})) {
  if (!v) {
    console.error(`Missing required env: ${k} (in ~/.instacart-mcp/.env)`);
    process.exit(2);
  }
}

// ---------- slack ----------

async function slackPost<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
  if (!json.ok) throw new Error(`slack ${method} failed: ${json.error}`);
  return json as T;
}

async function slackGet<T = unknown>(method: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  const json = (await res.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
  if (!json.ok) throw new Error(`slack ${method} failed: ${json.error}`);
  return json as T;
}

async function postMessage(text: string): Promise<void> {
  await slackPost("chat.postMessage", { channel: SLACK_CHANNEL_ID, text, mrkdwn: true });
  console.log(`→ slack: ${text.split("\n")[0].slice(0, 80)}...`);
}

async function uploadScreenshot(pngPath: string, comment: string): Promise<void> {
  const buf = readFileSync(pngPath);
  const step1 = (await slackGet("files.getUploadURLExternal", {
    filename: pngPath.split("/").pop()!,
    length: buf.byteLength.toString(),
  })) as { upload_url: string; file_id: string };
  await fetch(step1.upload_url, { method: "POST", body: new Uint8Array(buf) });
  await slackPost("files.completeUploadExternal", {
    files: [{ id: step1.file_id, title: "Order receipt" }],
    channel_id: SLACK_CHANNEL_ID,
    initial_comment: comment,
  });
}

interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  subtype?: string;
}

async function fetchNewMessages(oldestTs: string): Promise<SlackMessage[]> {
  const out = (await slackGet("conversations.history", {
    channel: SLACK_CHANNEL_ID,
    oldest: oldestTs,
    inclusive: "false",
    limit: "20",
  })) as { messages: SlackMessage[] };
  return [...out.messages].reverse();
}

// ---------- scraping ----------

export interface ScrapedItem {
  name: string;
  qty: number;
  price: string | null;
  unavailable: boolean;
  productId: string | null;
  href: string | null;
}

async function gotoBuyAgain(page: Page): Promise<boolean> {
  const candidates = [
    "https://www.instacart.com/store/costco/buy_it_again",
    "https://www.instacart.com/store/costco/buy-it-again",
    "https://www.instacart.com/store/costco/your-items",
  ];
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const finalUrl = page.url();
      if (/buy_it_again|buy-it-again|your-items/.test(finalUrl) && !/login|signin/.test(finalUrl)) {
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

async function scrapeItems(page: Page): Promise<ScrapedItem[]> {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return (await page.$$eval('a[data-item-card-button="true"]', (anchors) => {
    const out: ScrapedItem[] = [];
    const seen = new Set<string>();
    for (const a of anchors) {
      const href = (a as HTMLAnchorElement).getAttribute("href") ?? null;
      const img = a.querySelector("img[data-testid='item-card-image']") as HTMLImageElement | null;
      const name = img?.getAttribute("alt")?.trim() ?? "";
      const card =
        (a.closest('[role="group"]') as HTMLElement | null) ??
        ((a.parentElement as HTMLElement | null) ?? (a as HTMLElement));
      const text = (card.innerText ?? "").trim();
      const key = href ?? name ?? text.slice(0, 80);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const priceMatch = text.match(/\$\d+(?:\.\d{2})?\b/);
      const price = priceMatch ? priceMatch[0] : null;
      const unavailable = /unavailable|out of stock|sold out/i.test(text);
      const idMatch = href?.match(/\/products\/(\d+)-/);
      out.push({
        name,
        qty: 1,
        price,
        unavailable,
        productId: idMatch ? idMatch[1] : null,
        href,
      });
    }
    return out;
  })) as ScrapedItem[];
}

// ---------- natural-language parsing + matching ----------

const STOPWORDS = new Set(["the", "and", "with", "for", "from", "some", "any", "this", "that"]);

export interface AddRequest {
  phrase: string;
  qty: number;
}

export function cleanPhrase(s: string): string {
  return s
    .replace(/^(?:to|into|in|for)\s+(?:the\s+)?cart\s*[-:,]?\s*/i, "")
    // Longest alternatives FIRST — JS regex alternation picks the first option
    // that matches at a position, not the longest. With "a" listed first,
    // "a bag of pretzels" would strip only "a" and leave "bag of pretzels".
    .replace(
      /^(?:a\s+box\s+of|a\s+bag\s+of|a\s+pack\s+of|cartons?\s+of|bottles?\s+of|boxes?\s+of|bags?\s+of|cans?\s+of|packs?\s+of|jugs?\s+of|some|the|an|a)\s+/i,
      "",
    )
    .replace(/\s+please\.?$/i, "")
    .trim();
}

export function parseAddRequest(text: string): AddRequest[] {
  const inner = text.replace(
    /^\s*(?:also\s+)?(?:add(?:\s+in)?|order(?:\s+me)?|get\s+me|throw\s+in|grab\s+(?:me\s+)?|i\s+want)\s+/i,
    "",
  );
  const chunks = inner
    .split(/\s+and\s+|\s*,\s*/i)
    .map((s) => s.replace(/^and\s+/i, "").trim())
    .filter(Boolean);
  const out: AddRequest[] = [];
  for (const chunk of chunks) {
    let qty = 1;
    let phrase = chunk;
    const leadingNum = chunk.match(/^(\d+)\s+(.+)$/);
    if (leadingNum) {
      qty = parseInt(leadingNum[1], 10);
      phrase = leadingNum[2];
    } else {
      // "(2)", "(2 of them)", "(2 each)", "(2 total)", "x2", "×2"
      const parenNum = chunk.match(
        /\((\d+)(?:\s+(?:of\s+them|of\s+these|each|total|pls|please))?\)|[x×]\s*(\d+)\s*$/i,
      );
      if (parenNum) {
        qty = parseInt(parenNum[1] ?? parenNum[2], 10);
        phrase = chunk.replace(parenNum[0], "").trim();
      }
    }
    out.push({ phrase: cleanPhrase(phrase), qty });
  }
  return out;
}

export function matchItem(phrase: string, items: ScrapedItem[]): { item: ScrapedItem; score: number }[] {
  const tokens = phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (tokens.length === 0) return [];
  const scored: { item: ScrapedItem; score: number }[] = [];
  for (const item of items) {
    const slugRaw = (item.href ?? "").toLowerCase();
    const slugSpaces = slugRaw.replace(/[-_/]/g, " ");
    const slugCondensed = slugRaw.replace(/[-_/]/g, "");
    // Search both space-normalized and hyphen-stripped forms so "cheezits"
    // can match a "cheez-it" slug (→ "cheezit" after stripping → plural match).
    const searchable = `${item.name.toLowerCase()} ${slugSpaces} ${slugCondensed}`;
    let score = 0;
    for (const t of tokens) {
      if (searchable.includes(t)) score += 1;
      else if (t.length >= 4 && searchable.includes(t.slice(0, -1))) score += 0.5;
    }
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function isAmbiguous(scored: { item: ScrapedItem; score: number }[]): boolean {
  if (scored.length < 2) return false;
  return scored[0].score - scored[1].score < 0.5;
}

/**
 * When the token matcher returns two+ tied candidates, ask Claude to pick the
 * most contextually appropriate one. Returns null if the LLM is unsure.
 */
async function disambiguateMatches(
  phrase: string,
  candidates: ScrapedItem[],
): Promise<{ item: ScrapedItem; confidence: number } | null> {
  if (!ANTHROPIC_API_KEY || candidates.length === 0) return null;
  const list = candidates.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
  const prompt =
    `A user is shopping for: "${phrase}"\n\n` +
    `Which of these Costco products is the closest match?\n${list}\n\n` +
    `Use context clues (e.g. "bottles" implies a bottled drink, "bags" implies bagged tea, "snack" implies a single-serve format).\n` +
    `Return ONLY JSON: {"index": <1-based index, or null if genuinely unclear>, "confidence": <0.0 to 1.0>}.\n` +
    `Confidence under 0.6 counts as unclear.`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const json = (await res.json()) as { content?: { text?: string }[] };
    const text = json.content?.[0]?.text ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { index: number | null; confidence: number };
    if (parsed.index === null || parsed.confidence < 0.6) return null;
    const item = candidates[parsed.index - 1];
    if (!item) return null;
    return { item, confidence: parsed.confidence };
  } catch (err) {
    console.error("disambiguateMatches error:", (err as Error).message);
    return null;
  }
}

type Intent =
  | { kind: "approve" }
  | { kind: "cancel" }
  | { kind: "status" }
  | { kind: "trigger_bulk" }
  | { kind: "trigger_add"; phrase: string }
  | { kind: "unknown"; reason?: string };

/**
 * When the regex router doesn't match, ask Claude to classify the user's intent
 * given the current bot state. Returns "unknown" if Claude is unsure or if no
 * API key is configured.
 */
async function classifyIntent(text: string, currentState: State["kind"]): Promise<Intent> {
  if (!ANTHROPIC_API_KEY) return { kind: "unknown", reason: "no LLM key" };
  const stateDesc =
    currentState === "AWAITING_OKAY"
      ? "The bot has built a cart at checkout and is waiting for the user to say it's okay to place the order. The user can also cancel."
      : currentState === "RUNNING"
        ? "The bot is in the middle of building a cart."
        : "The bot is idle, waiting for a trigger (either a bulk reorder or specific items to add).";
  const prompt =
    `You are interpreting a single user message to a Slack bot that orders snacks from Instacart Costco.\n\n` +
    `Bot state: ${stateDesc}\n\n` +
    `User said: "${text}"\n\n` +
    `Classify the intent. Return ONLY a JSON object with one of these shapes:\n` +
    `  {"kind":"approve"}  — user confirms the cart should be placed (e.g. "yes", "send it", "fire away", "go for it", "let's do it")\n` +
    `  {"kind":"cancel"}   — user wants to abort (e.g. "nope", "wait", "scrap it", "don't")\n` +
    `  {"kind":"status"}   — user wants to know what's in cart / what's happening\n` +
    `  {"kind":"trigger_bulk"}  — user wants a full Buy-Again snack reorder\n` +
    `  {"kind":"trigger_add","phrase":"<items>"}  — user wants to add specific items; phrase is the items list verbatim\n` +
    `  {"kind":"unknown"}  — message is unrelated / unclear / small talk\n\n` +
    `Be permissive on approve/cancel when the user clearly means yes or no in context. Default to "unknown" if genuinely unclear.`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const json = (await res.json()) as { content?: { text?: string }[] };
    const textOut = json.content?.[0]?.text ?? "";
    const jsonMatch = textOut.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { kind: "unknown" };
    const parsed = JSON.parse(jsonMatch[0]) as Intent;
    return parsed;
  } catch (err) {
    console.error("classifyIntent error:", (err as Error).message);
    return { kind: "unknown" };
  }
}

async function semanticMatch(
  phrase: string,
  items: ScrapedItem[],
): Promise<{ item: ScrapedItem; confidence: number } | null> {
  if (!ANTHROPIC_API_KEY || items.length === 0) return null;
  const itemList = items.map((i, idx) => `${idx + 1}. ${i.name}`).join("\n");
  const prompt =
    `From the list of grocery items below, pick the single closest semantic match to: "${phrase}".\n\n` +
    `Items:\n${itemList}\n\n` +
    `Return ONLY a JSON object: {"index": <1-based index, or null>, "confidence": <0.0 to 1.0>}.\n` +
    `Be conservative — return null if nothing is meaningfully related.`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const json = (await res.json()) as { content?: { text?: string }[] };
    const text = json.content?.[0]?.text ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { index: number | null; confidence: number };
    if (parsed.index === null || parsed.confidence < SEMANTIC_CONFIDENCE_THRESHOLD) return null;
    const item = items[parsed.index - 1];
    if (!item) return null;
    return { item, confidence: parsed.confidence };
  } catch (err) {
    console.error("semanticMatch error:", (err as Error).message);
    return null;
  }
}

// ---------- request → resolved items ----------

interface Resolution {
  resolved: { phrase: string; qty: number; item: ScrapedItem; isSemantic: boolean }[];
  unmatched: string[]; // phrases with no match
  ambiguous: { phrase: string; candidates: ScrapedItem[] }[]; // skipped due to ambiguity
}

async function resolveRequest(requestText: string, pool: ScrapedItem[]): Promise<Resolution> {
  const requests = parseAddRequest(requestText);
  const resolution: Resolution = { resolved: [], unmatched: [], ambiguous: [] };
  for (const req of requests) {
    const scored = matchItem(req.phrase, pool);
    if (scored.length === 0) {
      const guess = await semanticMatch(req.phrase, pool);
      if (guess) {
        resolution.resolved.push({
          phrase: req.phrase,
          qty: req.qty,
          item: guess.item,
          isSemantic: true,
        });
      } else {
        resolution.unmatched.push(req.phrase);
      }
      continue;
    }
    if (isAmbiguous(scored)) {
      // Try LLM disambiguation before giving up — "green tea bottles" should
      // pick the bottled product over the bagged one.
      const cands = scored.slice(0, 3).map((s) => s.item);
      const llmPick = await disambiguateMatches(req.phrase, cands);
      if (llmPick) {
        resolution.resolved.push({
          phrase: req.phrase,
          qty: req.qty,
          item: llmPick.item,
          isSemantic: true,
        });
        continue;
      }
      resolution.ambiguous.push({ phrase: req.phrase, candidates: cands });
      continue;
    }
    resolution.resolved.push({
      phrase: req.phrase,
      qty: req.qty,
      item: scored[0].item,
      isSemantic: false,
    });
  }
  // Dedupe — same item across phrases gets qty summed.
  const merged = new Map<string, { phrase: string; qty: number; item: ScrapedItem; isSemantic: boolean }>();
  for (const r of resolution.resolved) {
    const key = r.item.href ?? r.item.name;
    const existing = merged.get(key);
    if (existing) existing.qty += r.qty;
    else merged.set(key, { ...r });
  }
  resolution.resolved = Array.from(merged.values());
  return resolution;
}

// ---------- cart-add with verification ----------

interface CartAddResult {
  added: ScrapedItem[];
  failed: ScrapedItem[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type AddOutcome =
  | { kind: "added" }
  | { kind: "already-in-cart" }
  | { kind: "not-found"; reason: string };

async function addItemWithVerification(
  page: Page,
  item: ScrapedItem,
  mode: "bulk" | "adhoc" = "bulk",
): Promise<AddOutcome> {
  if (!item.name) return { kind: "not-found", reason: "no item name" };
  const nameKey = item.name.slice(0, 20).toLowerCase();

  // First pass: try to click Add button for this item.
  const firstResult = await page.evaluate((needle: string) => {
    const buttons = Array.from(document.querySelectorAll("button"));
    // Look for an Add button whose aria-label contains the product name.
    for (const btn of buttons) {
      const label = (btn.getAttribute("aria-label") ?? "").toLowerCase();
      if (!label.startsWith("add") || !label.includes(needle)) continue;
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if ((btn as HTMLButtonElement).disabled) continue;
      btn.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
      (btn as HTMLButtonElement).click();
      return { kind: "added" as const, label: label.slice(0, 80) };
    }
    // No Add button — check if the item is ALREADY IN CART. Look for the
    // product's image anchor (alt text), then look for a qty stepper in the
    // same card container.
    const imgs = Array.from(
      document.querySelectorAll('img[data-testid="item-card-image"]'),
    ) as HTMLImageElement[];
    for (const img of imgs) {
      const alt = (img.getAttribute("alt") ?? "").toLowerCase();
      if (!alt.includes(needle)) continue;
      const card = img.closest('[role="group"]') ?? img.parentElement?.parentElement;
      if (!card) continue;
      const qtyBtn = card.querySelector(
        'button[aria-label*="Quantity" i], button[aria-label*="Change quantity" i]',
      );
      if (qtyBtn) {
        return { kind: "already-in-cart" as const, label: alt.slice(0, 80) };
      }
    }
    return { kind: "not-found" as const, label: "" };
  }, nameKey);

  console.log(
    `[add] item="${item.name.slice(0, 40)}" → ${firstResult.kind}${firstResult.label ? ` (${firstResult.label})` : ""}`,
  );

  if (firstResult.kind === "not-found") {
    return { kind: "not-found", reason: `no Add button or qty stepper found for "${nameKey}"` };
  }

  if (firstResult.kind === "added") {
    await page.waitForTimeout(500);
  }

  // How many Increase clicks to apply.
  // - "added" first: we already added 1, so bump (item.qty - 1) more.
  // - "already-in-cart" in adhoc mode: user wants item.qty MORE, so bump item.qty times.
  // - "already-in-cart" in bulk mode: leave the existing qty alone (bulk just ensures presence).
  const bumpCount =
    firstResult.kind === "added"
      ? item.qty - 1
      : mode === "adhoc"
        ? item.qty
        : 0;

  for (let i = 0; i < bumpCount; i++) {
    const bumpResult = await page.evaluate((needle: string) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const btn of buttons) {
        const label = (btn.getAttribute("aria-label") ?? "").toLowerCase();
        if (!label.includes("increase") || !label.includes(needle)) continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if ((btn as HTMLButtonElement).disabled) continue;
        btn.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
        (btn as HTMLButtonElement).click();
        return true;
      }
      return false;
    }, nameKey);
    if (!bumpResult) break;
    await page.waitForTimeout(250);
  }
  // In adhoc mode, "already-in-cart" + bumped means we DID add (the bump
  // increases qty by item.qty). Surface that as "added" so the user sees a
  // proper "added" count rather than a confusing "already in cart".
  if (firstResult.kind === "already-in-cart" && mode === "adhoc" && bumpCount > 0) {
    return { kind: "added" };
  }
  return firstResult.kind === "added" ? { kind: "added" } : { kind: "already-in-cart" };
}

async function getCartCount(page: Page): Promise<number> {
  // The floating cart button text looks like "View cart\n1" or "View cart\n3".
  const text = await page
    .locator('[data-testid="floating-cart-button"]')
    .first()
    .innerText()
    .catch(() => "");
  const m = text.match(/\b(\d+)\b/);
  return m ? parseInt(m[1], 10) : 0;
}

interface AddBatchResult {
  added: ScrapedItem[]; // newly clicked Add
  alreadyInCart: ScrapedItem[]; // were already there before this run
  failed: ScrapedItem[]; // couldn't add and not in cart
}

async function addAllWithVerification(
  page: Page,
  items: ScrapedItem[],
  mode: "bulk" | "adhoc" = "bulk",
): Promise<AddBatchResult> {
  const added: ScrapedItem[] = [];
  const alreadyInCart: ScrapedItem[] = [];
  const failed: ScrapedItem[] = [];
  for (const item of items) {
    if (item.unavailable) {
      failed.push(item);
      continue;
    }
    const outcome = await addItemWithVerification(page, item, mode);
    if (outcome.kind === "added") added.push(item);
    else if (outcome.kind === "already-in-cart") alreadyInCart.push(item);
    else failed.push(item);
  }
  return { added, alreadyInCart, failed };
}

// ---------- cart-page verification ----------

async function navigateToCart(page: Page): Promise<string | null> {
  const candidates = [
    "https://www.instacart.com/store/costco/cart",
    "https://www.instacart.com/store/cart",
    "https://www.instacart.com/cart",
  ];
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1500);
      if (/cart/i.test(page.url()) && !/login|signin/i.test(page.url())) return page.url();
    } catch {
      /* try next */
    }
  }
  return null;
}

async function countCartLineItems(page: Page): Promise<number> {
  // Give the cart page time to render (network + hydration).
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Try cart-icon counter first — Instacart maintains this server-side and
  // it shows on every page, very reliable signal of items in cart.
  const iconBadge = page
    .locator('[aria-label*="cart" i] [aria-hidden], [data-testid*="cart-counter"], [aria-label*="items in cart" i]')
    .first();
  const iconText = await iconBadge.innerText().catch(() => "");
  const iconNum = parseInt(iconText.match(/\d+/)?.[0] ?? "0", 10);
  if (iconNum > 0) return iconNum;

  // Look at the aria-label of the cart icon button (e.g. "Cart, 3 items").
  const cartBtn = page.locator('button[aria-label*="art" i]').first();
  const cartLabel = (await cartBtn.getAttribute("aria-label").catch(() => "")) ?? "";
  const labelMatch = cartLabel.match(/(\d+)\s*item/i);
  if (labelMatch) return parseInt(labelMatch[1], 10);

  // DOM-side line item counters (variant selectors).
  const candidates = [
    '[data-testid*="cart-line-item"]',
    '[data-testid*="line-item"]',
    '[data-testid*="cart-item"]',
    'img[data-testid="item-card-image"]', // product cards on the cart page
    'div[role="listitem"]',
  ];
  for (const sel of candidates) {
    const n = await page.locator(sel).count().catch(() => 0);
    if (n > 0) return n;
  }

  // Last resort — extract a number from any "N items" string on the page body.
  const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
  const bodyMatch = body.match(/(\d+)\s+items?\b/i);
  if (bodyMatch) return parseInt(bodyMatch[1], 10);
  return 0;
}

// ---------- checkout verification ----------

interface CheckoutEvidence {
  url: string;
  placeOrderEnabled: boolean;
  subtotalUsd: number | null;
  rawTotalText: string | null;
  hasAddress: boolean;
  hasPaymentSummary: boolean;
}

async function navigateToCheckout(page: Page): Promise<string | null> {
  // Instacart's checkout flow is three steps from any storefront page:
  //   1. Click the floating cart button → opens cart sidebar
  //   2. Click "Go to checkout" in the sidebar → lands on /checkout_aisle (upsell)
  //   3. Click "Continue to checkout" → lands on the real checkout page

  // Step 1: open cart sidebar
  try {
    await page.locator('[data-testid="floating-cart-button"]').first().click({ timeout: 5000 });
  } catch {
    return null;
  }
  await page.waitForTimeout(1500);

  // Step 2: "Go to checkout" inside the sidebar
  try {
    const goBtn = page.getByText(/Go to checkout/i).first();
    await goBtn.scrollIntoViewIfNeeded({ timeout: 4000 });
    await goBtn.click({ timeout: 5000 });
  } catch {
    return null;
  }
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Step 3: "Continue to checkout" on the upsell aisle page
  // (skip if we somehow landed past it)
  try {
    const continueBtn = page.getByText(/Continue to checkout/i).first();
    if (await continueBtn.isVisible({ timeout: 3000 })) {
      await continueBtn.scrollIntoViewIfNeeded({ timeout: 3000 });
      await continueBtn.click({ timeout: 5000 });
    }
  } catch {
    /* may not have a "Continue" step on some flows */
  }
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const finalUrl = page.url();
  const bodyText = (await page.locator("body").innerText().catch(() => "")) ?? "";
  if (/404|not found|page you'?re looking for/i.test(bodyText.slice(0, 500))) return null;
  if (/login|signin/i.test(finalUrl)) return null;
  if (!/checkout/i.test(finalUrl)) return null;
  return finalUrl;
}

async function gatherCheckoutEvidence(page: Page): Promise<CheckoutEvidence> {
  const url = page.url();

  // Place Order button visibility + enabled state
  const placeBtn = page
    .locator(
      'button:has-text("Place order"), button:has-text("Place Order"), [data-testid*="place-order"]',
    )
    .first();
  const placeOrderEnabled =
    (await placeBtn.isVisible().catch(() => false)) &&
    (await placeBtn.isEnabled().catch(() => false));

  // Subtotal / total parsing — grab body text and pull the largest currency value near "Total"
  const bodyText = (await page.locator("body").innerText().catch(() => "")) ?? "";
  const totalMatch = bodyText.match(/(?:Order\s+total|Total|Subtotal)[\s\S]{0,40}?\$(\d+(?:\.\d{2})?)/i);
  const subtotalUsd = totalMatch ? parseFloat(totalMatch[1]) : null;
  const rawTotalText = totalMatch ? totalMatch[0].slice(0, 80) : null;

  const hasAddress = /Deliver(?:ed|y)?\s+to|Delivery\s+address|Ship(?:ping)?\s+to/i.test(bodyText);
  const hasPaymentSummary = /\b(?:Visa|Mastercard|Amex|Discover|•{2,}\s*\d{4}|ending\s+in\s+\d{4})\b/i.test(bodyText);

  return { url, placeOrderEnabled, subtotalUsd, rawTotalText, hasAddress, hasPaymentSummary };
}

// ---------- place order (3-state) ----------

type PlaceResult =
  | { kind: "CONFIRMED"; orderId: string; finalUrl: string }
  | { kind: "LIKELY"; finalUrl: string; bodySnippet: string; screenshotPath: string }
  | { kind: "UNCONFIRMED"; reason: string; finalUrl: string; screenshotPath: string };

async function snapshotPage(page: Page, label: string): Promise<string> {
  if (!existsSync(SCRATCH_DIR)) mkdirSync(SCRATCH_DIR, { recursive: true });
  const path = join(SCRATCH_DIR, `${label}-${Date.now()}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function placeOrderWithVerification(page: Page): Promise<PlaceResult> {
  const btn = page
    .locator(
      'button:has-text("Place order"), button:has-text("Place Order"), [data-testid*="place-order"]',
    )
    .first();

  try {
    await btn.scrollIntoViewIfNeeded({ timeout: 4000 });
    if (!(await btn.isEnabled())) {
      const snap = await snapshotPage(page, "place-disabled");
      return { kind: "UNCONFIRMED", reason: "Place Order button disabled", finalUrl: page.url(), screenshotPath: snap };
    }
    await btn.click({ timeout: 6000 });
  } catch (err) {
    const snap = await snapshotPage(page, "place-click-failed");
    return {
      kind: "UNCONFIRMED",
      reason: `Place Order click failed: ${(err as Error).message}`,
      finalUrl: page.url(),
      screenshotPath: snap,
    };
  }

  // Wait for navigation away from /checkout. Confirmation pages live at /orders/{id}.
  try {
    await page.waitForURL(/\/orders?\/[A-Za-z0-9_-]{6,}|\/order_status\/[A-Za-z0-9_-]{6,}/, {
      timeout: 30000,
    });
  } catch {
    // Did not redirect to a known orders URL. Check current state.
    const finalUrl = page.url();
    const bodyText = (await page.locator("body").innerText().catch(() => "")) ?? "";
    const snap = await snapshotPage(page, "place-no-redirect");
    if (/checkout/i.test(finalUrl)) {
      return {
        kind: "UNCONFIRMED",
        reason: "Still on /checkout after click — order did not place",
        finalUrl,
        screenshotPath: snap,
      };
    }
    return {
      kind: "LIKELY",
      finalUrl,
      bodySnippet: bodyText.slice(0, 240),
      screenshotPath: snap,
    };
  }

  // Got to /orders/{id}. Extract the id from URL.
  const finalUrl = page.url();
  const idMatch = finalUrl.match(/\/orders?\/([A-Za-z0-9_-]+)/);
  const orderId = idMatch ? idMatch[1] : "";

  // Sanity: confirmation page should have a "Thanks" / "Order placed" heading or order-id element.
  await page.waitForTimeout(2000);
  const headingPresent = await page
    .locator('h1:has-text("Thanks"), h1:has-text("Order"), h2:has-text("Thanks"), h2:has-text("placed")')
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  if (orderId && (headingPresent || /\/orders/i.test(finalUrl))) {
    return { kind: "CONFIRMED", orderId, finalUrl };
  }

  const snap = await snapshotPage(page, "place-likely");
  const bodyText = (await page.locator("body").innerText().catch(() => "")) ?? "";
  return { kind: "LIKELY", finalUrl, bodySnippet: bodyText.slice(0, 240), screenshotPath: snap };
}

// ---------- state machine + idempotency ----------

type State =
  | { kind: "IDLE" }
  | { kind: "RUNNING"; context: BrowserContext; page: Page; requesterId: string; startedAt: number }
  | {
      kind: "AWAITING_OKAY";
      context: BrowserContext;
      page: Page;
      requesterId: string;
      startedAt: number;
      summary: string;
      subtotalUsd: number;
      checkoutUrl: string;
    }
  | {
      // Transient: mid-amend, between AWAITING_OKAY → AWAITING_OKAY-with-new-total.
      // We snapshot the previous AWAITING_OKAY values so we can restore on failure.
      kind: "AMENDING";
      context: BrowserContext;
      page: Page;
      requesterId: string;
      startedAt: number;
      previousSummary: string;
      previousSubtotalUsd: number;
      previousCheckoutUrl: string;
    };

let state: State = { kind: "IDLE" };
const AWAITING_OKAY_TIMEOUT_MS = 10 * 60 * 1000;
let lastCompletedAt = 0;

// Single-flow lock. Lets the polling loop keep fetching while runFullFlow is in flight.
let runInFlight = false;

// Queue for "add X" messages that arrive while RUNNING or AMENDING. Drained
// once the in-flight flow lands in AWAITING_OKAY.
const MAX_PENDING_AMENDS = 10;
const pendingAmends: string[] = [];

function isInIdempotencyWindow(): boolean {
  return Date.now() - lastCompletedAt < IDEMPOTENCY_WINDOW_MS;
}

async function closeRunningBrowser(): Promise<void> {
  if (
    state.kind === "RUNNING" ||
    state.kind === "AWAITING_OKAY" ||
    state.kind === "AMENDING"
  ) {
    try {
      await state.context.close();
    } catch {
      /* ignore */
    }
    state = { kind: "IDLE" };
  }
  pendingAmends.length = 0;
}

// ---------- the orchestrator ----------

/**
 * Reusable post-cart-add walk: navigate to checkout, validate evidence,
 * spend-cap check, screenshot, post approve-prompt, and transition to
 * AWAITING_OKAY. Called from both runFullFlow (initial run) and
 * amendCartInPlace (mid-approval add).
 *
 * Returns true if the state successfully landed in AWAITING_OKAY,
 * false if any guard tripped and the bot posted an abort message.
 */
async function proceedToApprovalGate(
  context: BrowserContext,
  page: Page,
  requesterId: string,
  startedAt: number,
): Promise<boolean> {
  const cartUrlFallback = "https://www.instacart.com/store/costco/cart";

  const checkoutUrl = await navigateToCheckout(page);
  if (!checkoutUrl) {
    await postMessage(
      `*Aborting:* couldn't reach checkout page. Cart is built — finish manually at ${cartUrlFallback}`,
    );
    return false;
  }
  const evidence = await gatherCheckoutEvidence(page);
  if (!evidence.placeOrderEnabled) {
    const snap = await snapshotPage(page, "checkout-no-button");
    await uploadScreenshot(
      snap,
      `*Aborting:* Place Order button not enabled. Could be missing address, payment, or other required field. URL: ${evidence.url}`,
    );
    return false;
  }
  if (!evidence.hasAddress || !evidence.hasPaymentSummary) {
    const snap = await snapshotPage(page, "checkout-missing");
    await uploadScreenshot(
      snap,
      `*Aborting:* checkout page is missing ${!evidence.hasAddress ? "delivery address" : "payment summary"}. Fix in Instacart, then retry.`,
    );
    return false;
  }
  if (evidence.subtotalUsd === null) {
    const snap = await snapshotPage(page, "checkout-no-total");
    await uploadScreenshot(snap, `*Aborting:* couldn't parse order total. Not placing.`);
    return false;
  }
  if (evidence.subtotalUsd > SPEND_CAP_USD) {
    const snap = await snapshotPage(page, "checkout-over-cap");
    await uploadScreenshot(
      snap,
      `*Aborting:* order total $${evidence.subtotalUsd.toFixed(2)} exceeds $${SPEND_CAP_USD} cap. Not placing.`,
    );
    return false;
  }

  const snap = await snapshotPage(page, "checkout-preview");
  const summary =
    `Total: *$${evidence.subtotalUsd.toFixed(2)}*\n` +
    `Address ✓ · Payment ✓ · Place Order button ✓\n` +
    `URL: ${evidence.url}`;
  const approvePrompt = DRY_RUN
    ? `*DRY-RUN — would stop here.* No order will be placed even if you say okay.\n\n${summary}`
    : `*Ready to place order.* Reply *okay* to confirm + place, *add X* to amend, or *cancel*.\n\n${summary}\n\n_(auto-cancels in 10 min of no activity)_`;
  await uploadScreenshot(snap, approvePrompt);

  state = {
    kind: "AWAITING_OKAY",
    context,
    page,
    requesterId,
    startedAt,
    summary,
    subtotalUsd: evidence.subtotalUsd,
    checkoutUrl: evidence.url,
  };
  return true;
}

/**
 * Mid-approval amend: add an item to the active cart without leaving AWAITING_OKAY
 * semantics. Transitions to AMENDING while it does the work, then back to
 * AWAITING_OKAY (with new total). Spend-cap still gates the new total.
 */
async function amendCartInPlace(phrase: string): Promise<void> {
  if (state.kind !== "AWAITING_OKAY") {
    // Defensive — caller should only invoke from AWAITING_OKAY
    return;
  }
  const { context, page, requesterId, summary, subtotalUsd, checkoutUrl } = state;
  // Reset startedAt so the 10-min timeout restarts on active interaction.
  const startedAt = Date.now();
  state = {
    kind: "AMENDING",
    context,
    page,
    requesterId,
    startedAt,
    previousSummary: summary,
    previousSubtotalUsd: subtotalUsd,
    previousCheckoutUrl: checkoutUrl,
  };

  const restoreOnFailure = async (note?: string) => {
    state = {
      kind: "AWAITING_OKAY",
      context,
      page,
      requesterId,
      startedAt,
      summary,
      subtotalUsd,
      checkoutUrl,
    };
    if (note) await postMessage(note);
  };

  await postMessage(`Adding _${phrase.slice(0, 60)}_ to your cart...`);

  try {
    if (!(await gotoBuyAgain(page))) {
      await restoreOnFailure(
        "Couldn't reach Buy Again to amend. Cart preserved at previous state — reply *okay* or *cancel*.",
      );
      return;
    }
    const allItems = await scrapeItems(page);
    const resolution = await resolveRequest(phrase, allItems);
    const toAdd = resolution.resolved.map((r) => ({ ...r.item, qty: r.qty }));

    if (toAdd.length === 0) {
      let msg = `Couldn't match anything for _${phrase.slice(0, 40)}_.`;
      if (resolution.unmatched.length) {
        msg += `\nUnmatched: ${resolution.unmatched.map((p) => `_${p}_`).join(", ")}`;
      }
      if (resolution.ambiguous.length) {
        msg += "\nAmbiguous (be more specific):";
        for (const a of resolution.ambiguous) {
          msg += `\n  _${a.phrase}_: ${a.candidates.map((c) => c.name.slice(0, 35)).join(" / ")}`;
        }
      }
      await postMessage(msg);
      await restoreOnFailure();
      return;
    }

    const cartBefore = await getCartCount(page);
    const { added, alreadyInCart, failed } = await addAllWithVerification(page, toAdd, "adhoc");
    await page.waitForTimeout(1000);
    const cartAfter = await getCartCount(page);

    let progressMsg = `Amended: *${added.length}* added`;
    if (alreadyInCart.length) progressMsg += `, *${alreadyInCart.length}* already in cart`;
    if (failed.length) progressMsg += `, *${failed.length}* failed`;
    progressMsg += ".";
    if (cartAfter !== cartBefore + added.reduce((s, i) => s + i.qty, 0)) {
      progressMsg += ` _(cart counter: ${cartBefore} → ${cartAfter})_`;
    }
    if (failed.length) {
      progressMsg += `\n⚠️ Couldn't add: ${failed.map((f) => `_${f.name.slice(0, 30)}_`).join(", ")}`;
    }
    await postMessage(progressMsg);

    if (added.length + alreadyInCart.length === 0) {
      await restoreOnFailure(
        "No items landed in cart. Cart preserved at previous state — reply *okay* or *cancel*.",
      );
      return;
    }

    const ok = await proceedToApprovalGate(context, page, requesterId, startedAt);
    if (!ok) {
      await restoreOnFailure(
        "Couldn't re-confirm checkout after amend. Restored to previous state — reply *okay* or *cancel*.",
      );
    }
  } catch (err) {
    await postMessage(`Error during amend: \`${(err as Error).message}\``);
    await restoreOnFailure();
  }
}

async function drainPendingAmends(): Promise<void> {
  while (pendingAmends.length > 0 && state.kind === "AWAITING_OKAY") {
    const phrase = pendingAmends.shift()!;
    await amendCartInPlace(phrase);
  }
}

function spawnFlow(fn: () => Promise<void>): void {
  if (runInFlight) {
    console.error("[spawnFlow] race: another flow is already in flight");
    return;
  }
  runInFlight = true;
  fn()
    .catch((err) => {
      console.error("flow error:", err);
    })
    .finally(async () => {
      runInFlight = false;
      if (state.kind === "AWAITING_OKAY" && pendingAmends.length > 0) {
        await drainPendingAmends();
      }
    });
}

async function runFullFlow(
  triggerKind: "bulk" | "ad-hoc",
  requestText: string,
  requesterId: string,
): Promise<void> {
  // Pre-flight: dispatchTrigger already gated state (IDLE only) + idempotency,
  // but profile-existence still needs to be checked here.
  if (!existsSync(PROFILE_DIR)) {
    await postMessage("No Instacart profile. Run `npx tsx scripts/instacart-auth.ts` first.");
    return;
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  state = { kind: "RUNNING", context, page, requesterId, startedAt: Date.now() };

  try {
    await postMessage(
      triggerKind === "bulk"
        ? "Starting full Buy Again reorder..."
        : `Looking up: _${requestText}_ ...`,
    );

    // Phase 1: scrape Buy Again
    await page.goto("https://www.instacart.com/", { waitUntil: "domcontentloaded" });
    if (/login|signin/.test(page.url())) {
      await postMessage(
        "Instacart session expired. Re-run `npx tsx scripts/instacart-auth.ts` and try again.",
      );
      return;
    }
    if (!(await gotoBuyAgain(page))) {
      await postMessage("Could not reach Buy It Again. Aborting.");
      return;
    }
    const allItems = await scrapeItems(page);
    if (allItems.length === 0) {
      await postMessage("Got 0 items from Buy It Again — something's off. Aborting.");
      return;
    }

    // Phase 2: select items
    let toAdd: ScrapedItem[];
    let resolutionMsg = "";
    if (triggerKind === "bulk") {
      toAdd = allItems.filter((i) => !i.unavailable);
      resolutionMsg = `Adding *${toAdd.length}* items from Buy It Again...`;
    } else {
      const resolution = await resolveRequest(requestText, allItems);
      toAdd = resolution.resolved.map((r) => ({ ...r.item, qty: r.qty }));

      let msg = "*Matched:*";
      for (const r of resolution.resolved) {
        const semFlag = r.isSemantic ? " _(semantic match)_" : "";
        const qtyLabel = r.qty > 1 ? ` ×${r.qty}` : "";
        msg += `\n  • _${r.phrase}_ → ${r.item.name.slice(0, 55)}${qtyLabel}  ${r.item.price ?? ""}${semFlag}`;
      }
      if (resolution.unmatched.length) {
        msg += `\n\n*Skipped — no match:* ${resolution.unmatched.map((p) => `_${p}_`).join(", ")}`;
      }
      if (resolution.ambiguous.length) {
        msg += "\n\n*Skipped — ambiguous (be more specific):*";
        for (const a of resolution.ambiguous) {
          msg += `\n  _${a.phrase}_: ${a.candidates.map((c) => c.name.slice(0, 35)).join(" / ")}`;
        }
      }
      resolutionMsg = msg;
      await postMessage(resolutionMsg);
    }

    if (toAdd.length === 0) {
      await postMessage("Nothing to add — aborting.");
      return;
    }
    if (triggerKind === "bulk") await postMessage(resolutionMsg);

    // Phase 3: add items. Items already in cart are treated as success.
    // Bulk mode: leave existing qtys alone. Ad-hoc: a request like "add one
    // skinny pop" means "give me one MORE" even if it's already in cart.
    const cartBefore = await getCartCount(page);
    const { added, alreadyInCart, failed } = await addAllWithVerification(
      page,
      toAdd,
      triggerKind === "bulk" ? "bulk" : "adhoc",
    );
    await page.waitForTimeout(1000);
    const cartAfter = await getCartCount(page);
    const inCartCount = added.length + alreadyInCart.length;
    const successRate = inCartCount / toAdd.length;
    console.log(
      `cart count: before=${cartBefore} after=${cartAfter} added=${added.length} alreadyInCart=${alreadyInCart.length} failed=${failed.length}`,
    );
    if (inCartCount === 0) {
      const snap = await snapshotPage(page, "add-zero").catch(() => "");
      const msg =
        "*Aborting:* none of the requested items could be added or are already in cart. Selector breakage or Instacart UI changed. Nothing was placed.";
      if (snap) await uploadScreenshot(snap, msg);
      else await postMessage(msg);
      return;
    }
    if (successRate < MIN_SUCCESS_RATE) {
      await postMessage(
        `*Aborting:* only ${inCartCount}/${toAdd.length} items in cart (under ${Math.round(MIN_SUCCESS_RATE * 100)}% success). Nothing placed. Failed: ${failed
          .slice(0, 5)
          .map((f) => `_${f.name.slice(0, 30)}_`)
          .join(", ")}`,
      );
      return;
    }

    let progressMsg = `Cart ready: *${added.length}* added, *${alreadyInCart.length}* already in cart, *${failed.length}* failed (of ${toAdd.length} requested).`;
    if (failed.length) {
      progressMsg += `\n⚠️ Couldn't add: ${failed.map((f) => `_${f.name.slice(0, 30)}_`).join(", ")}`;
    }
    if (cartAfter !== cartBefore + added.reduce((s, i) => s + i.qty, 0)) {
      progressMsg += `\n_(cart counter: ${cartBefore} → ${cartAfter})_`;
    }
    await postMessage(progressMsg);

    // Phases 5-7: checkout nav + evidence + spend-cap + screenshot + AWAITING_OKAY.
    // Same helper is used by amendCartInPlace so adds during approval re-derive
    // the gate with a fresh total.
    const startedAt = state.kind === "RUNNING" ? state.startedAt : Date.now();
    const ok = await proceedToApprovalGate(context, page, requesterId, startedAt);
    if (!ok) {
      // proceedToApprovalGate already posted the abort reason; tear down browser.
      try {
        await context.close();
      } catch {
        /* ignore */
      }
      state = { kind: "IDLE" };
    }
    return; // browser stays alive (on success); handlePlaceConfirmed continues on "okay"
  } catch (err) {
    await postMessage(`Fatal error during order flow: \`${(err as Error).message}\``);
    console.error(err);
    await closeRunningBrowser();
  }
}

async function handlePlaceConfirmed(): Promise<void> {
  if (state.kind !== "AWAITING_OKAY") return;
  const { context, page, subtotalUsd, checkoutUrl } = state;

  if (DRY_RUN) {
    await postMessage(`*DRY-RUN:* would have placed order for $${subtotalUsd.toFixed(2)}. Skipping actual click.`);
    lastCompletedAt = Date.now();
    await closeRunningBrowser();
    return;
  }

  await postMessage(`Placing order — $${subtotalUsd.toFixed(2)}...`);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1500);

  try {
    const result = await placeOrderWithVerification(page);
    if (result.kind === "CONFIRMED") {
      lastCompletedAt = Date.now();
      await postMessage(
        `✓ *Ordered.* Confirmation: \`${result.orderId}\`\n` +
          `Receipt: ${result.finalUrl}\n` +
          `_Substitution preferences: ${SUBSTITUTION_SETTINGS_URL}_`,
      );
    } else if (result.kind === "LIKELY") {
      lastCompletedAt = Date.now();
      await uploadScreenshot(
        result.screenshotPath,
        `*Clicked Place Order — couldn't confirm.* Page may have placed the order but I can't verify from the response.\n\n` +
          `Final URL: ${result.finalUrl}\n` +
          `Check your orders: https://www.instacart.com/store/account/orders\n\n` +
          `Body snippet: _${result.bodySnippet.slice(0, 200)}_`,
      );
    } else {
      await uploadScreenshot(
        result.screenshotPath,
        `*Did NOT place order.* Reason: ${result.reason}\nFinal URL: ${result.finalUrl}\n\nCart preserved — verify at ${checkoutUrl}`,
      );
    }
  } catch (err) {
    await postMessage(`Error placing order: \`${(err as Error).message}\``);
  } finally {
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    state = { kind: "IDLE" };
  }
}

// ---------- message router ----------

const TRIGGER_RE = /\b(order\s+costco\s+snacks?|snack\s+run|order\s+snacks?|costco\s+snacks?)\b/i;
const ADD_RE = /^\s*(?:add(?:\s+in)?|order\s+me|get\s+me|throw\s+in|grab\s+(?:me\s+)?|i\s+want)\s+(.+)$/i;
const CANCEL_RE = /^\s*(cancel|stop|abort|nvm|nevermind|no)\s*$/i;
const OKAY_RE = /^\s*(okay|ok|yes|yep|yeah|go|place|do\s+it|ship\s+it|confirm|looks\s+good|lgtm|👍|✅)\s*\.?!?\s*$/i;
const STATUS_RE = /^\s*(?:what'?s?\s+in\s+(?:my\s+)?cart|show\s+(?:me\s+)?(?:my\s+)?cart|cart\??|status\??)\s*\??\s*$/i;
const HELP_RE = /^\s*(?:help|what\s+can\s+you\s+do|commands?|\?)\s*$/i;

async function handleStatus(): Promise<void> {
  if (state.kind === "IDLE") {
    const cool = isInIdempotencyWindow()
      ? ` (cooling down for ${Math.ceil((IDEMPOTENCY_WINDOW_MS - (Date.now() - lastCompletedAt)) / 1000)}s after last order)`
      : "";
    const queued =
      pendingAmends.length > 0
        ? ` (${pendingAmends.length} pending add${pendingAmends.length === 1 ? "" : "s"} queued)`
        : "";
    await postMessage(
      `No active order${cool}${queued}. Say *order costco snacks* or *add X* to place one.`,
    );
    return;
  }
  if (state.kind === "RUNNING") {
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    const queued = pendingAmends.length > 0 ? ` (${pendingAmends.length} adds queued)` : "";
    await postMessage(
      `Building cart — ${elapsed}s elapsed${queued}. Started by <@${state.requesterId}>.`,
    );
    return;
  }
  if (state.kind === "AMENDING") {
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    const queued = pendingAmends.length > 0 ? ` (${pendingAmends.length} more queued)` : "";
    await postMessage(`Amending cart — ${elapsed}s${queued}.`);
    return;
  }
  // AWAITING_OKAY
  const queued =
    pendingAmends.length > 0
      ? `\n_(${pendingAmends.length} more add${pendingAmends.length === 1 ? "" : "s"} queued — will run after this)_`
      : "";
  await postMessage(
    `*Cart ready, waiting on your okay.*\n${state.summary}\n\nReply *okay* to place, *add X* to amend, *cancel* to abort.${queued}`,
  );
}

async function handleHelp(): Promise<void> {
  const mode = DRY_RUN ? " *(DRY-RUN — no real orders will be placed)*" : "";
  await postMessage(
    `*Snack bot${mode}*\n` +
      `  • *order costco snacks* → Sophie only. Builds full Buy Again cart, stops at checkout for your okay.\n` +
      `  • *add pirate bootie, 2 green teas* → Sophie only. Builds cart with those items, stops for okay.\n` +
      `  • *add X* during the okay prompt → adds *X* to the current cart and re-prompts with the new total.\n` +
      `  • *add X* while the bot is mid-build → queued and applied automatically once it lands at okay.\n` +
      `  • *okay* → confirms placement once cart is ready.\n` +
      `  • *cart* / *status* → anyone. Shows what's pending + queue depth.\n` +
      `  • *cancel* → Sophie only. Aborts at any stage; clears the queue.\n` +
      `Safety: \$${SPEND_CAP_USD} cap, ${IDEMPOTENCY_WINDOW_MS / 60000}-min post-placement cooldown, 10-min approval timeout, ambiguous items skipped, max ${MAX_PENDING_AMENDS} queued adds.\n` +
      `Substitution settings: ${SUBSTITUTION_SETTINGS_URL}`,
  );
}

/**
 * Route an add/bulk trigger based on current state.
 *
 *   IDLE         → spawn a new flow (background-running so the polling loop keeps fetching)
 *   AWAITING_OKAY → mid-approval amend (ad-hoc adds extend the current cart)
 *   RUNNING      → queue (current build is in progress; we'll drain after AWAITING_OKAY)
 *   AMENDING     → queue (mid-amend; chain it after current amend finishes)
 *
 * Bulk triggers ("order costco snacks") only start from IDLE — running them
 * mid-flow would conflict with the in-flight order.
 */
async function dispatchTrigger(
  kind: "bulk" | "ad-hoc",
  phrase: string,
  sender: string,
): Promise<void> {
  if (state.kind === "IDLE") {
    if (runInFlight) {
      await postMessage("Hold on — another flow is finishing up. Retry in a few seconds.");
      return;
    }
    if (isInIdempotencyWindow()) {
      const remaining = Math.ceil(
        (IDEMPOTENCY_WINDOW_MS - (Date.now() - lastCompletedAt)) / 1000,
      );
      await postMessage(`Just placed an order — cooling down. Retry in ${remaining}s.`);
      return;
    }
    spawnFlow(() => runFullFlow(kind, phrase, sender));
    return;
  }

  if (state.kind === "AWAITING_OKAY") {
    if (kind === "bulk") {
      await postMessage(
        "Already have a cart waiting on your *okay*. Reply *cancel* first if you want to start over with a bulk reorder.",
      );
      return;
    }
    // ad-hoc → amend
    return amendCartInPlace(phrase);
  }

  // RUNNING or AMENDING → queue or reject
  if (kind === "bulk") {
    await postMessage(
      "Order is being built right now. Wait until I post the *okay* prompt, then start a new one.",
    );
    return;
  }
  // ad-hoc → queue
  if (pendingAmends.length >= MAX_PENDING_AMENDS) {
    await postMessage(
      `Queue full (${MAX_PENDING_AMENDS} pending). Wait for the current build to finish.`,
    );
    return;
  }
  pendingAmends.push(phrase);
  await postMessage(
    `Got it — queued _${phrase.slice(0, 60)}_. Will add it once the current build lands at the okay prompt.`,
  );
}

async function handleMessage(msg: SlackMessage): Promise<void> {
  if (!msg.text || msg.subtype) return;
  if (msg.user === SLACK_BOT_USER_ID) return;
  if (!msg.user) return;

  const t = msg.text
    .replace(new RegExp(`<@${SLACK_BOT_USER_ID}>\\s*`, "g"), "")
    .replace(/\s*\*Sent using\*\s*<@[A-Z0-9]+>\s*$/i, "")
    .trim();
  const isOwner = msg.user === SLACK_OWNER_USER_ID;
  const sender = msg.user;

  // Anyone can ask for status / help.
  if (STATUS_RE.test(t)) return handleStatus();
  if (HELP_RE.test(t)) return handleHelp();

  // Owner-only from here on. Colleagues silently ignored (no spam).
  if (!isOwner) {
    if (TRIGGER_RE.test(t) || ADD_RE.test(t)) {
      await postMessage(`<@${sender}> only <@${SLACK_OWNER_USER_ID}> can place orders.`);
    }
    return;
  }

  if (CANCEL_RE.test(t)) {
    if (
      state.kind === "RUNNING" ||
      state.kind === "AWAITING_OKAY" ||
      state.kind === "AMENDING"
    ) {
      await closeRunningBrowser();
      await postMessage("Cancelled — nothing placed.");
    } else {
      await postMessage("Nothing to cancel.");
    }
    return;
  }

  // "okay" — only meaningful when waiting for placement approval
  if (state.kind === "AWAITING_OKAY" && OKAY_RE.test(t)) {
    return handlePlaceConfirmed();
  }
  if (state.kind === "AMENDING" && OKAY_RE.test(t)) {
    await postMessage("Hold on — amending the cart right now. I'll re-prompt when ready.");
    return;
  }

  // Bulk trigger ("order costco snacks")
  if (TRIGGER_RE.test(t)) {
    return dispatchTrigger("bulk", t, sender);
  }

  // Ad-hoc add ("add X, Y, Z")
  const addMatch = t.match(ADD_RE);
  if (addMatch) {
    return dispatchTrigger("ad-hoc", addMatch[1], sender);
  }

  // Regex didn't match — fall back to LLM intent classification.
  const intent = await classifyIntent(t, state.kind);
  if (intent.kind === "approve") {
    if (state.kind === "AWAITING_OKAY") return handlePlaceConfirmed();
    if (state.kind === "AMENDING") {
      await postMessage("Hold on — amending the cart right now. I'll re-prompt when ready.");
      return;
    }
    // approve in IDLE or RUNNING → nothing to approve
  }
  if (intent.kind === "cancel") {
    if (
      state.kind === "RUNNING" ||
      state.kind === "AWAITING_OKAY" ||
      state.kind === "AMENDING"
    ) {
      await closeRunningBrowser();
      await postMessage("Cancelled — nothing placed.");
    } else {
      await postMessage("Nothing to cancel.");
    }
    return;
  }
  if (intent.kind === "status") return handleStatus();
  if (intent.kind === "trigger_bulk") return dispatchTrigger("bulk", t, sender);
  if (intent.kind === "trigger_add") return dispatchTrigger("ad-hoc", intent.phrase, sender);

  // Genuinely didn't get it.
  const tail =
    state.kind === "AWAITING_OKAY"
      ? "\n*Cart ready — reply okay to place, cancel to abort.*"
      : "";
  await postMessage(
    "Didn't catch that. Try:\n" +
      "  • *order costco snacks* — reorder full Buy Again list\n" +
      "  • *add pirate bootie, 2 green teas* — specific items\n" +
      "  • *okay* — confirm placement when cart is ready\n" +
      "  • *cart* — show what's running\n" +
      "  • *cancel* — abort in-flight run" +
      tail,
  );
}

// ---------- main loop ----------

async function main(): Promise<void> {
  if (!existsSync(PROFILE_DIR)) {
    console.error("No Instacart profile. Run `npx tsx scripts/instacart-auth.ts` first.");
    process.exit(2);
  }
  const mode = DRY_RUN ? " *(DRY-RUN — no orders will be placed)*" : "";
  await postMessage(
    `Snack bot online${mode}. Say *order costco snacks* or *add X, Y* — I'll build the cart, stop at checkout, and wait for your *okay* before placing. Help: *help*`,
  );

  let cursor = Math.floor(Date.now() / 1000).toString();
  while (true) {
    try {
      const msgs = await fetchNewMessages(cursor);
      for (const m of msgs) {
        cursor = m.ts;
        await handleMessage(m);
      }
      // Auto-cancel stale AWAITING_OKAY (user didn't reply within timeout window).
      // Same timeout applies if an amend gets wedged for too long.
      if (
        (state.kind === "AWAITING_OKAY" || state.kind === "AMENDING") &&
        Date.now() - state.startedAt > AWAITING_OKAY_TIMEOUT_MS
      ) {
        const stuckKind = state.kind;
        await closeRunningBrowser();
        await postMessage(
          stuckKind === "AMENDING"
            ? "⏱️ Amend timed out (10 min). Cart preserved on Instacart; nothing placed."
            : "⏱️ Order approval timed out (10 min). Cart preserved on Instacart; nothing placed.",
        );
      }
    } catch (err) {
      console.error("poll error:", (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
