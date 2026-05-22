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

Before ending Turn 1, write the recap state to disk so Turn 2 doesn't depend on transcript memory alone. **Use `jq` to build the JSON safely** — heredoc interpolation breaks if any field contains a quote or newline (e.g. comment like `Chloe said "amazing"`):

```bash
jq -n \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg place_name "<Place Name>" \
  --arg place_url "$URL" \
  --arg place_cid "$CID" \
  --arg place_address "$ADDRESS" \
  --arg city "<city as Soph wrote it>" \
  --arg list_name "<city — same string>" \
  --argjson list_exists "true" \
  --arg comment "<note text>" \
  '{created_at: $created_at, place_name: $place_name, place_url: $place_url,
    place_cid: $place_cid, place_address: $place_address, city: $city,
    list_name: $list_name, list_exists: $list_exists, comment: $comment}' \
  > /workspace/group/.gmaps-pending.json
```

`place_cid` is the canonical fallback if `place_url` 404s on Turn 2. Identity tuple `(place_name, place_address, city)` is the last-resort fallback for re-search.

(`list_exists` is `"true"` or `"false"` for `--argjson` — both are valid JSON literals.)

Race-condition note: there's one pending file per group. If Soph sends a second distinct rec before replying `yes` to the first, the second recap overwrites the first. Section 4's clarification rule handles same-place tweaks; for back-to-back distinct recs, the second recap silently invalidates the first. This is acceptable for personal use — the recap itself is ephemeral and Soph can resend.

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

# Capture URL + the canonical place CID (stable across sessions).
# Maps URLs can drift between Turn 1 (recap) and Turn 2 (save) because the
# !4m/!3m viewport segments are session-bound. The !1s0x[hex]:0x[hex] CID
# segment IS the place identity and survives. Store both — Turn 2 falls
# back to re-searching by name+address+city if the URL 404s.
URL=$(agent-browser get url)
CID=$(echo "$URL" | grep -oE '!1s0x[0-9a-f]+:0x[0-9a-f]+' | head -1)

# Extract the full address from the place panel (used in the recap)
ADDRESS=$(agent-browser eval "document.querySelector('button[data-item-id=\"address\"], [data-item-id*=\"address\"]')?.textContent?.trim() || ''")
```

If `$ADDRESS` is empty, fall back to a snapshot-and-look — the address line is typically near the top of the place panel, prefixed with a location pin icon. Don't proceed to the recap without an address — better to ask Soph "got an address or a Maps link?" than to confirm against just a name.

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
PLACE_URL=$(jq -r .place_url /workspace/group/.gmaps-pending.json)
PLACE_CID=$(jq -r .place_cid /workspace/group/.gmaps-pending.json)
PLACE_NAME=$(jq -r .place_name /workspace/group/.gmaps-pending.json)
PLACE_ADDRESS=$(jq -r .place_address /workspace/group/.gmaps-pending.json)
CITY=$(jq -r .city /workspace/group/.gmaps-pending.json)
LIST_NAME=$(jq -r .list_name /workspace/group/.gmaps-pending.json)
COMMENT=$(jq -r .comment /workspace/group/.gmaps-pending.json)
```

Re-run the pre-flight from Section 3 (state load + auth check), then re-open the place with fallback. The original URL is the fast path; CID and name-search are progressively-more-resilient fallbacks for the case where Maps' session-bound URL segments have rotated:

```bash
# Fast path: original URL
agent-browser --state "$GMAPS_STATE" open "$PLACE_URL"
agent-browser wait --load networkidle

# Verify we landed on a place panel (not a search results list / homepage)
LANDED_NAME=$(agent-browser eval "document.querySelector('main h1, h1[role=\"heading\"]')?.textContent?.trim() || ''")
if [[ -z "$LANDED_NAME" || "$LANDED_NAME" != *"$PLACE_NAME"* ]]; then
  # Fallback 1: re-search by name + city
  Q=$(jq -rn --arg n "$PLACE_NAME" --arg c "$CITY" '"\($n) \($c)"|@uri')
  agent-browser --state "$GMAPS_STATE" open "https://www.google.com/maps/search/$Q"
  agent-browser wait --load networkidle
  agent-browser find text "$PLACE_NAME" click
  agent-browser wait --load networkidle

  # Verify the address matches what we recapped — if not, ABORT (we'd be
  # saving the wrong place). Per Section 7 hard rules.
  LANDED_ADDR=$(agent-browser eval "document.querySelector('button[data-item-id=\"address\"]')?.textContent?.trim() || ''")
  if [[ "$LANDED_ADDR" != "$PLACE_ADDRESS" ]]; then
    # Reply: "The place I just re-opened doesn't match the address I showed
    # you in the recap. Not saving. Send the rec again — Maps may have
    # rotated the link or moved the place."
    rm -f /workspace/group/.gmaps-pending.json
    exit 1
  fi
fi
```

