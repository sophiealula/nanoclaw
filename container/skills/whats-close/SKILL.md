---
name: whats-close
description: When Sophie shares a Telegram location (message contains "[Location: lat, lon]") or asks "what's close", "what's near me", "anything around here" — rank her saved/captured places by distance from those coordinates and reply with the nearby ones.
---

# What's Close

Sophie pings a location from Telegram; you tell her which of HER places are nearby. Location messages arrive as `[Location: 45.5155, -73.5877]` (venue shares include a name/address after the coords).

## Steps

1. Parse `lat, lon` from the location message. If she asked "what's close" WITHOUT sharing a location, ask her to share one (Telegram: attach → Location) — don't guess where she is.
2. Query the store:

```bash
node .claude/skills/whats-close/scripts/places.mjs near <lat> <lon> 8
```

3. Reply with what's actually close — lead with anything under ~2km, formatted like: `Mesures — 650m (~8 min walk) — jazz-kissa vinyl bar, natural wine`. Use each place's `note`/`source` for the one-line description. Round, don't fake precision.
4. **Taste-profile cross-check**: skim `/workspace/extra/taste-profile/additions.md` and the confirmed-places tables for places in the same city that aren't in the store yet (they lack coordinates) — mention them by name as "also in <city>, no pin yet".
5. If nothing is within ~3km, say so plainly, name the closest thing anyway with its distance, and offer to scout the immediate neighborhood with the `taste-aware-event-scout` skill instead.
6. Offer a guide link when useful: if she wants the nearby picks in her pocket, hand the top results to the `apple-maps-guide` skill.

## Growing the store

The store is `/workspace/group/places.json`. It grows two ways:

- The `apple-maps-guide` skill appends every place it puts in a guide (see that skill).
- Direct capture: when Sophie says "pin this" / shares a venue-location of a spot she likes, add it:

```bash
node .claude/skills/whats-close/scripts/places.mjs add '{"name":"Spot","lat":48.86,"lon":2.36,"city":"Paris","note":"why it matters","source":"sophie"}'
```

Rules: never invent coordinates — only add places whose coords came from a shared venue/location, a guide build, or a verified lookup. Never bulk-edit `places.json` by hand; go through the script (it dedupes).
