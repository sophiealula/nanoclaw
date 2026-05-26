---
name: pp-google-maps
description: Save a place to a Google Maps city list when Soph forwards a recommendation. Use whenever a message reads as a place rec (e.g. "Chloe rec'd Bar Tatu in Mexico City", "save Loulou in Brighton, Eden told me about it", "add the taco place in CDMX"). The actual save runs in Soph's real Chrome via the NanoClaw Maps Saver extension — this skill enqueues an intent and reports the outcome. Always confirms with Soph before enqueueing.
allowed-tools: Bash(agent-browser:*), Bash(jq:*), Bash(cat:*), Bash(test:*), Bash(ls:*), Bash(echo:*), Bash(date:*), Bash(rm:*), Bash(mkdir:*), Bash(sleep:*), Read, Write, mcp__nanoclaw__send_message
---

# pp-google-maps — save places to Google Maps city lists

When Soph forwards a place recommendation, find or create the right city list on her **personal** Google account and add the place with the recommender captured as a note on the pin.

**The architecture** (since 2026-05-22):
1. This skill (in-container) **searches Maps unauthenticated** to verify the place exists + capture the canonical URL/address.
2. Confirms with Soph via Telegram.
3. On `yes`, **writes a save intent to the queue dir** (`/home/node/.config/maps-queue/pending/<id>.json`) — that's the bind-mounted host path `~/Library/Application Support/nanoclaw/maps-queue/`.
4. The host's HTTP server (`src/maps-queue.ts`, port 7733) serves the intent to the **Maps Saver Chrome extension** running in Soph's real Chrome.
5. Extension opens the place URL, clicks Save, picks the list, fills the note — in Soph's **real signed-in session** — and POSTs the outcome back. The host writes the outcome to `results/<id>.json`.
6. This skill polls `/home/node/.config/maps-queue/results/<id>.json` for each item, reports per-item outcome via Telegram.

This bypasses every layer of Google's bot detection (no Playwright, no DevTools Protocol, no auth-state mounting drama) because the actual DOM clicks happen inside Soph's real Chrome.

---

# Section 1 — When this skill triggers

## DM-only gate (first check, before anything else)

This skill writes place addresses and recommender names back to the originating chat. If triggered from a group chat instead of Soph's main DM, the recap leaks personal data to anyone in that group. Refuse to run anywhere else:

```bash
[[ "${NANOCLAW_IS_MAIN:-0}" == "1" ]] || {
  # Reply (in whatever channel triggered it): "Place-save only works in my main DM, not group chats."
  exit 0
}
```

Set `NANOCLAW_IS_MAIN=1` is exported by the container runner for Soph's main DM only.

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

# Section 3 — Queue health check (replaces the old auth-state preflight)

The actual save runs in Soph's real Chrome via the **Maps Saver extension**. This skill enqueues intents and polls for outcomes. There's no auth state to manage in-container.

## Pre-flight every run

1. **Queue dir must be mounted.**
   ```bash
   test -d /home/node/.config/maps-queue/pending || {
     # Reply: "Maps queue isn't mounted — NanoClaw orchestrator may need a restart."
     exit 1
   }
   ```
2. **Tell Soph if the extension isn't loaded.** We can't directly probe the extension from the container (different network namespace), but we CAN detect a stale `pending/` (intents written and never processed). Soft signal — only mention if it's clearly a problem (e.g. when reporting a result timeout in Section 6, not in pre-flight).

That's it. No auth check, no account check, no `state.json` ceremony. The extension uses Soph's real Chrome session — whatever account she's signed into is the account that gets the save.

(Past life: this section used to do a Playwright auth check against a mounted `state.json`. That state file expired every few weeks and triggered the 5-step re-auth ceremony. Architecture switch in commit `23efc1b` removed all of that. See `chrome-extensions/maps-saver/README.md` for the new architecture.)

---

# Section 4 — Confirmation gate (mandatory)

**Never write to Maps without showing Soph a recap and waiting for an explicit `yes`.** This is a live external account. Soph's hard-stop rules apply.

