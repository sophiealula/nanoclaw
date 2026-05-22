---
name: pp-google-maps
description: Save a place to a Google Maps city list when Soph forwards a recommendation. Use whenever a message reads as a place rec (e.g. "Chloe rec'd Bar Tatu in Mexico City", "save Loulou in Brighton, Eden told me about it", "add the taco place in CDMX"). Drives Google Maps web UI via `agent-browser` using a pre-saved Playwright auth state. Always confirms with Soph before writing — Maps account is live external state.
allowed-tools: Bash(agent-browser:*), Bash(jq:*), Bash(cat:*), Bash(test:*), Bash(ls:*), Bash(echo:*), Bash(date:*), Bash(rm:*), Bash(mkdir:*), Read, Write, mcp__nanoclaw__send_message
---

# pp-google-maps — save places to Google Maps city lists

When Soph forwards a place recommendation, find or create the right city list on her **personal** Google account and add the place with the recommender captured as a note on the pin.

Mirrors the `pp-instacart` pattern: agent drives the live web UI via `agent-browser` (Playwright). No new CLI — `agent-browser` already supports persistent state, snapshot-driven navigation, and semantic locators.

---

# Section 1 — When this skill triggers

## Trigger patterns (be conservative)

Run this skill when an inbound message clearly reads as a place recommendation:

- `"<person> rec'd / recommended <place> [in <city>]"`
- `"save <place> [in <city>]"` / `"add <place> to my <city> list"`
- `"<person> told me about <place>"`
- A direct paste of `https://maps.app.goo.gl/...` or `https://www.google.com/maps/place/...` URL (treat as a strong rec signal — out of scope to parse the URL, ask Soph for the place name + city if not in surrounding text)

## DO NOT trigger on

- General food chat: `"I want sushi tonight"`, `"where should we eat"`, `"good ramen in Tokyo?"`
- Past tense without a save signal: `"we ate at Loulou yesterday and it was great"` (might be a rec, might just be a journal entry — ask before assuming)
- Trip planning without a specific named place

When in doubt, **don't trigger**. The confirmation gate will catch misfires, but it's better to leave a borderline message as normal chat than to interrupt with a confirm prompt.

---

# Section 2 — Extracting place + city + comment

From the message, identify three things:

1. **Place name** — the venue (e.g. `Bar Tatu`)
2. **City** — explicit (`Mexico City`) or inferable (`CDMX` → Mexico City)
3. **Comment** — the recommender + any color. Default form: `"<person> recommended this"` or echo Soph's exact phrasing if she included reasoning (e.g. `"Chloe rec'd this — said the cocktails are exceptional"`).

If the city is missing, **ask before doing anything**:

> "Which city is Bar Tatu in?"

Do NOT guess the city from the place name alone. Bar Tatu exists in Mexico City and Lisbon — the wrong list is worse than asking.

---

# Section 3 — Auth state

Soph maintains a logged-in Playwright session for her **personal** Google account.

- Container path: `/home/node/.config/google-maps/state.json` (mounted read-only)
- Host path (mounted from): `~/Library/Application Support/nanoclaw/google-maps/state.json`

## Canonical command form

Every `agent-browser` invocation in this skill MUST pass the state file via the `--state` global flag (or `AGENT_BROWSER_STATE` env var). Standalone `agent-browser state load <path>` does NOT bind the file to the next `open` — the spawned browser context will be unauthenticated and the auth check below will false-flag as "session expired."

Set this at the start of the skill run and reuse on every command:

```bash
export GMAPS_STATE=/home/node/.config/google-maps/state.json
```

Then use `agent-browser --state "$GMAPS_STATE" <subcommand>` everywhere.

## Pre-flight every run

1. **Check the state file exists.**
   ```bash
   test -f "$GMAPS_STATE" || {
     # Tell Soph and stop
     echo "Google Maps auth state missing — run the host login script before I can save places."
     exit 1
   }
   ```
2. **Open Maps with state loaded.**
   ```bash
   agent-browser --state "$GMAPS_STATE" open "https://www.google.com/maps"
   agent-browser wait --load networkidle
   ```
3. **Verify auth — URL check.**
   ```bash
   agent-browser eval "location.pathname"
   ```
   - If the URL contains `/signin`, `/accounts.google.com`, or any redirect away from `/maps` → **STOP**. Reply: `"Google Maps session expired — re-auth on your laptop before I can save the place."` Do NOT attempt to log in from inside the container.

4. **Verify auth — signed-in chrome.** Maps can load the homepage anonymously without redirecting to `/signin`, so URL alone is not enough.
   ```bash
   agent-browser eval "document.querySelector('a[aria-label*=\"Google Account\"], a[aria-label*=\"account\"]')?.getAttribute('aria-label') || ''"
   ```
   - Empty string → no account chip visible → treat as logged-out, abort with the same "session expired" message.

