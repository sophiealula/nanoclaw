# Costco Snack Ordering via Instacart — Design

**Date:** 2026-05-08
**Status:** Validated, ready for implementation
**Author:** Sophie (with Claude as scribe)

## Goal

Let Sophie say "order Costco snacks" in chat (main personal channel or 2389 Slack) and have NanoClaw build a cart from her Instacart Costco "Buy It Again" list, post it for review, and place the order on approval.

## Decisions (locked)

| Question | Decision |
|---|---|
| Mode | **Assisted** — agent builds cart, user approves, agent places order |
| Integration | **Browser automation (Playwright)** in the agent container — Instacart's free API only goes to "shopping list," not completed orders |
| Approval flow | **Approval-then-place** — cart summary in chat → reply "go" → order placed |
| Snack list source | **Instacart Costco "Buy It Again"** — Sophie only orders snacks from Costco, so the section *is* the snack list. No filtering. |
| Quantities | **Default to last-ordered quantity**; adjustable in approval step |
| Channels | Main personal channel + 2389 Slack channel |
| Auth | Trusted-sender gating on both trigger and approval reply |

## Architecture

### Inside the agent container
- **MCP server `instacart-mcp`** with two tools:
  - `build_costco_snack_cart()` → scrapes Buy Again, returns structured cart JSON
  - `place_costco_snack_order(cart_id)` → completes checkout, returns confirmation
- **Playwright (headless)** runs inside the container. Already present for the existing browser skill — no new infrastructure.
- **Auth:** Persistent Instacart session captured once during setup, stored as `instacart_session` credential in OneCLI alongside other secrets. Reused on every run.

### Outside the container (orchestrator)
- **Router intent:** new trigger patterns added to `src/router.ts`:
  - `/order costco snacks/i`
  - `/snack run/i`
  - `/costco snack order/i`
- **Approval loop:** uses existing IPC mechanism. Agent emits structured cart summary; NanoClaw posts to the channel that triggered it; user's reply re-enters the same agent session.
- **Why two MCP tools instead of one:** keeps the "approve then place" boundary firm — no chance the agent accidentally checks out before user said go.

## Runtime flow

1. **Trigger:** "order Costco snacks" in main channel or 2389 Slack.
2. **Container starts** with `instacart-costco` skill loaded.
3. **Agent calls `build_costco_snack_cart()`:** Playwright opens Instacart with stored session, navigates to Costco store page, opens Buy It Again, scrapes every item with name + last-ordered quantity + current price + availability flag.
4. **Agent posts cart summary back to chat:**
   ```
   Costco snack cart — review:
     • Kirkland Trail Mix (×2) — $14.99 ea
     • Cheez-Its variety pack (×1) — $19.49
     • RXBars (×1) — $24.99
     ...
   Subtotal: $XXX.XX
   Delivery + service: ~$YY.YY
   Estimated total: ~$ZZZ.ZZ
   Reply 'go' to place, or tell me what to change.
   ```
5. **User responds:**
   - `"go"` / `"yes"` / `"place it"` → step 6
   - Edit instructions (`"skip the cheez-its, double the trail mix"`) → agent updates cart in memory, re-posts summary, waits again
   - `"cancel"` / no reply for 30 min → discard cart, do nothing
6. **Agent calls `place_costco_snack_order(cart_id)`:** Playwright re-opens cart, clicks through checkout, accepts default address/tip/delivery window, hits Place Order, captures confirmation # + ETA.
7. **Confirmation:** `"Ordered. Confirmation #ABC123. ETA: today 4–5pm."`

Cart is held in container memory between build and place — no DB persistence needed, approval window is short.

## Edge cases

| Situation | Behavior |
|---|---|
| Item out of stock | Skip from cart. Note in summary: "⚠️ X unavailable today — skipped." |
| Substitution offered by Instacart | Don't auto-accept. Show original + suggested sub; user decides. |
| Price jumped >25% from last order | Flag with `⚠️ price up`. Cart still includes it; user can drop. |
| Buy Again page empty / scrape returns 0 items | Abort. Post: "Couldn't read your Buy Again list — Instacart layout may have changed. Try again or check the skill." |
| Stored session cookie expired | Abort. Post: "Instacart session expired — run `/add-instacart-costco refresh` to re-auth." |
| No reply to approval within 30 min | Discard cart. No order placed. |
| Wrong person replies "go" in Slack channel | Ignore. Only Sophie's user ID can approve. |
| `place_order` fails mid-checkout | Capture screenshot + error. Post: "Order failed at checkout step — see attached. Cart preserved; reply 'retry' to try again." |
| Default delivery slot unavailable | Use Instacart's first available; mention ETA in confirmation. |

## Auth & trust

- **Trigger gating:** Only Sophie's user ID (per channel) can fire the trigger. Other senders in 2389 Slack typing "order Costco snacks" are ignored.
- **Approval gating:** Same — only Sophie's user ID can approve a pending cart.
- **Privacy note:** Cart summary is posted in whichever channel triggered it. Triggering from 2389 Slack means coworkers can see the cart contents. Probably fine (snacks), but worth knowing.

## Implementation outline

### File structure
```
.claude/skills/add-instacart-costco/
  SKILL.md                  # install instructions + capability description
  scripts/
    apply.ts                # patches NanoClaw to register the skill
    auth-flow.ts            # one-time login: opens headed browser, captures session, stores in OneCLI
  container/
    instacart-mcp/          # MCP server, runs in container
      src/
        index.ts            # MCP entry, exposes build_costco_snack_cart + place_costco_snack_order
        scraper.ts          # Playwright: navigate Costco buy-again, extract items
        cart.ts             # in-memory cart held between build/place calls
        checkout.ts         # Playwright: complete checkout, capture confirmation
      package.json
```

### Setup flow (`/add-instacart-costco`)
1. Verify Playwright is installed in container (existing browser skill already includes it — reuse).
2. Run `auth-flow.ts` headed locally: pops a browser, user logs in to Instacart manually, script captures session cookies + storage state, hands to OneCLI to store as `instacart_session`.
3. Patch `src/router.ts` to add trigger phrases routed to this skill.
4. Write `instacart-mcp` config into the container's `.mcp.json`.
5. Add trusted-sender ID list to skill config (defaults to main-channel sender; Slack ID added during setup if Slack is registered).

### Dependencies
- Playwright (already in container)
- Nothing else net-new

### Testing
- `scraper.ts` ships with a saved sample Costco Buy Again HTML for parser unit tests.
- Smoke test: `npm run smoke:instacart` runs `build_cart` against the real account, prints cart, **does not** call `place_order`. Run before merging changes.
- No automated test for `place_order` — real money operation. Manual sanity-check after setup.

## Open questions / future work

- Scheduling (e.g., "every 2 weeks, prompt me to do a snack run") — out of scope for v1.
- Hard cap on order total — not requested; could add later if accidental large orders become a concern.
- Multi-retailer support — currently Costco-only because that's the actual use case.
