---
name: apple-maps-guide
description: Turn place recommendations into an Apple Maps guide link Sophie can open and save with one tap. Use when Sophie says "save to maps", "make me a guide", "apple maps", or shares a batch of places worth keeping (trip scouting results, restaurant/bar recs). Apple Maps is her preferred maps target.
---

# Apple Maps Guide Links

Generates `https://maps.apple.com/guides?user=<protobuf>` links. The entire guide (name + places) is encoded in the URL — no server, no auth, works offline. Opening the link on Sophie's iPhone/Mac shows the guide natively in Apple Maps; one tap ("Add to Library") saves the whole batch.

## How to build a guide

1. Collect places. Each place needs `name` plus `address` and/or `lat`/`lon`. If you know a MapKit Place ID (`I<hex>`) or numeric Apple Maps ID, pass `appleMapsId` instead — that links the real place card rather than dropping a labeled pin.
2. Run the generator:

```bash
node .claude/skills/apple-maps-guide/scripts/apple-guide-link.mjs '{
  "name": "Andy picks — Montréal",
  "places": [
    {"name": "Spot Name", "address": "123 Rue Example, Montréal, QC", "lat": 45.51, "lon": -73.58}
  ]
}'
```

3. Reply with the link. Keep the link on its own line so Telegram renders it tappable.
4. Append every place that went into the guide (with its coords) to the shared place store, so the `whats-close` skill can answer "what's near me" later:

```bash
node .claude/skills/whats-close/scripts/places.mjs add '[{"name":"Spot","lat":45.51,"lon":-73.58,"city":"Montréal","note":"one-liner","source":"guide: Andy picks — Montréal"}]'
```

## Rules

- **Never guess coordinates.** If you can't verify an address or lat/lon from a source (web search result, her message, a known listing), leave the place out and say so — a pin in the wrong spot is worse than no pin.
- **Notes don't travel.** Guide pins carry no per-place notes. Put any notes (why it was recommended, who recommended it, what to order) in the message text next to the link.
- **Name guides `<context> — <city>`** (e.g. "Trip scout — Lisbon"). Re-sharing an updated link creates a NEW guide when saved — it does not update a previously saved one. For evolving lists, tell Sophie it's a fresh link and she can delete the old guide.
- **One tap is expected.** Tell Sophie to tap the link, then "Add to Library" if she wants it saved. Don't promise the save happened — you can't do it for her.
- Batch: hundreds of places fit in one URL (~20–60 base64 chars per place), but keep guides focused — one city/context per guide.
- This format is reverse-engineered (stable 2019→2026) — if a generated link ever fails to open, report it to Sophie rather than retrying variations.