## Recap format

After identifying place + city + comment, search Maps to verify the place exists and disambiguate. Capture the full address from the snapshot (not just the neighborhood — protects against same-name-different-location matches). Then send Soph a single-line recap via `mcp__nanoclaw__send_message`:

**Single place** (most common):
```
Save <Place Name> (<neighborhood>, <city>) to <list status> w/ note "<comment>"? yes/no
```

**Batch (N places to same list — handles back-to-back recs in one message):**
```
Save these N places to <list status>? yes/no
1. <Place 1 Name> (<neighborhood>) — "<note 1>"
2. <Place 2 Name> (<neighborhood>) — "<note 2>"
…
```

Where `<list status>` is either `your Mexico City list` (existing) or `a new Mexico City list` (creating). Examples:

```
Save Bar Tatu (Roma Norte, CDMX) to your Mexico City list w/ note "Chloe rec'd this"? yes/no
```

```
Save these 4 places to your San Diego list? yes/no
1. Puesto La Jolla (Wall St) — "Kari rec'd, good to walk to"
2. Georges at the Cove (Prospect St) — "Kari rec'd, outdoor bar"
3. The Cottage La Jolla (Fay Ave) — "Kari rec'd, best breakfast/lunch"
4. Pavilions (Girard Ave) — "Kari rec'd, grocery store — same as Jewel"
```

Keep it terse — Soph reads this on her phone, often mid-conversation.

## Pending file (cross-turn state) — **MANDATORY**

**Hard rule:** Before ending Turn 1, you MUST write `pending.json`. The recap-without-pending-file is a bug — Soph's `yes` will refer to nothing on disk and the saves get lost. (This bug lost the Puesto/Georges/Cottage/Pavilions batch on 2026-05-22.)

The schema is an **array of items**, even for a single place. Use `jq` to build JSON safely so embedded quotes don't break parsing.

**Minimal N=1 example** (a single place — still uses the items array):

```bash
mkdir -p /workspace/group/.private/pp-google-maps

ITEMS=$(jq -n \
  --arg n1 "Bar Tatu" --arg u1 "$URL1" --arg c1 "$CID1" --arg a1 "$ADDRESS1" --arg note1 "Chloe rec'd this" \
  '[{place_name: $n1, place_url: $u1, place_cid: $c1, place_address: $a1, note: $note1}]')

jq -n \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg city "Mexico City" \
  --arg list_name "Mexico City" \
  --argjson list_exists "false" \
  --argjson items "$ITEMS" \
  '{created_at: $created_at, city: $city, list_name: $list_name,
    list_exists: $list_exists, items: $items}' \
  > /workspace/group/.private/pp-google-maps/pending.json

# MANDATORY: verify the file actually exists before sending the recap.
test -s /workspace/group/.private/pp-google-maps/pending.json || {
  echo "ABORT: pending.json write failed; do not send the recap, do not end the turn." >&2
  exit 1
}
```

**N=4 batch example:**

```bash
mkdir -p /workspace/group/.private/pp-google-maps

# Build the items array. For each place collected in Section 5, append an object.
ITEMS=$(jq -n \
  --arg n1 "Puesto La Jolla" --arg u1 "$URL1" --arg c1 "$CID1" --arg a1 "$ADDRESS1" --arg note1 "Kari rec'd, good to walk to" \
  --arg n2 "Georges at the Cove" --arg u2 "$URL2" --arg c2 "$CID2" --arg a2 "$ADDRESS2" --arg note2 "Kari rec'd, outdoor bar" \
  --arg n3 "The Cottage La Jolla" --arg u3 "$URL3" --arg c3 "$CID3" --arg a3 "$ADDRESS3" --arg note3 "Kari rec'd, best breakfast/lunch" \
  --arg n4 "Pavilions" --arg u4 "$URL4" --arg c4 "$CID4" --arg a4 "$ADDRESS4" --arg note4 "Kari rec'd, grocery store — same as Jewel" \
  '[
    {place_name: $n1, place_url: $u1, place_cid: $c1, place_address: $a1, note: $note1},
    {place_name: $n2, place_url: $u2, place_cid: $c2, place_address: $a2, note: $note2},
    {place_name: $n3, place_url: $u3, place_cid: $c3, place_address: $a3, note: $note3},
    {place_name: $n4, place_url: $u4, place_cid: $c4, place_address: $a4, note: $note4}
  ]')

jq -n \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg city "<city as Soph wrote it>" \
  --arg list_name "<city — same string>" \
  --argjson list_exists "true" \
  --argjson items "$ITEMS" \
  '{created_at: $created_at, city: $city, list_name: $list_name,
    list_exists: $list_exists, items: $items}' \
  > /workspace/group/.private/pp-google-maps/pending.json
```

