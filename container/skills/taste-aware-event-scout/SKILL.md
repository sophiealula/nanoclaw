---
name: taste-aware-event-scout
description: Plan taste-aligned music/nightlife/event/food recommendations for Sophie using her documented taste profile + calendar conflict-checking. Triggers — but is not limited to — phrases like "anyone playing in [city]", "what's on tonight", "what's worth doing in [city]", "shows in [city] [dates]", "plan my [city] trip", "selector-led", "no-phone dancefloor", "record bar", "label nights", "where can I dance", "where should I eat in [city]", "dinner recs", "wine bar / listening bar", "weekend plans", "birthday plans", "going to [city]", "I'm in [city]". Also triggers on questions about Rhythm Section / Test Pressing / CQQL / NTS shows, or any "found a place that does X" sort of taste-extension question. Reads her taste docs, scrapes venue listings, filters/ranks by taste alignment, and replies with picks + sources + flagged calendar conflicts. The load-bearing rule: a celebrated DJ in the wrong room is a HARD pass — applies to food too (right cuisine in the wrong room).
---

# Taste-Aware Event Scout

Sophie maintains a structured taste profile. She has strong, articulated preferences about *rooms* over lineups, *curators* over headliners, *lineage* over trends. Generic "best of" recommendations will fail. This skill reads her actual taste docs, looks up her trip dates in her vault, cross-references her calendar for conflicts, and scrapes venues to produce taste-aligned recommendations with sources.

**Hard rule on trip dates:** When Soph references "my trip to X" / "going to Y next month" / similar, get the dates from `/workspace/extra/vault/Reference/Trips.md` — NOT from Google Calendar. Calendar is for checking *conflicts* during a known date window, not for discovering when a trip is. If Trips.md doesn't have the trip, ask Soph for the dates directly. Don't fish through Calendar to figure them out.

## Load-bearing rule

**A celebrated DJ in the wrong room is a HARD pass.** The room matters at least as much as the lineup. Always identify the room before recommending.

## Workflow

### 1. Read the taste profile first (always)

Read every `.md` file in `/workspace/extra/taste-profile/`:
- `taste.md` — synthesis / thesis
- `music-events.md` — clusters, venues, NTS shows, principles. **Also the canonical venue list** — don't hardcode venues here.
- `restaurants.md` — food/room principles (if relevant)
- `additions.md` — recent unpromoted captures (treat these as fresh signal — equal weight to canonical files for recommendations)

Even if her taste came up earlier in this conversation, re-read these files. The files are the source of truth; memory isn't.

### 1b. Determine trip dates (DO NOT search Gmail unless necessary)

For any trip-scouting question:

1. **First check the message itself** — if Soph said "Montreal June 5-10", use those dates and skip the rest of this step.
2. **Then read `/workspace/extra/vault/Reference/Trips.md`** — this is the daily-auto-populated trip index. If the destination is in there, use those dates. ~5ms.
3. **Last resort: Gmail search.** Only if (1) and (2) come up empty. Limit to a single targeted query (e.g., `from:airline_domain subject:<city>`), 1 attempt. If that fails, ask Soph for the dates directly — do NOT loop on Gmail searches.

This file is the index. Don't scan Gmail every query — that's a 60s+ operation that turns "any shows in Montreal" into a 15-minute wait.

### 2. Check Google Calendar for conflicts during the known date window

**Only after step 1b has resolved the date range.** Use Google Calendar tools across both her accounts to flag overlap:

- Hard conflicts (committed events at the same time)
- Soft conflicts (location mismatches — e.g., NYC trip with a Chicago appointment that week)
- Public-calendar imports showing as "her events" but actually venue calendars (ignore these)

**Timezone:** when scouting a different city, query in that city's timezone. Events display in their local time; conflicts need to be reconciled against where she'll actually be.

**Do NOT use Calendar to *find* trip dates.** Trip dates come from Trips.md (step 1b) or her message — Calendar is conflict-only.

### 3. Scope check: trip vs. tonight

- **Trip / future date range:** structured lineups likely published — scrape RA, Songkick, venue calendars.
- **In a city now / tonight:** lineups may not be public — check venue IGs (DJs often post day-of), aggregator radio sites, ask which spots she has in mind.

**Verify the date range is in the future.** Stale listings surface in web results — don't recommend an event that already happened.

### 4. Scrape venue listings

Hit multiple sources in parallel. Don't trust a single source.

**HARD CAPS (added after a 15-minute Montreal run):**
- **Max 3 parallel subagent dispatches.** Don't dispatch a 4th. If you need more sources, run them sequentially in the main agent's WebFetch loop.
- **Per-subagent ceiling: 90 seconds.** If a subagent hasn't reported back in 90s, treat it as failed; do NOT keep waiting. Continue with what you have.
- **Total skill ceiling: 4 minutes.** If you're past 4 min total without a final answer, send Soph what you have so far with a "still searching the long-tail venues" note. Don't silently keep working.
- **Never recursive-dispatch.** A subagent must not spawn another subagent. The main agent is the only orchestrator.

**Aggregators (best first stop):**
- `19hz.info/eventlisting_<CITY>.php` — electronic music listings (US cities)
- `ra.co/events/us/<city>` and `ra.co/events/<country>/<city>` — Resident Advisor globally
- `do312.com` (Chicago), `donyc.com` (NYC) — city aggregators

**Venues:** the canonical venue list lives in `/workspace/extra/taste-profile/music-events.md` — read from there.

**Routing tip — venue site fetches often 403/404 from bots.** When that happens, the real fallback chain (NOT more RA URLs — RA itself 403s the same way) is:
1. Songkick venue page (`songkick.com/venues/<id>`)
2. Bandsintown venue page
3. Venue Instagram (especially for international + smaller-scene cities)
4. Editorial sources — RA news, Mixmag scene reports, Test Pressing, Tracks & Tales (for listening bars)