5. **Verify auth — correct account.** Soph has two Google accounts and the saved state must belong to the **personal** one, not `sophie@2389.ai`.
   ```bash
   agent-browser eval "document.querySelector('a[aria-label*=\"Google Account\"], a[aria-label*=\"account\"]')?.getAttribute('aria-label') || ''"
   ```
   - Returned label contains `2389.ai` or anything matching `/@2389\.ai|sophie@2389/i` → **STOP**. Reply: `"Maps is on the work account (2389.ai), not personal — switch on your laptop and re-save state."` Do NOT switch accounts from inside the container.
   - Returned label matches the personal account (gmail.com address Soph expects) → proceed.

If any pre-flight step fails, do NOT attempt to recover. End the turn with the relevant error message. Soph re-runs the host login script.

---

# Section 4 — Confirmation gate (mandatory)

**Never write to Maps without showing Soph a recap and waiting for an explicit `yes`.** This is a live external account. Soph's hard-stop rules apply.

## Recap format

After identifying place + city + comment, search Maps to verify the place exists and disambiguate. Capture the full address from the snapshot (not just the neighborhood — protects against same-name-different-location matches). Then send Soph this recap via `mcp__nanoclaw__send_message`:

```
Found <Place Name> — <full street address>.
<List status: existing list "X" OR new list "X" will be created>
Note to attach: "<comment>"

Reply `yes` to save, or `no` to drop.
```

Example:

```
Found Bar Tatu — Calle Frontera 122, Roma Norte, Ciudad de México.
Existing list: "Mexico City" (currently 47 places)
Note to attach: "Chloe recommended this"

Reply `yes` to save, or `no` to drop.
```

## Pending file (cross-turn state)

Before ending Turn 1, write the recap state to disk so Turn 2 doesn't depend on transcript memory alone:

```bash
cat > /workspace/group/.gmaps-pending.json <<EOF
{
  "created_at": "<ISO 8601 now>",
  "place_name": "<Place Name>",
  "place_url": "<canonical Maps URL>",
  "place_address": "<full address>",
  "city": "<city as Soph wrote it>",
  "list_name": "<city — same string>",
  "list_exists": true|false,
  "comment": "<note text>"
}
EOF
```

**End the turn here.** Do NOT proceed to the save click. Wait for Soph's next message.

## When Soph replies

- `yes` (or `y` / `yeah` / `go`) → read `.gmaps-pending.json`, proceed to Section 6 (Save flow), delete the pending file on success.
- `no` (or `n` / `cancel`) → delete `.gmaps-pending.json`, reply `"Dropped."` and stop.
- Anything else → treat as a clarification. If the place/city/comment changes, re-run the recap and rewrite the pending file.
- **Pending file > 10 min old** when Soph replies → expire it. Reply: `"Recap expired — send the rec again if you still want to save it."` Delete the file.

---

# Section 5 — Search + disambiguate

After auth pre-flight, search Maps:

```bash
agent-browser --state "$GMAPS_STATE" open "https://www.google.com/maps/search/<urlencoded query>"
agent-browser wait --load networkidle
agent-browser snapshot -i
```

Where `<query>` is `<place name> <city>`. Reading the snapshot:

- **One strong result** (single place card, name matches) → use it.
- **Multiple results matching place name across different cities** → ask Soph which city she meant.
- **No close matches** → reply: `"Couldn't find a '<place>' in <city> on Maps — got a different spelling or a Maps share link?"` and stop.

For the verified place, click into its page so you have a stable URL AND can read the full address:

```bash
agent-browser find text "<Place Name>" click
agent-browser wait --load networkidle
agent-browser get url   # canonical place URL → goes in .gmaps-pending.json

# Extract the full address from the place panel (used in the recap)
agent-browser eval "document.querySelector('button[data-item-id=\"address\"], [data-item-id*=\"address\"]')?.textContent?.trim() || ''"
```

If the address eval returns empty, fall back to a snapshot-and-look — the address line is typically near the top of the place panel, prefixed with a location pin icon. Don't proceed to the recap without an address — better to ask Soph "got an address or a Maps link?" than to confirm against just a name.

---

# Section 6 — Save flow

Only reached AFTER Soph replies `yes` to the recap.

## 6a — Read the pending file + re-open the place

```bash
test -f /workspace/group/.gmaps-pending.json || {
  # No pending state — Soph's "yes" doesn't refer to anything we recapped.
  # Reply: "No pending save — send the rec again."
  exit 1
}
PENDING=$(cat /workspace/group/.gmaps-pending.json)
# Parse: place_name, place_url, list_name, list_exists, comment, city
```

Re-run the pre-flight from Section 3 (state load + auth check), then re-open the place:

```bash
agent-browser --state "$GMAPS_STATE" open "<place_url from pending>"
agent-browser wait --load networkidle
```

## 6b — Find or create the city list

1. Click the **Save** action on the place page. Try the canonical selector first, then fall back to less-specific selectors since Maps A/B-tests Save button presentation:
   ```bash
   # Primary
   agent-browser find role button click --name "Save" || \
     agent-browser find label "Save" click || \
     agent-browser find text "Save" click
   agent-browser snapshot -i
   ```
   If all three fail, abort: see Section 8 row "List-picker UI doesn't appear."
