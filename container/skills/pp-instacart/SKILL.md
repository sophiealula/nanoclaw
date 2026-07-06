---
name: pp-instacart
description: Full Instacart capability — query history, add/remove cart items, AND check out. Use whenever Soph mentions ordering, past purchases, cart state, "place order", "submit cart", "check out", "dry-run my order", or "confirm <retailer>". Wraps `instacart-pp-cli` for inspect/mutate and drives Instacart's web UI via `agent-browser` for actual checkout. Two-turn gated flow for real orders; one-shot dry-run mode that walks the checkout without clicking submit.
allowed-tools: Bash(instacart-pp-cli:*), Bash(agent-browser:*), Bash(jq:*), Bash(cat:*), Bash(mkdir:*), Bash(date:*), Bash(test:*), Bash(rm:*), Bash(mv:*), Bash(ls:*), Bash(wc:*), Bash(echo:*), Read, Write, mcp__nanoclaw__send_message, mcp__nanoclaw__schedule_task, mcp__gsuite__gmail_list_messages, mcp__gsuite__gmail_get_message
---

# pp-instacart — Instacart cart, history, and checkout

A pre-installed Go CLI (`instacart-pp-cli`) that talks directly to Instacart's GraphQL API using Soph's session cookie + a local SQLite mirror of her purchase history. For actual checkout, the skill drives Instacart's web UI via `agent-browser` (Playwright) with hard cart-targeting gates.

