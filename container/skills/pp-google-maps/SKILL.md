---
name: pp-google-maps
description: Save a place to a Google Maps city list when Soph forwards a recommendation. Use whenever a message reads as a place rec (e.g. "Chloe rec'd Bar Tatu in Mexico City", "save Loulou in Brighton, Eden told me about it", "add the taco place in CDMX"). Drives Google Maps web UI via `agent-browser` using a pre-saved Playwright auth state. Always confirms with Soph before writing — Maps account is live external state.
allowed-tools: Bash(agent-browser:*), Bash(jq:*), Bash(cat:*), Bash(test:*), Bash(ls:*), Bash(echo:*), Read, mcp__nanoclaw__send_message
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

- Container path: `/home/node/.config/google-maps/state.json`
- Host path (mounted from): `~/Library/Application Support/nanoclaw/google-maps/state.json`

## Pre-flight every run

1. Check the state file exists:
   ```bash
   test -f /home/node/.config/google-maps/state.json || {
     # Tell Soph and stop
     echo "Google Maps auth state missing — run the host login script before I can save places."
     exit 1
   }
   ```
2. Load state into agent-browser:
   ```bash
   agent-browser state load /home/node/.config/google-maps/state.json
   ```
3. Open Maps and verify auth:
   ```bash
   agent-browser open "https://www.google.com/maps"
   agent-browser wait --load networkidle
   agent-browser eval "location.pathname"
   ```
   - If the URL contains `/signin`, `/accounts.google.com`, or the page asks Soph to sign in → **STOP**. Reply: `"Google Maps session expired — re-auth on your laptop before I can save the place."` Do NOT attempt to log in from inside the container.

---

# Section 4 — Confirmation gate (mandatory)

**Never write to Maps without showing Soph a recap and waiting for an explicit `yes`.** This is a live external account. Soph's hard-stop rules apply.

## Recap format

After identifying place + city + comment, search Maps to verify the place exists and disambiguate. Then send Soph this recap via `mcp__nanoclaw__send_message`:

```
Found <Place Name> (<neighborhood>, <city>).
<List status: existing list "X" OR new list "X" will be created>
Note to attach: "<comment>"

Reply `yes` to save, or `no` to drop.
```

Example:

```
Found Bar Tatu (Roma Norte, Ciudad de México).
Existing list: "Mexico City" (currently 47 places)
Note to attach: "Chloe recommended this"

Reply `yes` to save, or `no` to drop.
```

**End the turn here.** Do NOT proceed to the save click. Wait for Soph's next message.

## When Soph replies

- `yes` (or `y` / `yeah` / `go`) → proceed to Section 6 (Save flow).
- `no` (or `n` / `cancel`) → reply `"Dropped."` and stop.
- Anything else → treat as a clarification, re-run the recap if anything changed.

---

# Section 5 — Search + disambiguate

After auth pre-flight, search Maps:

```bash
agent-browser open "https://www.google.com/maps/search/<urlencoded query>"
agent-browser wait --load networkidle
agent-browser snapshot -i
```

Where `<query>` is `<place name> <city>`. Reading the snapshot:

- **One strong result** (single place card, name matches) → use it.
- **Multiple results matching place name across different cities** → ask Soph which city she meant.
- **No close matches** → reply: `"Couldn't find a '<place>' in <city> on Maps — got a different spelling or a Maps share link?"` and stop.

For the verified place, click into its page so you have a stable URL to return to during the save flow:

```bash
agent-browser find text "<Place Name>" click
agent-browser wait --load networkidle
agent-browser get url   # save this for later — the canonical place URL
```

---

# Section 6 — Save flow

Only reached AFTER Soph replies `yes` to the recap.

## 6a — Re-open the place page

If you navigated away during the recap turn (or this is a fresh container run with state from the pending file), reopen the place via the URL captured in Section 5.

## 6b — Find or create the city list

1. Click the **Save** action on the place page:
   ```bash
   agent-browser find role button click --name "Save"
   agent-browser snapshot -i
   ```
2. A list-picker UI appears. Read the snapshot — does a list named exactly like the city already exist?
   - **Yes** → click that list. Done with list selection.
   - **No** → click `New list` (or `Create list` depending on UI), enter the city name as Soph wrote it (preserving `Mexico City` — do NOT auto-shorten to `CDMX`), set visibility to **Private**, click Create.

## 6c — Attach the note

After the place is saved to the list:

1. Open the saved place's note field (UI varies — usually a `Add a note` link in the list-picker, or via the saved-list view).
2. Fill in the comment text exactly as recapped to Soph:
   ```bash
   agent-browser find role textbox fill "<comment>"
   agent-browser find role button click --name "Save"
   ```

## 6d — Verify

```bash
agent-browser snapshot -i
```

Confirm the place card shows "Saved to <list name>" and the note is attached. If verification fails, see Section 8.

## 6e — Reply to Soph

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
| Login wall on first navigation | Reply: `"Maps session expired — re-auth on your laptop."` |
| Wrong account active | Reply: `"Maps is on <account> not personal — switch on your laptop and re-save state."` |
| Place not found after search | Reply: `"Couldn't find '<place>' in <city>. Spelling, or got a Maps share link?"` |
| List-picker UI doesn't appear after Save click (selector drift) | Snapshot, screenshot to `/workspace/group/.gmaps-debug-<timestamp>.png`, reply: `"Maps UI shifted — couldn't find the list picker. Screenshot saved. Try saving manually for now."` |
| Note field not found | Save the place to the list anyway (better than losing the save), then reply: `"Saved to <list>, but couldn't attach the note via UI. Note: '<comment>' — add manually if you want it on the pin."` |
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
