---
name: pp-amazon
description: Amazon CLI for history-first reorders + full checkout. Use whenever Soph mentions ordering anything from Amazon ("order X", "add bath tissue to my cart", "restock my last Amazon order"). REFUSES to add anything not in her purchase history — that's the safety feature. Multi-account: business (sophie@2389.ai) vs personal (sophiealula@gmail.com).
allowed-tools: Bash(amazon-pp-cli:*)
---

# Amazon (pp-amazon)

A pre-installed Go CLI that talks directly to amazon.com using Soph's Safari session cookies. Local SQLite mirror of her purchase history. **Repurchase-only** by design — `add` refuses queries that don't match past purchases. Checkout uses the default shipping address + default payment method on file for each account.

## When to use

**Always use this first** when Soph mentions:
- Ordering / reordering / restocking ("order paper towels", "add bath tissue", "restock the usual")
- What she's bought before from Amazon ("did I order Charmin last time?", "what brand of detergent do I buy?")
- Cart state ("what's in my Amazon cart?", "show me my current cart")
- Placing an Amazon order ("checkout", "place the order")

## Account aliases

Soph has two profiles. **Always pass `--profile`** explicitly:

| Profile slug       | Soph's name for it                | Email                  |
|--------------------|------------------------------------|------------------------|
| `sophie-work`      | **business** / 2389 / work         | sophie@2389.ai         |
| `sophie-personal`  | **personal** / personal account    | sophiealula@gmail.com  |

Map natural language to the slug:
- "from my business account" / "on 2389" / "work" → `--profile sophie-work`
- "from my personal account" / "personal" → `--profile sophie-personal`
- "order X" with no account specified → **ask which account**, do not guess

## Required order flow (don't skip steps)

When Soph says "order X" or equivalent, you MUST run this sequence:

1. **Identify the account.** If unclear, ask: "business or personal?" — wait for her answer before any CLI call.
2. **Preview the match with --dry-run.**
   ```bash
   amazon-pp-cli --profile <slug> add '<query>' --dry-run --json
   ```
   Present matched ASIN, title, last purchase date, purchase count. Format like: *"Found: [title] (last bought [date], ordered [N]× before). Look right?"*

   **Check `match_quality` in the JSON output:**
   - `"strict"` → all tokens in her query matched the title. Present normally.
   - `"loose"` → only some tokens matched (FTS fallback). The match could be wrong. Add a warning: *"⚠️ Loose match — please make sure this is actually what you want before confirming."*
3. **Wait for her confirmation** ("yep", "yes", "that's it"). If she says no, search the history again or stop. Never proceed without explicit yes.
4. **Add to cart for real.**
   ```bash
   amazon-pp-cli --profile <slug> add '<query>' --json
   ```
   If `match_quality=loose`, the CLI will refuse with exit 11 unless you pass `--allow-loose`. Only pass `--allow-loose` AFTER Soph's step-3 confirmation explicitly named the loose-matched title back to you (so you know she saw it). If she just said "yep" without referencing the title, ask again: "Just confirming — you want [exact title]?" before passing `--allow-loose`.

   **CRITICAL — handling `add_failed`:** If the JSON response has `"added": false` with a `"reason"` mentioning "items-of-interest" or "silently dropped" or "cart did not change," **DO NOT retry. DO NOT proceed to checkout.** Amazon's bot detection just blocked the add. Tell Soph verbatim:
   > "Amazon refused to put [title] in the cart — likely a bot-detection block. Open https://www.amazon.com/dp/<ASIN> in Safari and tap Add to Cart there. Once it lands, I can take over again with checkout."
   This is the canary for the legacy silent-success bug. Retrying programmatically won't help — Amazon will keep blocking. Hand the user back to the browser.