2. A list-picker UI appears. Read the snapshot. List matching is **case-insensitive** when finding existing lists (avoids creating duplicate `Brighton` / `brighton`), but **exact-case as Soph wrote it** when creating new lists.
   - **Existing list (case-insensitive match)** → click it. Done with list selection.
   - **No match** → click `New list` (or `Create list` depending on UI), enter the city name as Soph wrote it (preserving `Mexico City` — do NOT auto-shorten to `CDMX`), set visibility to **Private**, click Create.

## 6c — Attach the note

After the place is saved to the list:

1. Open the saved place's note field. UI varies — look for a textarea/button matching `/note/i` (Maps labels it `Note` or `Add a note` depending on entry path).
2. Fill in the comment text exactly as recapped to Soph:
   ```bash
   agent-browser find role textbox fill "<comment>" || \
     agent-browser find label --regex "note" fill "<comment>"
   agent-browser find role button click --name "Save"
   ```

## 6d — Verify

```bash
agent-browser snapshot -i
```

Confirm the place card shows "Saved to <list name>" and the note is attached. If verification fails, see Section 8.

## 6e — Clean up pending + reply

```bash
rm -f /workspace/group/.gmaps-pending.json
```

Reply to Soph:

```
Saved <Place Name> to <list name>. Note: "<comment>"
```

Or if a new list was created:

```
Created new list <list name> and saved <Place Name>. Note: "<comment>"
```

---

# Section 7 — Hard rules

- **Confirmation is mandatory before any write.** Section 4. No exceptions.
- **No retry-loop past 2 attempts on any Maps interaction.** If a click fails twice (snapshot doesn't show the expected next state), STOP and report what you see. Do not iterate against the live UI — risks unintended saves to the wrong list.
- **Login wall = stop, don't re-auth.** Soph re-authenticates from her laptop using the host ceremony.
- **Preserve Soph's city naming.** If she wrote `Mexico City`, the list is `Mexico City`. Don't normalize, translate, or shorten.
- **Don't volunteer information about other lists.** If Soph asks about her "Mexico City" list, only report what's visible during this session. Don't speculate about list contents from prior runs.
- **Stay on personal account.** If the snapshot shows a different account active (e.g. `sophie@2389.ai`), STOP. Reply: `"Maps is on the wrong account — please switch to personal on your laptop and re-save state."` Do NOT switch accounts from inside the container.

---

# Section 8 — Failure modes

| Failure | Action |
|---|---|
| State file missing | Reply: `"Auth state missing — run the host login script."` |
| Login wall on first navigation (URL redirects to /signin) | Reply: `"Maps session expired — re-auth on your laptop."` |
| Anonymous homepage (no account chip in DOM, URL looks normal) | Treat as logged-out. Reply: `"Maps loaded anonymously — auth state likely expired. Re-auth on your laptop."` |
| Wrong account active (chip aria-label contains `2389.ai`) | Reply: `"Maps is on the work account, not personal — switch on your laptop and re-save state."` |
| CAPTCHA / "unusual activity" challenge mid-flow | Snapshot, screenshot to `/workspace/group/.gmaps-debug-$(date +%s).png`, reply: `"Maps hit a CAPTCHA challenge. Screenshot saved. Re-run the host login ceremony to refresh trust."` |
| Place not found after search | Reply: `"Couldn't find '<place>' in <city>. Spelling, or got a Maps share link?"` |
| Address eval returns empty | Reply: `"Found a place card but couldn't read the address — got a Maps share link or the full address?"` |
| List-picker UI doesn't appear after Save click (selector drift) — all three Save-button selectors failed | Snapshot, screenshot to `/workspace/group/.gmaps-debug-$(date +%s).png`, reply: `"Maps UI shifted — couldn't find the Save button. Screenshot saved. Save manually for now."` |
| Note field not found | Save the place to the list anyway (better than losing the save), then reply: `"Saved to <list>, but couldn't attach the note via UI. Note: '<comment>' — add manually if you want it on the pin."` |
| Pending file > 10 min old when Soph replies `yes` | Reply: `"Recap expired — send the rec again if you still want to save it."` Delete the pending file. |
| Soph's confirmation is unclear | Re-recap. Do not write. |

---

# Section 9 — One-time setup (Soph runs once)

The first time using this skill, run the host login script:

```bash
cd ~/projects/nanoclaw/container/skills/pp-google-maps
./scripts/login.sh
```

The script opens a headed Chromium window. Sign in to Soph's **personal** Google account, navigate around Maps until you're confident the session is solid (open a list, view a saved place), then close the window. The script saves the state to `~/Library/Application Support/nanoclaw/google-maps/state.json`.

When the session expires (Maps shows a login prompt mid-flow), re-run `./scripts/login.sh`.

---

# Section 10 — Related skills

- `agent-browser` — the underlying Playwright CLI this skill drives
- `pp-instacart` — sibling browser-driven skill with similar auth/confirmation patterns; reference for hard-rules formatting
- `taste-aware-event-scout` — also reads Soph's restaurant taste signals (separate flow, different storage — vault markdown files, not Maps lists)