**Non-US cities:** lineups often post week-of via Instagram (CDMX, much of Latin America, smaller European scenes). For these, rank durable venues first and tell her to check IG day-of. Berlin and London publish further out via RA + venue sites.

### 5. Filter through the taste profile

Score each event against her principles:
- **Greenlights** — selector-led, intimate, lineage scene, no-phone policy, label nights
- **Yellow flags** — mainstream venue with the right DJ (check the crowd / room)
- **Red flags** — stadium, EDM mainstage, "see and be seen" venue, festival mainstage, influencer-coded

The load-bearing rule applies (see top). Don't recommend an artist she'd love in a room she'd hate.

### 6. Reply ranked + sourced

Format:
- **Top picks (3–5), ranked by:**
  1. Room / curator fit
  2. Lineage / scene match
  3. Artist familiarity from her taste profile

  In that order — artist familiarity is the tiebreaker, not the lead.
- Strong secondary (3–5)
- Flagged conflicts from calendar
- Sources — links to every page scraped

Always cite sources. Always note when something is unverified ("lineup posted day-of via Instagram") so she doesn't expect false precision.

**Format per channel** — see `/workspace/global/CLAUDE.md` for the message formatting rules of the active channel (Telegram/Slack/Discord/etc.). Don't use `**double-asterisk bold**` in Telegram or WhatsApp.

## Common Mistakes

- **Skipping the taste profile read** — produces generic recommendations that miss the entire point. Even on follow-ups, re-read the file.
- **Single-source scraping** — venue sites often 403/404. Always hit 2–3 sources per venue.
- **Recommending the right artist in the wrong room** — load-bearing rule violation. The room matters at least as much as the lineup.
- **Falling back to more RA URLs when RA 403s** — RA returns the same 403s. The real fallbacks are Songkick / Bandsintown / IG / editorial.
- **Assuming lineups are published in advance** — for many cities (especially non-US), they post week-of via IG. Rank durable venues first.
- **Recommending past events** — verify the date range is in the future before scraping.
- **Not citing sources** — she needs to verify before buying tickets.
- **Using Calendar to discover trip dates** — wrong tool. Trip dates come from Trips.md (step 1b). Calendar is for conflict-checking within an already-known window.
- **Forgetting calendar conflicts** — once you know the trip window, flying to NYC but having a Chicago appointment Thursday is the kind of thing she wants flagged.
- **Wrong timezone on calendar query** — scouting NYC from Chicago means events display in ET; query the calendar in ET to catch real conflicts.

## Capture workflow (writing new discoveries)

When Sophie shares a taste-relevant discovery — a restaurant she liked, a DJ set she loved, a bar/venue she wants to remember, a scene observation — **append to `/workspace/extra/taste-profile/additions.md` using the `Write` tool.** The taste-profile mount is read-write — it is NOT the Obsidian vault (which is at `/workspace/extra/vault/` and needs `edit_obsidian`). The `Write` tool works directly on `additions.md`.

**HARD RULE — don't lie about the write:**
- Do NOT say "Added!" / "Logged!" / "Saved!" / "Done!" until the `Write` tool has actually been called and succeeded.
- If you're asking a clarifying question first, the correct reply is: `"Got it — what about it stood out? I'll log it to your taste profile once you tell me."` (or equivalent). Do NOT use past-tense action verbs.
- If she answers the clarifying question, the next thing you do MUST be the `Write` call. Then confirm with "Saved to your taste profile — [type] / [name]."
- If she gives a one-word answer or non-answer ("just save it" / "idk" / nothing for a turn), write a stub entry with `[awaiting context]` in the notes — but **write it** — don't drop the capture.

Past failure (2026-05-19): bot said "Added! John's Food and Wine is now logged" but never called Write — additions.md stayed empty. Sophie noticed. Don't repeat.

**Triggers** (not exhaustive):
- "just had an amazing meal at X"
- "X was so good"
- "found a new favorite Y"
- "loved [DJ/set/show]"
- "this Bar/place is exactly my thing"
- Any reflection that adds taste signal she doesn't already have on file

**Entry format — append at the bottom of additions.md:**

```
### YYYY-MM-DD / [type] / [name or subject]

[Raw quote of what she said]

[Follow-up notes if any, separated by a blank line]
```

**Types:** `food` · `music` · `venue` · `scene` · `experience`

### When to ask one clarifying question

If the capture is bare — just a name + "amazing" with no detail — ask ONE short follow-up before writing the entry. Examples:
- For food: "what was the vibe / what'd you order?"
- For music: "what was the room / who was playing?"
- For a venue: "what made it stick — sound / crowd / room?"

Wait for her answer, then write the entry with the clarification included. Don't badger — one question max per capture. If she says "just save it, I'll fill in later," skip the question and write a stub entry with `[awaiting context]` in the notes.

### When NOT to ask

- She's already given vibe / dish / artist / detail in the original message
- She explicitly skips ("just save it")
- It's a quick mention adjacent to another task (don't interrupt her flow)

### Don't touch the canonical files

`taste.md`, `music-events.md`, `restaurants.md` are write-locked by convention (not filesystem) — agent never modifies them. All captures go to `additions.md` only. Synthesis into the canonical files happens manually via Mac Claude Code.

### Append-only

Don't rewrite or "correct" earlier entries. If she contradicts herself ("Bar Sardine was mid actually"), append a new dated entry — synthesis figures it out later.

### Confirm the capture

After writing, briefly confirm: "Saved to your taste profile — [type] / [name]." Keep it short, channel-appropriate formatting.