5. **Show the cart, itemized (headless-browser render).**
   ```bash
   amazon-pp-cli --profile <slug> cart show --json
   ```
   This now drives a headless Chromium so JS-rendered cells are visible. The JSON has `items[]`, `subtotal`, `default_address`, `default_card_last4`. **List every line item by title and quantity** — do not just summarize as "N items, $X". The cart may contain things Soph added in prior sessions she's forgotten about.

   **CRITICAL — DO NOT SPECULATE about missing cart contents.** The parser may report fewer items than the subtotal suggests. If `subtotal` is much higher than `sum(items × ~unit-price)` OR if any item's `quantity = -1` (unknown), DO NOT say "the other items are still in there but not rendering." Tell Soph honestly: *"Cart shows N row(s), subtotal $X — but the qty parser might've undercounted. Want me to dump the raw page to compare?"* Items previously mentioned in earlier turns are NOT secretly still in the cart — they were wishlist/items-of-interest, which the parser now correctly filters out. NEVER reintroduce them as "hidden cart items."

   Format:
   ```
   Cart on [business/personal]:
     - Bounty Paper Towels 12-pack × 1     $28.99
     - Cuisinart Espresso Machine × 1      $399.99    ← already in cart from earlier
   Total: $428.98 • Ships to: [address line 1] • Card: ····4242
   ```
   **If `default_card_last4` is empty:** ask Soph once, "Which card on this account?" then store it:
   ```bash
   amazon-pp-cli --profile <slug> defaults set --card-last4 NNNN --card-label "Visa"
   ```
   Future cart-shows on this profile will surface it automatically.

   **If `cart show` exits 9 (manual_required):** Amazon hit a CAPTCHA or sign-in challenge. Skip steps 6–8 entirely and tell Soph: "Amazon's asking for a human check. Tap to finish in Safari: <deeplink from JSON>." Do not retry programmatically.
6. **Ask her to confirm placement of the FULL CART.** "Ready to place this order on your [business/personal] account? Total $428.98 — that's [item1] AND [pre-existing item]. Charging ····[last4]."
7. **Wait for her explicit yes via nanoclaw, in this turn, after seeing the itemized cart from step 5.** A "yes" said before the cart was shown does not count. No fresh yes = no purchase.
8. **Place the order (headless-browser checkout).**
   ```bash
   amazon-pp-cli --profile <slug> checkout --yes --json
   ```
   This drives the same headless Chromium through Amazon's checkout flow. On success, JSON has `status: "placed"`, `order_id`, `confirmation_url`. **If it exits 9 (manual_required):** Amazon flagged the place-order request. Tell Soph: "Amazon needs you to finish at <deeplink>. Tap there and the cart contents will be ready to place." The items are already in her cart — she just has to tap "Place order" in Safari. Do not retry programmatically; the CAPTCHA will only re-trigger.

**Hard rules:**
- **Whenever Soph asks "what's in my cart" or you need cart state, ALWAYS run `cart show` fresh. NEVER quote cart contents from earlier in the session.** Amazon's cart changes between turns; stale answers cause Soph to confirm purchases of things that aren't actually there (or miss things that are).
- Never run `checkout --yes` unless Soph confirmed *after* seeing the itemized cart contents from step 5 in the current turn.
- Never skip Step 2 (preview) — Soph must see what's about to be ordered before money moves.
- Never skip Step 5's itemization — pre-existing cart items must be surfaced to her.
- Never guess which account.
- Never bundle confirmations. A single utterance like "yes order paper towels and place it" does not count as both the step-3 and step-7 confirmations — you must show the cart and ask again.
- If `checkout --yes` returns exit 7 (transient error), re-run `cart show` and ask for a fresh yes before retrying. The original consent attaches to the original cart state, not to "any future retry of this intent."
- **If a prior turn in this session returned exit 127 ("command not found") for amazon-pp-cli, do NOT trust that result. Retry `which amazon-pp-cli && amazon-pp-cli --version` once before declaring the binary missing.** The orchestrator may have been restarted between turns, and the binary may now be installed. Only after a fresh retry confirms `command not found` should you tell Soph the binary is missing.

## Core commands

```bash
# Inspect history (read-only, safe)
amazon-pp-cli --profile sophie-personal history search 'bath tissue' --json
amazon-pp-cli --profile sophie-personal history list --limit 20
amazon-pp-cli --profile sophie-personal history stats

# Preview an add (no network call, no cart write)
amazon-pp-cli --profile sophie-personal add 'bath tissue' --dry-run --json
# returns: { "matched": true, "asin": "B07AAA0001", "title": "...", "purchase_count": 2, "last_purchased_at": "...", "added": false, "dry_run": true }

# Commit the add
amazon-pp-cli --profile sophie-personal add 'bath tissue' --json
amazon-pp-cli --profile sophie-personal add 'AAA batteries' --quantity 2

# Re-add every line from her most recent order
amazon-pp-cli --profile sophie-personal reorder-last --dry-run --json
amazon-pp-cli --profile sophie-personal reorder-last

# Current cart
amazon-pp-cli --profile sophie-personal cart show --json

# Place the order (REQUIRES --yes after explicit Soph confirmation)
amazon-pp-cli --profile sophie-personal checkout --dry-run        # sanity check
amazon-pp-cli --profile sophie-personal checkout --yes --json     # actually place

# Diagnose
amazon-pp-cli --profile sophie-personal doctor --json
```

