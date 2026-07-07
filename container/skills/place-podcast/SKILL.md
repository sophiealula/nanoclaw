---
name: place-podcast
description: Sophie says where she is ("I'm walking around old port montreal, tell me about it", a Telegram location share + podcast-ish ask, "make me a podcast about where I am") — offer 3-4 concrete historical angles, then research the one she picks with Gemini and deliver a ~10-minute single-narrator audio walking tour to the chat.
---

# Place Podcast — audio walking tours

Sophie is out walking. She tells you where she is; you offer angles; she picks; a ~10-minute narrated MP3 about that place's history lands in the chat a few minutes later.

This is a TWO-TURN flow. Turn 1 ends with the angle menu. Her pick arrives as a new message that triggers you again.

## Turn 1 — resolve the place, offer angles

### 1. Get a NAMED place

You need a place name to research, not just coordinates. In order of preference:

- **Shared location** (`[Location: lat, lon]`): reverse-geocode it —

  ```bash
  curl -s -A "nanoclaw-place-podcast/1.0" "https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=<lat>&lon=<lon>"
  ```

  Read the neighborhood from the `display_name` components, not the street-level `name` — e.g. `"Rue Saint-Vincent, Vieux-Montréal, Ville-Marie, Montréal, ..."` → research "Vieux-Montréal, Montréal". She wants the story of the area, not of one building's mailbox. (Verified trap: `name` is a street or plaza at zoom 15-16, a whole borough at zoom 14.)

- **Typed location** ("old port montreal", "walking around the mission"): geocode it with the same rules and traps documented in the `whats-close` skill — `limit=3`, include the city, check `display_name`s actually match, ask instead of picking when ambiguous. If she named a well-known place clearly, you may skip geocoding entirely; you just need to be sure WHICH place it is (which city!).

- **Neither**: reply with exactly this and end your turn:

```
Where are you? Tap the 📍 button (phone), or just tell me a neighborhood or landmark. {{request_location}}
```

### 2. Find the angles

Run the grounded research helper:

```bash
node .claude/skills/place-podcast/gemini-research.mjs angles "Old Port of Montreal, Montreal, Canada"
```

If the Gemini call fails (no key, quota, outage), say so briefly and propose angles from your own knowledge instead — the episode still happens, just less grounded.

**Dedup:** before presenting, glance at existing `Walking Tour - *` notes in the Obsidian research folder for this city and drop any angle she's already heard.

### 3. Present the menu, end your turn

Echo the resolved place (so a bad geocode is visible), then the numbered angles plus "surprise me":

```
Old Port of Montreal — good spot. What angle?
1. Fur trade origins — why this port existed at all
2. The grain silos — industrial rise and fall
3. Expo 67 and the waterfront's reinvention
4. Surprise me
```

If the helper says the immediate spot is thin and zoomed out, pass that honesty along ("this block itself is quiet, but...") — 2 strong angles beat 4 padded ones. End your turn. Do NOT start researching yet.

## Turn 2 — research, script, deliver

### 4. Ack FIRST

The moment she picks, reply before doing anything else — otherwise she gets minutes of dead air mid-walk:

```
The grain silos it is — researching and recording now. MP3 in ~5 min, keep walking.
```

("Surprise me" → you pick the angle you found most compelling and name it in the ack.)

### 5. Research

```bash
node .claude/skills/place-podcast/gemini-research.mjs brief "Old Port of Montreal, Montreal, Canada" "The grain silos — industrial rise and fall"
```

This is a single grounded call (~1-2 min), NOT a deep-research agent. The brief includes a "structures still standing" list — that's what the script may reference. Same fallback rule: if Gemini fails, research from your own knowledge and say so in the final message.

### 6. Write the script

Single narrator, ~1400 words (≈10 min). Style rules:

- **Tour-guide warmth, podcast pacing.** Curious, vivid, story-first. Not a Wikipedia read-aloud, not hype.
- Open by dropping her into the story ("The building you're wandering past used to smell like grain and diesel...") — no "welcome to this episode" intro. End on something that lingers.
- **Landmark references are conditional and named, never directional.** Good: "if you can spot the Silo No. 5 grain elevator across the basin...". Bad: "to your left you'll see...". She's moving; never assume she's still where she shared. Only reference structures from the brief's still-standing list.
- Real dates, names, and anecdotes from the brief only — don't embellish facts, embellish the telling.
- NO speaker labels, stage directions, or sound cues. Plain prose paragraphs only (labels would trigger two-voice mode in the synth).
- If she asked for a different length ("quick 5 min version"), honor it — no setting, just scale the script.

Save the script to Obsidian (this also powers dedup):

```
edit_obsidian(action: "create_file", dir: "research", file: "Walking Tour - {Place} - {Angle}.md", content: "...")
```

### 7. Synthesize and deliver

```bash
cat > /tmp/tour_script.txt << 'SCRIPT'
{full script text — plain prose, no labels}
SCRIPT

node .claude/skills/make-podcast/podcast-synth.mjs /tmp/tour_script.txt "{Place}: {Angle}" "{chat_id}" JBFqnCBsd6RMkjVDRZzb
```

The last arg is the narrator voice (George — warm storyteller). The synth script sees no ALEX:/SAM: labels and uses that single voice throughout. Main Telegram chat id: `8535290004` (otherwise it's in the message context).

If synthesis or delivery fails, tell her plainly and point at the Obsidian note — the script is already saved, nothing is lost. Don't retry more than once.

### 8. Confirm

One line: episode length, angle, and that the script is in her Research folder.

## Environment variables needed

- `GEMINI_API_KEY` — from aistudio.google.com (free tier is plenty; ~2 calls per episode)
- `GEMINI_MODEL` (optional) — defaults to `gemini-2.5-flash`
- `ELEVENLABS_API_KEY`, `TELEGRAM_BOT_TOKEN` — already configured
