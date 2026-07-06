---
name: add-snack-bot
description: Slack-driven Instacart Costco snack ordering bot. Adds items, builds a cart, stops at checkout, and places the order on your *okay*. Standalone service alongside NanoClaw — uses its own Slack app + Instacart session. Triggers on "add snack bot", "instacart bot", "costco bot".
---

# Add Snack Bot

A standalone Slack bot that orders Costco snacks via Instacart on your behalf. Listens in a dedicated Slack channel for "order costco snacks" or "add X, Y" messages, builds a cart via Playwright browser automation, stops one click before Place Order, and waits for your *okay* before charging the card on file.

**Architecture note:** This is **not** a NanoClaw channel integration. It's a separate process with its own Slack app token and Instacart browser session — it doesn't go through the agent SDK or NanoClaw's per-message containers. Two reasons: (a) the bot's flow is stateful across messages (cart survives between trigger and approval) and Playwright's browser context can't be serialized across container spawns; (b) it lives on a single dedicated channel, so the request/response container model isn't a fit. Packaging it as a launchd-managed service alongside NanoClaw keeps lifecycle clean without forcing a square peg into a round hole.

**This is an operational skill** — code stays in `scripts/`, no edits to `src/` or `container/`. Setup is one-time.

---

## Phase 1: Pre-flight checks

Run these first. Stop if any fail.

```bash
test -f /Users/sophiedavis/projects/nanoclaw/.claude/skills/add-snack-bot/scripts/snack-bot.ts || echo "snack-bot.ts missing"
test -d ~/.instacart-mcp || mkdir -p ~/.instacart-mcp
test -f ~/.instacart-mcp/.env && grep -q "SLACK_BOT_TOKEN" ~/.instacart-mcp/.env && echo "env: ok" || echo "env: need slack token (see Phase 3)"
test -d ~/.instacart-mcp/profile && echo "instacart profile: ok" || echo "instacart profile: need to capture (see Phase 2)"
which npx >/dev/null && echo "npx: ok" || echo "npx: install Node.js first"
```

---

## Phase 2: Capture Instacart session

Skip if `~/.instacart-mcp/profile/` already exists and the user wants to keep their current account.

```bash
cd /Users/sophiedavis/projects/nanoclaw
npx playwright install chromium  # if not already installed
npx tsx .claude/skills/add-snack-bot/scripts/instacart-auth.ts
```

A Chromium window opens at instacart.com. User logs in (email or SMS), closes the window when done. Profile saves to `~/.instacart-mcp/profile/`.

After: confirm which account got captured —

```bash
npx tsx .claude/skills/add-snack-bot/scripts/instacart-whoami.ts
```

This dumps the logged-in email + account name. Flag to the user if it's not the account they intended (work vs personal). Real-money orders are placed against whatever payment method is on file for that account.

---

## Phase 3: Set up the dedicated Slack app

The bot is its own Slack app, separate from NanoClaw's. Walk the user through:

1. Open https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name: `Snack Bot` (or anything), pick the workspace
3. Sidebar → **OAuth & Permissions** → Scopes → **Bot Token Scopes** → add all of:
   - `chat:write`
   - `channels:history`
   - `files:write`
   - `reactions:write`
4. Click **Install to Workspace** → approve → copy the `xoxb-...` Bot User OAuth Token
5. In Slack: create a private channel (e.g. `#snax`) → invite the bot via `/invite @SnackBot`
6. Get the channel ID: click the channel name → bottom of the popup → copy **Channel ID** (starts with `C...`)
7. Get the user's Slack user ID and the bot's Slack user ID — easiest via the Slack API (the setup.sh script does this for you given the channel ID).

Then populate `~/.instacart-mcp/.env`:

```ini
SLACK_BOT_TOKEN=xoxb-...
SLACK_DM_CHANNEL_ID=C...        # the snack-bot channel (env name kept for backward compat)
SLACK_OWNER_USER_ID=U...        # the user's Slack ID
SLACK_BOT_USER_ID=U...          # the snack-bot's Slack ID
```

