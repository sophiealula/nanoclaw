---
name: whats-close
description: When Sophie shares a Telegram location (message contains "[Location: lat, lon]") or asks "what's close", "what's near me", "anything around here" — rank her saved/captured places by distance from those coordinates and reply with the nearby ones.
---

# What's Close

Sophie pings a location from Telegram; you tell her which of HER places are nearby. Location messages arrive as `[Location: 45.5155, -73.5877]` (venue shares include a name/address after the coords).

## Steps

1. Get coordinates, in order of preference:
   - **Shared location**: parse `lat, lon` from a `[Location: …]` message.
   - **Text location**: if she names where she is ("near St-Laurent and Duluth", "at Café Olimpico", an address), geocode it:

     ```bash
     curl -s -A "nanoclaw-whats-close/1.0" "https://nominatim.openstreetmap.org/search?format=json&limit=3&q=<url-encoded query, include the city>"
     ```

     Always include the city (from trip context/calendar if she didn't say). Nominatim is error-prone — verified traps: street intersections ("X and Y") return nothing; borough/district names hijack street matches (e.g. "Boulevard Saint-Laurent, Montréal" can land in the Saint-Laurent borough); chain/multi-location venues return an arbitrary branch. So: request `limit=3`, check the `display_name`s actually match what she said, and if results are ambiguous or the venue has multiple locations, ask her which one instead of picking. ALWAYS echo the resolved spot back ("assuming you're near X — …") so a bad geocode is visible. If nothing plausible comes back, ask for a nearby landmark or venue name rather than guessing.
   - **Neither**: reply with exactly this and end your turn — her answer arrives as a new message that triggers you again:

```
Where are you? Tap the 📍 button (phone), or just tell me an address or cross-streets. {{request_location}}
```

The marker renders a native share-location button in the Telegram mobile apps only. Desktop clients (Beeper — Sophie's usual client — and Telegram Desktop) can't share location at all, which is what the text path is for. Never guess where she is.
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