```bash
# MANDATORY (same as N=1): verify file exists before ending the turn.
test -s /workspace/group/.private/pp-google-maps/pending.json || {
  echo "ABORT: pending.json write failed; do not send the recap, do not end the turn." >&2
  exit 1
}
```

`place_cid` per item is the fallback if `place_url` 404s on Turn 2. Identity tuple `(place_name, place_address, city)` per item is the last-resort re-search fallback.

(`list_exists` is `"true"` or `"false"` for `--argjson` — both are valid JSON literals.)

Race-condition note: one pending file per group. If Soph sends a second distinct rec batch before replying `yes` to the first, the second recap overwrites the first. Acceptable for personal use — Soph can resend.

**End the turn here.** Do NOT proceed to the save click. Wait for Soph's next message.

## When Soph replies

- `yes` (or `y` / `yeah` / `go`) → read `pending.json`, proceed to Section 6 (Save flow), delete the pending file on success.
- `no` (or `n` / `cancel`) → delete `pending.json`, reply `"Dropped."` and stop.
- Anything else → treat as a clarification. If the place/city/comment changes, re-run the recap and rewrite the pending file.
- **Pending file > 60 min old** when Soph replies → expire it. Reply: `"That save request expired — send the rec again."` Delete the file. (60 min so brunch-length conversations don't time out.)

---

# Section 5 — Search + disambiguate

**Run this section ONCE per place Soph mentioned.** For a 4-place batch, loop 4 times and collect each place's data into a separate variable (or directly into the `items[]` array). Suffix the per-place vars (e.g. `URL1, CID1, ADDRESS1` for place 1; `URL2, CID2, ADDRESS2` for place 2) so they don't get overwritten as you process each.

After auth pre-flight (Section 3 — runs ONCE for the whole batch), for EACH place i in the user's message, repeat:

```bash
agent-browser open "https://www.google.com/maps/search/<urlencoded query>"
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

# Section 6 — Save flow (via the Maps Saver Chrome extension)

Only reached AFTER Soph replies `yes` to the recap.

This skill does NOT drive a browser anymore. It writes one queue intent per item to `/home/node/.config/maps-queue/pending/`, then polls `/home/node/.config/maps-queue/results/` for each item's outcome. The Maps Saver Chrome extension on Soph's host Mac picks up the intents, does the actual click-Save flow in her real Chrome, and writes outcomes back.

## 6a — Read the pending file

```bash
PENDING=/workspace/group/.private/pp-google-maps/pending.json
test -f "$PENDING" || {
  # No pending state — Soph's "yes" doesn't refer to anything we recapped.
  # Reply: "Nothing pending — send the rec again."
  exit 1
}
CITY=$(jq -r .city "$PENDING")
LIST_NAME=$(jq -r .list_name "$PENDING")
LIST_EXISTS=$(jq -r .list_exists "$PENDING")
ITEM_COUNT=$(jq '.items | length' "$PENDING")
```

## 6b — Enqueue each item

For each item in the pending file, write a single JSON file into the queue's `pending/` directory. The extension will pick them up in order (filenames are timestamp-prefixed, so chronological).

```bash
QUEUE_PENDING=/home/node/.config/maps-queue/pending
QUEUE_RESULTS=/home/node/.config/maps-queue/results
mkdir -p "$QUEUE_PENDING" "$QUEUE_RESULTS"

# Collect IDs so we can poll for them in 6c.
IDS=()
for i in $(seq 0 $((ITEM_COUNT - 1))); do
  ID="$(date +%s%N)-$i"
  IDS+=("$ID")
  jq -n \
    --arg id "$ID" \
    --arg place_name "$(jq -r ".items[$i].place_name" "$PENDING")" \
    --arg place_url  "$(jq -r ".items[$i].place_url"  "$PENDING")" \
    --arg place_address "$(jq -r ".items[$i].place_address" "$PENDING")" \
    --arg list_name "$LIST_NAME" \
    --argjson list_exists "$LIST_EXISTS" \
    --arg note "$(jq -r ".items[$i].note" "$PENDING")" \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{id: $id, place_name: $place_name, place_url: $place_url,
      place_address: $place_address, list_name: $list_name,
      list_exists: $list_exists, note: $note, created_at: $created_at}' \
    > "$QUEUE_PENDING/$ID.json.tmp"
  mv "$QUEUE_PENDING/$ID.json.tmp" "$QUEUE_PENDING/$ID.json"
done
```

Send Soph a "working on it" ack:
```
On it — pushing N saves to your real Chrome. Watching for results…
```

## 6c — Poll for each item's result

The extension processes intents serially. Per-item, expect a result within ~30 seconds (open tab → Maps loads → DOM clicks → close tab). Poll with a per-item timeout of 60 sec.

```bash
declare -A OUTCOMES   # ID -> status string
for ID in "${IDS[@]}"; do
  RESULT_PATH="$QUEUE_RESULTS/$ID.json"
  WAITED=0
  while [[ ! -f "$RESULT_PATH" && $WAITED -lt 60 ]]; do
    sleep 2
    WAITED=$((WAITED + 2))
  done
  if [[ -f "$RESULT_PATH" ]]; then
    OUTCOMES[$ID]=$(jq -r '.status' "$RESULT_PATH")
  else
    OUTCOMES[$ID]="timeout"
  fi
done
```

**Per-outcome semantics** (status values the extension writes):
- `"saved"` → ✅ landed cleanly.
- `"already-saved"` → ⏭ idempotency skip. Place was already on some list (maybe same, maybe different).
- `"partial"` → ⚠️ save committed but note didn't attach (or list selection landed weird). Treat as success but flag.
- `"error"` → ❌ something broke. Result file includes `reason` (e.g. "save-button-not-found", "list-picker-dialog-not-found").
- `"timeout"` → ❌ extension didn't process it within 60s. Most likely cause: extension isn't installed, Chrome isn't running, or NanoClaw queue server isn't reachable.

## 6d — Clean up + report

After polling, remove the local pending file (the recap is consumed). Leave the queue's `results/` files in place — the host doesn't auto-prune them, and they're useful evidence if things go wrong.

```bash
rm -f /workspace/group/.private/pp-google-maps/pending.json
```

**Single-item reply** (ITEM_COUNT=1):

| outcome | reply |
|---|---|
| `saved` (existing list) | `Saved <name> to <list>. Note: "<comment>"` |
| `saved` (new list created — best-effort signal from result file's `list_created: true`) | `Created new list <list> and saved <name>. Note: "<comment>"` |
| `already-saved` | `<name> was already on a list — left it where it was.` |
| `partial` | `Saved <name> to <list>, but couldn't attach the note via UI. Add "<comment>" manually if you want it on the pin.` |
| `error` | `Couldn't save <name> — <reason>. Try again, or check chrome://extensions/ to make sure Maps Saver is loaded.` |
| `timeout` | `Maps Saver didn't pick up the save in 60s. Is your Chrome running with the extension installed?` |

**Batch reply (ITEM_COUNT > 1):** report each item's outcome in order with the right emoji.

```
Saved <N>/<TOTAL> to <list name>:
✅ Puesto La Jolla — "Kari rec'd, good to walk to"
✅ Georges at the Cove — "Kari rec'd, outdoor bar"
⏭ The Cottage La Jolla — already on a list
❌ Pavilions — error: save-button-not-found
```

If the batch was fully successful (all ✅), shorten:

```
Saved all 4 to your San Diego list ✓
```

If everything timed out (extension not running):

```
None of the saves landed — Maps Saver extension isn't picking up the queue.
Check Chrome is running on your Mac with the extension loaded
(chrome://extensions/ → look for "NanoClaw Maps Saver" enabled).
I'll keep the intents in the queue; they'll fire as soon as it's reachable.
```

(In the all-fail case, do NOT delete the queued intents — they auto-recover when the extension comes back.)

---

# Section 7 — Hard rules

- **Confirmation is mandatory before any enqueue.** Section 4. No exceptions.
- **No retry-loop on queue results.** If an item comes back as `error` or `timeout`, STOP — do NOT re-enqueue. Tell Soph what happened and let her decide. Auto-retry risks duplicate saves if the first one actually landed despite the error response.
- **The queue is on disk; the extension is the only consumer.** Don't put extension-side concerns (DOM selectors, auth checks) in this skill. Those live in `chrome-extensions/maps-saver/content-script.js`. If the save DOM changes, that's where to patch.
- **Wrong-account safety lives on the extension side.** This skill doesn't know which Google account Soph is signed into in her Chrome. If she signs into a different account, the saves will go to that account's lists. The extension's popup shows the active account if she clicks it.
- **The Chrome extension is the only place Maps DOM is driven.** If you find yourself reaching for `agent-browser` to click Maps UI in this skill, stop — that's the bug class we just fixed.

---

# Section 8 — Failure modes

| Failure | Action |
|---|---|
| Queue dir not mounted (Section 3 pre-flight) | Reply: `"Maps queue not mounted — NanoClaw orchestrator may need a restart."` Don't proceed. |
| Extension result is `timeout` (no result file after 60s) | Reply: `"Maps Saver extension didn't pick up the save. Check chrome://extensions/ that NanoClaw Maps Saver is loaded + Chrome is running."` Don't re-enqueue (it'll fire whenever the extension comes back). |
| Extension result is `error` with `reason: "save-button-not-found"` or similar DOM-drift | Reply: `"Maps UI looks different than the extension expected (<reason>). The save didn't land. Try again in a few minutes — Google A/B-tests Maps often."` |
| Place not found after search | Reply: `"Couldn't find '<place>' in <city>. Different spelling, or got a Maps share link?"` |
| List-picker UI doesn't appear after Save click (Maps DOM drift) | Reply: `"Maps UI shifted — couldn't find the list picker. Save it manually for now."` |
| Note field not found inside save dialog | Save to list anyway (better than losing the save), then reply: `"Saved to <list>, but couldn't attach the note. Add '<comment>' manually if you want it on the pin."` |
| Re-opened place address doesn't match the recap address (Section 6a) | Reply: `"The place I re-opened doesn't match what I showed you. Not saving. Send the rec again."` Delete the pending file. |
| Place already saved to a list (Section 6b idempotency check) — SINGLE-item flow | Reply: `"Already on your <list-name> list."` Delete the pending file. Short-circuit. |
| Place already saved to a list — BATCH flow (TOTAL>1) | Record as ⏭ in the batch summary (Section 6e). `continue` to the next item. Do NOT delete the pending file mid-loop. Do NOT abort the batch. |
| Mid-batch item failure (Section 6b/6c/6d throws after some items have saved) | Break the loop. Build the batch summary (Section 6e) listing ✅ for completed items, ❌ for the failing item with its reason, and ❌ for the remaining unprocessed items. Keep the pending file on disk so Soph can retry the remainder by replying `yes` again — but tell her so explicitly: `"Saved <N>/<TOTAL>. Reply yes to retry the rest, or no to drop."` |
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