Use `chmod 600 ~/.instacart-mcp/.env`.

---

## Phase 4: Install + start the service

Run the setup helper (verifies env, installs Playwright if missing, optionally registers the launchd service):

```bash
cd /Users/sophiedavis/projects/nanoclaw
bash .claude/skills/add-snack-bot/setup.sh
```

To run under launchd (auto-restart, survives reboots):

```bash
# Render the plist (substitutes $HOME + project path) and install
sed "s|__HOME__|$HOME|g; s|__PROJECT__|/Users/sophiedavis/projects/nanoclaw|g" \
  .claude/skills/add-snack-bot/com.snackbot.plist.template \
  > ~/Library/LaunchAgents/com.snackbot.plist
launchctl load ~/Library/LaunchAgents/com.snackbot.plist
```

Manual run (no auto-restart):

```bash
nohup npx tsx .claude/skills/add-snack-bot/scripts/snack-bot.ts > /tmp/snack-bot.log 2>&1 &
```

---

## Phase 5: Verify

```bash
ps aux | grep "tsx .claude/skills/add-snack-bot/scripts/snack-bot.ts" | grep -v grep
tail -3 /tmp/snack-bot.log
```

Expect a "Snack bot online" message in `#snax` and the process visible in `ps`.

Then in Slack:
- Post `help` in the channel → bot replies with the command list
- Post `add 1 pirate bootie` → bot scrapes Buy Again, posts the matched item + total, asks for *okay*
- Reply `okay` → bot places the order, returns `✓ Ordered. Confirmation: <id>`

---

## Commands reference

| Command | Effect |
|---|---|
| `order costco snacks` | Bulk reorder your full Buy Again list |
| `add pirate bootie, 2 green teas, cheez-its` | Build a cart with just those items (quantities supported) |
| `okay` | Place the proposed cart |
| `cancel` | Abort the in-flight run |
| `cart` / `status` | Show what's pending |
| `help` | Command list |

Natural-language variants are recognized via an LLM fallback (e.g. "let's do it", "scrap it", "what's in my cart?").

---

## Safety mechanisms (live in the script)

- **$400 hard spend cap** — bot aborts before Place Order if checkout subtotal exceeds this
- **Owner-only writes** — only `SLACK_OWNER_USER_ID` can trigger / approve. Colleagues in the channel are silently ignored on owner-only commands.
- **10-min approval timeout** — pending `AWAITING_OKAY` carts auto-cancel
- **5-min post-placement cooldown** — prevents accidental double-orders
- **Ambiguous matches skipped** — silently rather than guessed
- **Semantic LLM matches require ≥0.75 confidence** — wrong-item bets cost real money
- **3-state result** — `CONFIRMED` (verified `/orders/{id}` redirect + heading) / `LIKELY` (clicked but uncertain — surfaces evidence, doesn't claim success) / `UNCONFIRMED` (failed). The string `Ordered.` only appears on `CONFIRMED`.

---

## Removal

```bash
launchctl unload ~/Library/LaunchAgents/com.snackbot.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.snackbot.plist
pkill -f "tsx .claude/skills/add-snack-bot/scripts/snack-bot.ts"
# Optionally:
# rm -rf .claude/skills/add-snack-bot   # remove the skill
# rm -rf ~/.instacart-mcp                # remove the captured session + credentials
```

---

## Files in this skill

```
.claude/skills/add-snack-bot/
  SKILL.md                                 — this file
  setup.sh                                  — env check + Playwright install
  com.snackbot.plist.template               — launchd plist (macOS)
  scripts/
    snack-bot.ts                            — the bot (main file, ~49KB)
    instacart-auth.ts                       — one-time Instacart login
    instacart-whoami.ts                     — diagnostic: which Instacart account is logged in
    instacart-snack-cart.ts                 — diagnostic: standalone Buy Again scraper
    inspect-cart.ts / inspect-buy-again.ts  — debug helpers for selector hunting
```