Sourced from the [Printing Press](https://github.com/mvanhorn/cli-printing-press) framework — an agent-native CLI generator. Specific CLI: [`mvanhorn/printing-press-library/library/commerce/instacart`](https://github.com/mvanhorn/printing-press-library/tree/main/library/commerce/instacart).

---

# Section 1 — Read & search

## When to use

**Always use this first** when Soph mentions:
- Ordering anything ("add seaweed", "order the usual", "stock up on snacks")
- What she's bought before ("what's my usual coffee?", "did I buy X last time?")
- Cart state ("what's in my Costco cart?")

Before asking a clarifying question about *which* product to order, run `instacart-pp-cli history search` or `history list` to see what she actually buys. The `add` command also resolves to her real SKUs automatically when called with a natural-language query.

## Commands

```bash
# Search local purchase history (FTS)
instacart-pp-cli history search "green tea"
instacart-pp-cli history search "seaweed" --store costco --json

# List most-bought items
instacart-pp-cli history list --limit 20
instacart-pp-cli history list --store costco --limit 10

# Summary of what we know
instacart-pp-cli history stats

# Current carts across retailers
instacart-pp-cli carts list
instacart-pp-cli cart show costco
```

---

# Section 2 — Mutate cart (add / remove)

## Commands

```bash
# Add an item — checks history first, falls through to live search if no match
instacart-pp-cli add costco "the usual green tea" --json
instacart-pp-cli add costco "lemon sorbet" --dry-run --json    # preview without writing

# Remove an item from a cart (by item_id from `cart show` output)
instacart-pp-cli cart remove items_111-25239702 costco
```

Output of `add --json` includes `resolved_via: "history" | "live" | "history->live"` — useful to know whether the match came from past purchases or a live search guess.

## Bulk-add preview rule

When Soph asks to add **3 or more items** in a single request (e.g. "add my usual Costco run"), do NOT fire `add` directly. First run each candidate with `--dry-run --json` and surface the resolved SKU + `resolved_via` to Soph. Only proceed once she confirms the list. Skipping this is how wrong-add mistakes happen — `add` resolves natural language to SKUs, and a single bad match can land Milkadamia in your cart when you wanted granola.

For 1–2 items it's fine to add directly, but say what you're adding before you do.

## Fixing a wrong add

If you add the wrong item, do NOT tell Soph "you'll have to remove it in the app." Use `cart show <retailer>` to grab the `item_id`, then `cart remove <item_id> <retailer>`. The CLI supports add, remove, and inspect.

## Hard rules (cart mutation)

- **The CLI's cart IS the cart for our purposes.** When showing or discussing the cart (e.g., responding to "what's in my costco cart"), report ONLY what `instacart-pp-cli cart show <retailer>` returns. Do NOT volunteer info about other cart contexts you've seen in Instacart's web UI (Family Cart, Personal Cart, etc.) — that's a checkout-flow concern, handled below via the cart_id pin + cross-check gate. Soph shouldn't have to "switch cart mode in the app" — this skill handles cart targeting during checkout.
- **Prefer `--json` when piping or parsing output programmatically.** Use the human-readable form when surfacing results to Soph in chat.
- **Don't `add` without confirming with the user first** unless she explicitly said "go ahead" or "place the usual order."

---

# Section 3 — Checkout (real order)

Two-turn gated flow. **Never check out on the first message.** Always show the recap and require an explicit confirmation message.

## Turn 1 — Soph says "place order" / "submit my cart" / "check out" / etc.

1. **Refuse to proceed if a pending order already exists.** Check for `/workspace/group/.order-pending.json`. If it exists and its `created_at` is less than 2 minutes old, reply: "Already waiting on confirmation for the previous order. Reply `confirm <retailer>` or `cancel` first." Stop.
2. **Determine the retailer.** If Soph named one ("place my costco order"), use it. If not, run `instacart-pp-cli carts list` — if exactly one cart has items, use that retailer; if more than one, ask which.
3. **Show the cart.** `instacart-pp-cli cart show <retailer> --json` → parse the items.
4. **Look up the last order's tip.** `instacart-pp-cli history list --store <retailer> --limit 1 --json` (read the most-recent `delivered_at` order; the `instacart.db` table `orders` carries `tip_amount` if present — if no tip data, fall back to "default tip" and note in the recap).
5. **Write pending state.** Create `/workspace/group/.order-pending.json` atomically:
   ```json
   {
     "created_at": "<ISO 8601 now>",
     "retailer": "<slug>",
     "expected_token": "confirm <slug>",
     "item_count": <n>,
     "subtotal_estimate": "<from cart show>",
     "tip_plan": "copy last order's tip (<amount> or 'default')"
   }
   ```
6. **Send the recap via `mcp__nanoclaw__send_message`:**
   ```
   Ready to place this <retailer> order:

   • <item 1> ×<qty>
   • <item 2> ×<qty>
   ...

   Subtotal (pre-tax/tip): $<X>
   Tip plan: copy last order's tip (~$<Y>)

   Reply `confirm <retailer>` within 2 min to place, or `cancel` to drop it.
   ```
7. **End your turn.** Do NOT proceed to checkout. Do NOT call agent-browser. Wait for Soph's next message.

## Turn 2 — Soph's next message

Triggered when `/workspace/group/.order-pending.json` exists and Soph's incoming message starts with `confirm` or `cancel`. Handle:

- **Exact match `confirm <retailer>`** (case-insensitive, trimmed, retailer slug must match the pending file): proceed to "Checkout flow" below.
- **`cancel` / `nvm` / `nevermind` / anything else that isn't a valid confirm**: delete `.order-pending.json`, reply "Cancelled. Cart is untouched." Stop.
- **`confirm` without the retailer slug** OR **wrong retailer slug**: reply "Need `confirm <retailer>` — say `confirm <expected_token's retailer>` to place, or `cancel`." Do NOT proceed.
- **File older than 2 minutes**: delete it, reply "Confirmation window expired. Say `place order` again if you still want it." Stop.

## Checkout flow

Only reached after a valid `confirm <retailer>`. Once you start this, the order WILL be placed.

1. **Acquire lock.** Rename `.order-pending.json` → `.order-in-flight.json`. If the rename fails (race), abort with "Lock conflict — retry."
2. **Make a trace dir.** `mkdir -p /workspace/group/order-traces/$(date +%Y%m%d-%H%M%S)`. Save every screenshot + DOM snapshot here for postmortem.
3. **Capture the CLI's cart fingerprint — CRITICAL.** Run `instacart-pp-cli cart show <retailer> --json` and record:
   - `cart_id` (e.g. `13415644903`)
   - `item_count` (number of unique entries)
   - the first item's `name` (for the cross-check below)

   Soph's Instacart account has multiple cart contexts (Personal, Family, etc.). The web UI will default to whichever context Instacart picks — often NOT the one the CLI has been adding to. You MUST pin to the CLI's cart, not whatever the web defaults to.

3.5. **Validate the retailer slug — never trust Soph's English directly.** Run `instacart-pp-cli carts list --json`. Find the cart whose retailer matches Soph's word (case-insensitive). Use THAT entry's `slug` (e.g. `costco`, not `costco-business-center` or `costco-wholesale`) in all URLs below. If no cart matches OR multiple match, ask Soph which specific retailer to use — don't guess.

4. **Inject session cookies — verify the API first.** Pre-flight: run `agent-browser cookies --help` and grep for `--domain`. **If the `--domain` flag is NOT present**, ABORT with: `"Cookie injection API has drifted (agent-browser doesn't take --domain). Re-check the skill before running — do NOT fall back to opening the homepage."` Past failure: the previous fallback path navigated to `instacart.com/` which traps the bot in DOM-hunt loops.

   If `--domain` is supported, read `/home/node/.config/instacart/session.json` and for each cookie in `cookies[]`:
   ```bash
   agent-browser cookies set <name> <value> --domain <domain>
   ```

5. **Navigate using cart_id pinning, with post-nav URL verification.**

   Soph does NOT use her Family Cart. The CLI's cart_id is the authoritative target.

   For each URL below (in order), navigate AND verify before moving on:
   ```
   1. https://www.instacart.com/store/<slug>/cart        (retailer-scoped, most reliable)
   2. https://www.instacart.com/store/<slug>/storefront  (then click the in-page cart icon)
   3. https://www.instacart.com/store/checkout?cart_id=<cart_id>
   ```

   **After each navigation:**
   - `agent-browser eval "location.pathname + location.search"` → captured path MUST start with `/store/<slug>` or `/store/checkout`. If it redirects to `/login`, `/`, `/store`, or anything else → this URL FAILED, try the next.
   - Screenshot every attempt to `<trace_dir>/nav-<n>-<status>.png`

   **If all three URLs redirect**, ABORT: `"Session unauthenticated or all cart URLs redirect. NOT proceeding. Re-auth Instacart on your laptop."` Do NOT then navigate to homepage to "try something else." End the flow.

   **In-page cart-switcher (only after a URL lands on a real cart page but it's still the WRONG cart per step 6's check):** Look for a control labeled "Switch cart" / "Personal Cart" / similar and click it. **Hard counter — file-logged:**
   - Before each switch click: `lines=$(wc -l < <trace_dir>/switch-attempts.log 2>/dev/null || echo 0); test "$lines" -lt 3 || { echo "max switch attempts reached"; exit 1; }`
   - After each click: `echo "$(date -Iseconds) clicked <selector>" >> <trace_dir>/switch-attempts.log`
   - When `switch-attempts.log` has 3 lines and the cart still doesn't match → abort with Cart Mismatch (step 6).

   **DO NOT navigate to `instacart.com/` or `/store/` (no path).** Ever.

6. **Cross-check the cart — HARD GATE.** Before any checkout walk, verify the on-page cart matches the CLI.

   **Primary: cart_id parity.**
   ```bash
   agent-browser eval "document.querySelector('[data-cart-id]')?.getAttribute('data-cart-id') || (location.search.match(/cart_id=(\d+)/) || [])[1] || ''"
   ```
   - Non-empty result matches CLI's `cart_id` → **PASS**, proceed to step 7.
   - Non-empty result mismatched → **ABORT** with Cart Mismatch.
   - Empty/null → fall through to fallback check.

   **Fallback: item count + first-3-tokens match.**
   ```bash
   agent-browser eval "Array.from(document.querySelectorAll('[data-testid*=item-card], h3, h4, [class*=item-name]')).map(el => el.textContent.trim()).filter(t => t.length > 10)"
   ```
   - Returned page item count must equal CLI's `item_count` (± 0).
   - Take the CLI's first item name, split on whitespace, take the first 3 non-trivial tokens (e.g. `"Gimme Organic Seaweed Variety Pack..."` → `["Gimme", "Organic", "Seaweed"]`). ALL three must appear case-insensitive within at least one on-page item title.
   - Both must pass → **PASS**. Either fails → **ABORT**.

   **On abort:** message: `"Cart mismatch — browser shows N items (<sample title>), CLI shows M items (<sample CLI name>). Order NOT placed. Bot landed on a different cart context than the CLI tracks."` Screenshot. Delete `.order-in-flight.json`. End.

7. **Drive the checkout flow.** Only reached after the cross-check passes. Follow this exact sequence — one click per state, snapshot before each click, save screenshots `02-...`, `03-...`, etc.:

   1. **Find the "Checkout" / "Go to checkout" button.** `agent-browser snapshot -i` → grep the snapshot for a button or link whose accessible name matches `/^(go to )?checkout$/i`. Click that ref. Wait for navigation.
   2. **Delivery window screen.** Snapshot. Find slot buttons (radio/button elements whose text contains a time-range pattern like `\d+(:\d+)?\s*[ap]m` or "Today"/"Tomorrow"). Pick the FIRST one (earliest) unless Soph's original message specified a window. Click it.
   3. **Tip screen** (may be the same screen). Snapshot. If a tip is already pre-selected matching `instacart-pp-cli history list --store <retailer> --limit 1` (most recent tip), leave it. Otherwise click the option whose dollar value matches that history tip. If no history match, leave default.
   4. **Address screen / Payment screen.** Snapshot. **Do NOT click anything that modifies address or payment.** If the page presents either as a modal that must be re-confirmed, screenshot and ABORT with "Address/payment re-selection required — finish in the app. Cart preserved."
   5. **Final review.** Look for a button labeled `/^(place order|complete order|submit order|pay( now)?|confirm( order)?)$/i`. Snapshot the page first (this is the last safe state). Then click ONCE.
   6. After the click, immediately move to step 8 (wait for confirmation).

   **Step budget:** max 8 page transitions from cross-check pass to final click. If you've taken more than 8 snapshots in this step without reaching the place-order button, ABORT — something's off about the checkout flow and you shouldn't be guessing.

8. **Wait for confirmation page.** Look for text matching `Order #`, `Order confirmed`, `Thanks for your order`, or similar. Take a final screenshot.
9. **Extract ETA from page.** Scrape text matching `Estimated delivery`, `Arriving`, `Delivery in`. Note the order ID if visible.
10. **Report to Soph via `mcp__nanoclaw__send_message`:**
    ```
    Order placed.
    • <retailer> — <N> items
    • ETA: <window from page>
    • Order ID: <id if found>
    ```
11. **Schedule email cross-check.** `mcp__nanoclaw__schedule_task` to run in 90 seconds:
    - Read both gsuite accounts (`account: "default"` and `account: "personal"`): `mcp__gsuite__gmail_list_messages` with query `from:instacart.com newer_than:5m`
    - Open the most recent message, parse the ETA + total
    - If ETA from email diverges from ETA from page by >30 min, send a correction message via `mcp__nanoclaw__send_message`
    - Otherwise stay silent (don't double-message a successful order)
12. **Release lock.** Delete `.order-in-flight.json` on success or any terminal failure.

## Failure modes (checkout) — abort, preserve cart, surface to Soph

Any of these → screenshot, delete lockfiles, send a message, do NOT retry:

- **Login wall** (URL contains `/login` or page asks to sign in): "Instacart session expired mid-checkout. Re-auth on your laptop. Cart is preserved."
- **CAPTCHA or 3DS challenge**: "Checkout blocked at <CAPTCHA / 3DS>. Finish in the Instacart app — cart is ready."
- **No delivery slot available**: "No delivery slots available right now. Try the app or wait."
- **Payment declined banner**: "Payment declined. Update payment in the Instacart app and try again."
- **30s timeout on confirmation page** (clicked place-order, didn't reach confirmation): poll Gmail (`from:instacart.com newer_than:2m`) for an order confirmation. If found, report success with ETA from email. If not, report: "Uncertain whether order went through. **Check the Instacart app before retrying** — do not say 'place order' again until you've confirmed nothing was submitted."
- **Cloudflare / Datadome / anti-bot interstitial** (page contains "Just a moment", "Checking your browser", "Please wait...", "verifying you are human", or similar): "Anti-bot challenge on Instacart — finish checkout in the app. Cart is preserved." Screenshot. Do NOT retry.

## Hard rules (real-order flow)

- **NEVER skip the recap + confirmation gate.** Even if Soph sounds annoyed. Even if she said `confirm` earlier in the thread for something else. The gate is the contract.
- **NEVER retry checkout automatically.** A failed `place order` click might have actually submitted — retry = double charge.
- **NEVER modify address or payment** during checkout. If Instacart asks you to re-select either, abort.
- **NEVER place an order without an active `.order-pending.json`** that matches the incoming `confirm <retailer>` token.
- **Only one retailer per turn.** If Soph has carts at multiple retailers and says "place all my orders", do them one at a time, each with its own recap + confirm cycle.

---

# Section 4 — Dry-run mode

Triggered when Soph says: `dry-run my <retailer> order`, `test my <retailer> order`, `preview my <retailer> order`, `walk through checkout`, or similar. **No confirmation gate** — nothing can mutate Instacart's order state in this mode, so no recap-then-confirm cycle.

The whole point is to verify the auth + checkout navigation works without charging anything. Procedure:

1. Determine the retailer (same logic as Turn 1 above).
2. **Make a trace dir** at `/workspace/group/order-traces/dryrun-$(date +%Y%m%d-%H%M%S)`.
3. `instacart-pp-cli cart show <retailer> --json` → capture `cart_id`, `item_count`, first item's `name`.
3.5. **Validate retailer slug via `instacart-pp-cli carts list --json`** — use that slug, not Soph's English. Same rule as real-flow step 3.5.
4. **Inject cookies — verify API first.** Same pre-flight as real-flow step 4: run `agent-browser cookies --help`, abort if `--domain` is missing. DO NOT fall back to navigating to the homepage.
5. **Navigate using cart_id pinning, with post-nav URL verification.** Use the same URL list and the same `location.pathname` check as real-flow step 5. Same hard rules:
   - DO NOT navigate to `instacart.com/` or `/store/`.
   - All three URLs redirect → ABORT (session unauthenticated).
   - Max 3 cart-switcher clicks, logged to `<trace_dir>/switch-attempts.log`.
   - Screenshot as `01-checkout-entry.png` after the URL that lands you on a real cart page.
6. **Cart cross-check — HARD GATE.** Same as real-flow step 6 (cart_id parity first, item-name token fallback). If mismatch → ABORT with: `"Cart mismatch on dry-run — browser landed on a different cart context than the CLI (<details>). NOT previewing. The real-order flow has the same gate, so this wouldn't have placed the wrong cart either."` End.
7. **Walk through the flow but never click submit.** Follow the same sub-sequence as real-flow step 7 (find Checkout button → delivery window → tip → address/payment screens), but on reaching the final review:
   - **STOP.** Do NOT click `/^(place order|complete order|submit order|pay( now)?|confirm( order)?)$/i`.
   - Screenshot the final review screen as `99-final-review.png`.
   - Read off: item count, subtotal, taxes/fees, tip, total, delivery window.

   Step budget: max 8 page transitions before reaching final review. Over budget → abort cleanly with the partial trace.
8. Close the browser tab cleanly: `agent-browser close`.
9. **Report to Soph** via `mcp__nanoclaw__send_message`:
   ```
   Dry-run complete — no order was placed.

   • Items: <N>
   • Subtotal: $<X>
   • Tip: $<Y> (<source: history / default>)
   • Total: $<Z>
   • Delivery window: <slot text>

   Screenshots in groups/<group>/order-traces/dryrun-<ts>/
   If this looks right, say `place my <retailer> order` to do it for real.
   ```
10. Do NOT write `.order-pending.json` — dry-run is one-shot, no follow-up confirm needed.

## Dry-run hard rules

- **NEVER click submit.** If unsure whether a button is the final submit, treat it as if it is and stop.
- **NEVER swap address or payment.** Same as real checkout.
- **If you can't reach the final review** (auth wall, CAPTCHA, no slots): report the specific failure and stop. Don't pretend the dry-run "succeeded."

---

# Auth + binary failure handling (applies to all sections)

## Auth failure

If a command returns an auth error (401, "session expired", "cookies invalid"), the host's Instacart session cookie has expired. Do NOT try to re-auth from inside the container. Instead:

1. Reply to Soph: "Instacart session expired — please re-auth on your laptop before I can continue." (Host-side fix, for reference: quit Chrome then `instacart-pp-cli auth login`, or `instacart-pp-cli auth paste` with a Cookie header from DevTools; verify with `instacart-pp-cli auth status`. The config dir is a live mount, so no container rebuild is needed.)
2. Stop the order flow; do not proceed with partial information.

## Binary missing

If `instacart-pp-cli` returns "command not found" or the binary isn't at `/usr/local/bin/instacart-pp-cli`, the container was spawned without the Instacart wiring. Reply to Soph: "Instacart CLI isn't in this container — needs `./container/build.sh` and an orchestrator restart." Do NOT try to `apt install`, `go install`, or otherwise install anything.

## What lives where (inside the container)

- Binary: `/usr/local/bin/instacart-pp-cli`
- Config + history DB + session cookies: `/home/node/.config/instacart/` (read-write mount from host's `~/Library/Application Support/instacart/`)
- Both host and container share the same SQLite — host backfills, container queries and writes incremental purchase signal back.
