# pp-google-maps — save places to Google Maps lists from Telegram

Designed via brainstorming session 2026-05-22. Branch: `feat/pp-google-maps`.

## Problem

When someone recs a restaurant or spot ("Chloe rec'd Bar Tatu in Mexico City"), Soph wants to text NanoClaw and have it land on the right Google Maps list — one list per city — with the recommender captured as a note on the saved pin.

## UX

Trigger: natural-language detection on inbound Telegram messages (no command prefix). Conservative — only fires when the message clearly reads as a place rec.

Three states:

1. **Happy path** — message has a recognizable place + city, list already exists. Agent confirms, then writes.
   - "Found *Bar Tatu* (Roma Norte, CDMX). Add to your **Mexico City** list with note _'Chloe recommended this'_? — yes/no"

2. **New city** — list doesn't exist yet. Agent confirms creation + add in one prompt.
   - "Found *Loulou* (Brighton, UK). No **Brighton** list yet — create it and add Loulou with note _'Eden told me about it'_? — yes/no"

3. **Ambiguous** — multiple matches, missing city, or no clear match. Agent asks back before doing anything.
   - "Two Bar Tatus on Maps — one in Mexico City, one in Lisbon. Which?"

Always confirm before any write. No fire-and-forget.

## Architecture

Follows the `pp-instacart` pattern: SKILL.md only, no new binary.

- **Skill**: `container/skills/pp-google-maps/SKILL.md`
- **Browser**: existing `agent-browser` CLI (Playwright)
- **Account**: Sophie's personal Google account
- **Session persistence**: `agent-browser state save/load`, state file at `~/Library/Application Support/nanoclaw/google-maps/state.json` on host, mounted into container at `/home/node/.config/google-maps/state.json`
- **Routing**: unchanged — Telegram → NanoClaw → container agent → new skill in its toolkit

### Why no new CLI

Google Maps has no public API for managing user-owned lists. Existing `agent-browser` already supports everything needed: navigate, snapshot, click, type, state load, eval. The skill is pure instructions — the agent uses `agent-browser` as it would for any web automation.

## Auth ceremony

One-time, headed, on the host (not in container). User runs a host-side script that:

1. Opens Chromium with persistent context at the state-file path
2. Loads `https://www.google.com/maps`
3. User signs in manually (real human, real keystrokes — Google flags pure-automated logins)
4. Script waits until URL stabilizes on a logged-in Maps page
5. Saves state to the configured path

Re-auth needed when Google rotates the session. The skill detects this (login wall on first navigation) and tells Soph to re-run the ceremony from her laptop.

## Detection rules (in SKILL.md)

Conservative pattern matching by the in-container Claude. Triggers when message contains:

- "X recommended/rec'd Y" or "Y was recommended by X"
- "save this place" / "save Y" + a name
- "add Y to my [city] list"
- A direct Google Maps share URL (later — out of scope for v1, see future work)

Does NOT trigger on general food chat ("I want sushi tonight", "where should we eat") — those route to normal chat.

False-positive safety: the confirm-step catches misfires. If Soph says "no", agent drops the action and continues normal chat.

## Place + city resolution

1. Agent extracts candidate name + city from message
2. Opens Maps with a search URL: `https://www.google.com/maps/search/<name>+<city>`
3. Reads top result(s) via snapshot
4. If exactly one strong match → use it
5. If multiple matches with similar names but different cities → ask
6. If no match → ask Soph for a Maps share link or correction

## List lookup + create

1. Navigate to the Maps saved-lists view
2. Snapshot the lists; case-insensitive match on city name
3. If found → record list reference, proceed to add
4. If not → create flow via "New list" UI, name = city as Soph wrote it (preserving "Mexico City" not auto-changing to "CDMX")

## Add + note

1. From the place page, click the Save button
2. Choose the target list
3. Open the saved pin, add the note text Soph wants (the comment the agent already extracted, e.g. "Chloe recommended this")
4. Verify the save by re-snapshotting

## Hard rules

- **No write without confirmation.** Maps account is a live external system — Soph's hard-stop rules apply. Read-back with exact target before any save/create.
- **No retry-loops on failure.** Cap at 2 attempts per Maps interaction; on failure, report state and stop.
- **Login wall = stop.** Don't try to re-auth from inside the container. Tell Soph to re-run the host ceremony.
- **Detection stays conservative.** Better to miss a rec than to confirm-prompt during regular chat.

## Out of scope (v1)

- Parsing inbound Maps share URLs (could be a v2 fast-path)
- Bulk imports
- Editing existing saved-place notes
- Removing places from lists
- Slack/WhatsApp/Discord triggers (Telegram-first; flow generalizes later)
- Suggesting which list to add to when the city is ambiguous (just ask)

## Verification plan

End-to-end verification can't be unattended — requires Soph's personal Google credentials. Steps Soph runs after the code lands:

1. Run the auth ceremony script on her laptop, sign in
2. Test from Telegram: send a clear rec with a known city
3. Verify Maps app on phone shows the new entry on the right list with the note
4. Test edge cases: new city (no list yet), ambiguous place name, general chat (should NOT trigger)

If any step fails, iterate on SKILL.md detection rules or the auth-state persistence path.