## Output JSON contract

`add --json`:
```json
{
  "query": "bath tissue",
  "matched": true,
  "asin": "B07AAA0001",
  "title": "Charmin Ultra Strong 24 Mega Rolls",
  "purchase_count": 2,
  "last_purchased_at": "2026-04-02T00:00:00Z",
  "added": false,
  "dry_run": true,
  "quantity": 1
}
```

`reorder-last --json`:
```json
{
  "order_id": "112-0000003-0000003",
  "placed_at": "2026-04-28T00:00:00Z",
  "dry_run": true,
  "items": [{"asin": "...", "title": "...", "quantity": 1, "added": false}],
  "added_count": 0
}
```

`checkout --json` (success):
```json
{"order_id": "112-XXXXXXX-XXXXXXX", "confirmed": true}
```

`doctor --json`:
```json
{
  "profile": "sophie-personal",
  "cookies_loaded": true,
  "has_marker": true,
  "history_orders": 12,
  "history_items": 47,
  "last_purchased": "2026-04-28T00:00:00Z",
  "amazon_reached": true,
  "detected_account": "Sophie"
}
```

## Exit codes (route on these, not on stderr text)

| Code | Meaning | Action |
|------|---------|--------|
| 0 | OK | continue |
| 3 | auth error / no session | tell Soph: "Amazon session expired on `<profile>` — please re-auth on your laptop." STOP the flow. |
| 4 | no match in history | tell Soph: "No past Amazon purchase matches 'X' on `<profile>`. This CLI is repurchase-only." Do NOT search Amazon. |
| 5 | conflict | duplicate profile, etc. — surface message |
| 7 | transient (amazon.com 5xx, network) | retry once; if still failing, tell Soph |
| 10 | confirmation required | `checkout` was run without `--yes` — re-run with `--yes` ONLY after Soph has explicitly confirmed |

## Hard rules

1. **Never pass `--yes` to `checkout` without Soph's explicit in-turn confirmation.** Show her the cart contents first (`cart show --json`), spell out what's about to be ordered, wait for "yes do it" or equivalent, THEN run `checkout --yes`.
2. **Never bypass the repurchase-only safety rail.** If `add` returns exit 4, tell Soph "no history match" — do not improvise (don't run `agent-browser`, don't search Amazon, don't suggest a "first search result"). The whole point of this CLI is that the agent can't drift.
3. **--dry-run is free.** Prefer it for any `add` or `reorder-last` until you've shown Soph what you'd do.
4. **Always pass `--profile`.** Don't rely on the default active profile.

## Bulk-add preview rule

When Soph asks to add 3+ items in a single request, OR when she says "reorder last", ALWAYS run `--dry-run --json` first and surface the matched ASINs + titles to Soph before committing. One wrong match can land the wrong product in the cart.

## Auth failure handling

If `doctor` or any command returns exit 3 (auth error):
1. Reply: "Amazon session expired on `<profile>` — please re-auth on your laptop."
2. Do NOT try to re-auth from inside the container.
3. Do NOT fall back to `agent-browser`.

## Binary-missing handling

If `amazon-pp-cli` returns "command not found" or the binary isn't at `/usr/local/bin/amazon-pp-cli`, the container was spawned without the Amazon wiring. Reply to Soph: "Amazon CLI isn't in this container — needs `./container/build.sh` and an orchestrator restart." Do NOT try to install anything.

## What lives where (inside the container)

- Binary: `/usr/local/bin/amazon-pp-cli`
- Config + history DBs: `/home/node/.config/amazon-pp-cli/` (read-write mount from host's `~/.config/amazon-pp-cli/`)
- Per-profile DB: `/home/node/.config/amazon-pp-cli/profiles/<name>/history.db`
- Per-profile cookies: `/home/node/.config/amazon-pp-cli/profiles/<name>/cookies.json`

Host backfills cookies + history via the `docs/dumper.js` browser-side script; container queries and writes incremental purchase signal back via `add` / `reorder-last`.

## Anti-triggers (do NOT use this CLI for)

- New-item search on Amazon ("search Amazon for X", "find me a coffee maker") — repurchase-only, use `agent-browser` if Soph wants discovery.
- Returns or cancellations ("return that order", "cancel the order") — out of scope, route to amazon.com directly.
- Digital downloads / Kindle / Prime Video — different fulfillment, not modeled.
- Prime Pantry / Fresh / Whole Foods — different cart surfaces, not modeled.
