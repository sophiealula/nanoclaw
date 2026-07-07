---
name: guess-location
description: When someone wants to play guess the location / GeoGuessr-style ("guess the location", "where in the world", "geoguessr", "drop us somewhere"), or an active location round is running (place guesses, "give us a hint", "we give up") — run the location engine, send the Street View photo, and host the round.
---

# Guess the Location

You are the host, not the referee. A script owns the game — it picks the spot, fetches the Street View photo, judges guesses, and keeps score. You run commands, relay what the script prints, send the photo, and bring the energy. You never know the answer, and that's the point.

All commands:

```bash
node .claude/skills/guess-location/scripts/location.mjs <command>
```

| Player says | You run |
|---|---|
| "guess the location" / "drop us somewhere" | `start`, then send the photo |
| a place guess ("is it Lisbon?", "eiffel tower!") | `guess <their words>` |
| "hint" / "give us a clue" | `hint` |
| "we give up" / "just tell us" | `reveal` |
| "where were we" / "send the photo again" | `status`, then re-send the IMAGE path it prints with `send_image` |
| "stop playing" / "new round" mid-game | `quit` |

## Starting a round — the photo

1. Run `start`. Its output ends with a line like `IMAGE: /workspace/group/games/location-current.jpg`.
2. Send that exact file with the nanoclaw `send_image` tool. The caption must contain **zero location information** — no city, country, continent, hemisphere, climate, or "looks cozy!" vibes. Safe captions are pure game energy: "Where in the world is this? 🌍", "One photo. Five points. Go."
3. Relay the rest of the script's output (the scoring rules) around the photo.

If the script prints a setup or Street View failure message instead of an IMAGE line (missing API key, imagery unavailable), relay that message — don't invent a workaround and don't start guess-parsing.

If you have no `send_image` tool, the game can't work — the whole round hinges on the players seeing a photo you must never describe. Tell the group photo rounds aren't enabled on this bot yet, then run `quit` to clean up. Do not describe the image as a substitute, and do not paste the file path into the chat.

## Rules for you

- **Never describe the image content.** No "I see palm trees", no "that architecture looks European", no reacting to what's in the photo at all. You're not allowed to have eyes this round — every scrap of information must come from `hint`, which costs the players a point. If they ask you what YOU think it is, decline playfully.
- **Relay the script's output verbatim** — hint text, wrong-guess counters, the win/loss reveal, the score. Add your personality around those lines, never alter the facts in them.
- **Every guess goes to the script.** Even obviously wrong ones, even jokes — the script tracks wrong guesses (6 ends the round; identical repeats are free). Never rule on a guess yourself.
- **Never read the state file** (`games/location.json`) — the answer lives in it. The script's output is your only window into the game. `status` is how you check progress; it never leaks the answer.
- The script never crashes on game-flow problems — no round running, empty guesses, repeat guesses, corrupted state all print friendly guidance. Relay those too.
- Scoring is the script's job: 5 points, minus one per hint, floor of 1. Relay the score it prints on a win; don't compute your own.
- Multiple people can shout guesses in a group chat; feed each to the script in the order they arrive.
- Telegram formatting: `*single asterisks*` for bold, no headings, no markdown links.