## 6b — Find or create the city list

1. **Idempotency check first.** When a place is ALREADY saved to any of Soph's lists, Maps renders the same action slot as a "Saved" button with `aria-pressed="true"`. Clicking it WOULD UNSAVE the place from its current list — destructive. Read the button state before clicking:
   ```bash
   SAVE_STATE=$(agent-browser eval "
     const b = document.querySelector('[data-tooltip=\"Save\"], button[aria-label*=\"Save\"], button[aria-label*=\"Saved\"]');
     if (!b) return 'missing';
     if (b.getAttribute('aria-pressed') === 'true') return 'saved';
     const label = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
     if (label.startsWith('saved') || label.includes('remove from')) return 'saved';
     return 'unsaved';
   ")
   ```
   - `saved` → place is already on a list. Read which list (open the saved-indicator tooltip / snapshot) and reply: `"Already on your <list-name> list — nothing to do."` Delete the pending file. STOP.
   - `missing` → see Section 8 row "List-picker UI doesn't appear."
   - `unsaved` → proceed to the click below.

2. **Click Save.** Single selector — if Maps drifts, fail loudly via Section 8 rather than cascading and risking the wrong click:
   ```bash
   agent-browser find role button click --name "Save"
   agent-browser snapshot -i
   ```
   If the snapshot still shows the place page with no list-picker dialog, abort: see Section 8.
3. **Pick the list inside the dialog.** Maps renders the list-picker as a `role=dialog` (label `"Save in your lists"`) containing one `role=menuitemcheckbox` per existing list. Each menuitem's accessible name combines list title + place count (e.g. `"Mexico City, 47 places"`). Wait for the dialog before reading:
   ```bash
   agent-browser wait --selector '[role="dialog"]' || \
     agent-browser wait --text "Save in your lists"
   agent-browser snapshot -i
   ```
   List matching is **case-insensitive** when finding existing lists (avoids creating duplicate `Brighton` / `brighton`), but **exact-case as Soph wrote it** when creating new lists.
   - **Existing list match** → `agent-browser find role menuitemcheckbox click --name "<city>"`. Substring-match means `"Mexico City"` would also match `"Mexico City - Roma"`; if multiple match, prefer the shorter list name.
   - **No match** → click `New list` (the primary button at the bottom of the dialog), enter the city name as Soph wrote it (preserving `Mexico City` — do NOT auto-shorten to `CDMX`), click Create. (Privacy default is Private since 2023, no explicit toggle needed.)

## 6c — Attach the note (still inside the same dialog)

Important: in current Maps (since ~2024), the note textarea lives **inside the same `role=dialog` opened by step 6b**, expanded after selecting the list. It is NOT on the saved-list view, NOT on the place card, and NOT a separate modal. Do NOT dismiss the dialog before attaching the note — dismissing it commits the save without the note.

After clicking the list (step 6b.3):

1. The dialog expands to show a `textarea` with placeholder `"Add a note"`. Fill it:
   ```bash
   agent-browser find role textbox fill "$COMMENT"
   ```
2. Close the dialog to commit. Maps auto-saves note + list selection on close — no separate Save button to click (any Save button inside the dialog is for the list selection, not the note, and clicking it after the textbox fill is a no-op):
   ```bash
   agent-browser find role button click --name "Done" || \
     agent-browser keyboard press Escape
   ```
3. Wait for the dialog to dismiss before verifying:
   ```bash
   agent-browser wait --no-selector '[role="dialog"]'
   ```

## 6d — Verify

The same Save button you read in 6b's idempotency check should now report `aria-pressed="true"` and its accessible label should change to `"Saved"`:

```bash
SAVE_STATE=$(agent-browser eval "
  const b = document.querySelector('button[aria-label*=\"Saved\"], [aria-pressed=\"true\"][data-tooltip=\"Save\"]');
  return b ? (b.getAttribute('aria-label') || 'saved') : 'unsaved';
")
```

If `$SAVE_STATE` is still `unsaved`, the dialog committed without binding to a list — see Section 8 row "List-picker UI doesn't appear" (the save didn't actually land).

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
| Re-opened place address doesn't match the recap address (Section 6a) | Reply: `"The place I just re-opened doesn't match what I showed you. Not saving. Send the rec again — Maps may have rotated the link."` Delete the pending file. |
| Place already saved to a list (Section 6b idempotency check) | Reply: `"Already on your <list-name> list — nothing to do."` Delete the pending file. NOT a failure — short-circuit the flow. |
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
