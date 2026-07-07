# place-podcast — audio walking tours from wherever Sophie is

## What it is

Sophie messages NanoClaw with where she is ("I'm walking around old port montreal, tell me about it", or a Telegram location share). The bot offers 3-4 specific historical angles for that place, she picks one, and ~5 minutes later a single-narrator ~10-minute audio walking tour MP3 arrives in the chat.

Design was reviewed by two agents (technical feasibility + UX) on 2026-07-07; their fixes are folded in below.

## Requirements

- **Gemini for research** — grounded Google Search via the Gemini API is the "good at research" part Sophie wants. TTS provider doesn't matter to her; reuse the ElevenLabs pipeline.
- **Always offer angle options** (numbered menu + "surprise me") before generating.
- **Single-narrator tour-guide style**, not two-host banter.

## The flow

**Turn 1 — resolve place, offer angles:**
1. Get a *named* place:
   - `[Location: lat, lon]` share → reverse-geocode via Nominatim `/reverse` to a place name (whats-close only ever needed coords; this skill needs a name to research).
   - Typed text → forward-geocode via Nominatim, inheriting whats-close's documented traps and mitigations.
   - Neither → reply with the `{{request_location}}` button, end turn.
   - Always echo the resolved place back in the menu message so a bad geocode is visible, and so turn 2 doesn't re-derive the location.
2. Quick grounded Gemini call: "3-4 most interesting historical angles on this specific place" — menu must be concrete ("the grain silos", "Expo 67"), not generic ("architecture", "culture").
   - **Thin-history rule:** if the immediate spot is quiet, zoom out (block → neighborhood → city-level story that runs through this spot), say so honestly, and offer 2 good angles rather than padding to 4.
   - **Dedup:** glance at prior place-podcast scripts in Obsidian for this city; don't re-offer an angle she's already heard.
3. Reply with numbered menu + "surprise me", end turn. Her answer arrives as a new message that re-triggers the agent (whats-close's proven pattern).

**Turn 2 — research, script, deliver:**
4. **Ack immediately**: "Grain silos it is — researching and recording, MP3 in ~5 min." Without this she gets minutes of dead air mid-walk that reads as "bot broke."
5. Research: single grounded Gemini generateContent call (NOT the Deep Research agent product — that's 5-20 min and app-only anyway) → brief with real dates, names, anecdotes, plus a list of prominent still-standing structures.
6. The container agent (Claude) writes a single-narrator walking-tour script, ~1400 words ≈ 10 min, from the brief.
   - Landmark references are **conditional and named** ("if you can spot the Silo No. 5 grain elevator across the basin…"), never directional ("to your left"), and never assume she's still at the share point — she'll have walked 400m by delivery.
7. Synthesize with the existing `podcast-synth.mjs` (gains a single-voice mode, see below) → MP3 to the Telegram chat.
8. Save script to Obsidian research folder (same as make-podcast) — this is also what powers the dedup glance in step 2.

## Changes

**New: `container/skills/place-podcast/`**
- `SKILL.md` — triggers, location resolution, angle-menu format + thin-history rule, ack message, tour-guide script style guide, synthesis command, Obsidian save/dedup.
- `gemini-research.mjs` — helper for the Gemini API with `google_search` grounding, via the stable `generateContent` endpoint. Modes: `angles "<place>"` and `brief "<place>" "<angle>"`. Default model `gemini-2.5-flash` (supports google_search grounding, 500 grounded requests/day on free tier), overridable via `GEMINI_MODEL`. Prints progress to stdout (also keeps the container idle-timeout timer fed).

**Modified: `container/skills/make-podcast/podcast-synth.mjs`**
- Parameterized instead of forked (review fix — a tour-synth copy would drift): optional narrator-voice argument; a script with no `ALEX:`/`SAM:` labels synthesizes as a single voice. Existing two-host path unchanged.

**Modified: `src/container-runner.ts`** (one line)
- Add `GEMINI_API_KEY` to the container env whitelist (~line 519). This is the one core-code touch; there is no skill-level alternative because the container bind-mounts `/dev/null` over `.env`. Requires host restart.

**Config:** `GEMINI_API_KEY` in `.env`, minted at aistudio.google.com (free tier; ~2 grounded calls per episode, well under limits). Note: gemini-2.5-**pro** is no longer on the free tier (removed April 2026) — flash-tier models are the design target.

## Error handling

- Geocode fails/ambiguous → ask, don't guess (whats-close rules verbatim).
- Gemini call fails → say so, fall back to Claude's own knowledge (episode still happens, less grounded).
- ElevenLabs fails mid-synthesis → report; script is already in Obsidian so nothing is lost.

## Non-goals

- No two-host mode for this skill (make-podcast already does that).
- No NotebookLM API (none exists), no Deep Research agent product.
- No GPS tracking / auto-location, no episode-length setting (10 min hardcoded; ad-hoc "make it 5 min" requests can just be honored in the moment), no voice-note transcription work (upstream concern).
