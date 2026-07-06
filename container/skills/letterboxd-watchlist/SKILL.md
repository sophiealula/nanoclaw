---
name: letterboxd-watchlist
description: Manage Sophie's Letterboxd watchlist via the official Letterboxd API. Use when she texts things like "add Inception to watchlist", "what's on my watchlist", "show my watchlist", "save X for later", or "is X on my watchlist".
allowed-tools: Bash(node:*)
---

# Letterboxd Watchlist

Talk to Letterboxd's official API with refresh-token auth. No browser, fast, doesn't expire.

## ⚠️ NO SPOILERS — hard rule

When replying with film names from any command (`browse`, `streaming`, `list`, etc.), output **only the title and year**. Do NOT add commentary about:
- endings, finales, "last 10 minutes", climaxes
- character deaths, twists, reveals, resolutions
- emotional impact tied to plot ("it still hits", "you'll cry", "devastating")
- whether something is sad/happy in a way that reveals the ending
- comparing the ending to other films

Neutral context (director, genre via the `browse` headers, runtime if asked) is fine. Plot-adjacent commentary is not. Sophie has been spoiled by you before for Gallipoli and Million Dollar Baby — don't do it again.

If you're tempted to add a one-liner about a film, just don't.

## Prerequisites

A creds file must exist at `/workspace/group/.letterboxd-api.json` containing `client_id`, `client_secret`, and `refresh_token` (captured once via mitmproxy — see README). If it's missing, reply:

> No Letterboxd API creds found — run the one-time mitmproxy capture (see `watchlist_skill/README.md`) and drop `.letterboxd-api.json` into the group folder.

Then stop.

## Commands

The script lives at the skill folder root. Invoke via Bash:

```bash
node "$CLAUDE_PROJECT_DIR/.claude/skills/letterboxd-watchlist/lb.js" <subcommand> [args]
```

If `$CLAUDE_PROJECT_DIR` isn't set, fall back to `/home/node/.claude/skills/letterboxd-watchlist/lb.js`.

### Add a film

```bash
node .../lb.js add "Past Lives"
```

Output is exactly the reply to send the user, e.g. `Added Past Lives (2023) to your watchlist`. Pass it through verbatim (you can prepend a 🎬 emoji if you like).

If the script exits with code 2, the film wasn't found — reply with whatever it printed.

### Show the watchlist

```bash
node .../lb.js list --limit 20
```

Default limit is 20. If the user asks for "all of it" or "everything", bump to 200. The output is a bulleted list of `• Title (Year)` lines plus a count footer — format the reply however reads best in the channel (collapse onto one line for tiny channels, keep as-is for chat).

### Browse the watchlist (this is the default for watchlist queries)

Use this **whenever** the user asks about her watchlist — "what's on my watchlist", "what should I watch tonight", "i'm in the mood for X", "give me something to watch", "feel like a thriller", "show my watchlist". This is the primary read command. Only use the flat `list` (below) if she explicitly asks for a flat unsorted list.

Run:

```bash
node .../lb.js browse
```

Each line is `Title\tYear\tGenre1,Genre2,...`. Use the genres internally to group films by **mood or genre**, but **show the user only the titles** (no year, no genres, no runtime).

**Format strictly:**
- One mood/genre per group, with an emoji + bold name as the header
- Each title on its own line, prefixed with `• `
- One blank line between groups

Example output:

```
🎭 **Drama**
• Past Lives
• Z

🔪 **Thriller / Horror**
• Obsession
• The Killing of a Sacred Deer

😂 **Comedy**
• Rosebush Pruning
```

Pick groupings naturally from what's actually on her watchlist — don't force every Letterboxd genre. If the user asks for a specific mood ("thriller", "something light", "romance"), filter to only that group. If she asks for something general, show 2-4 groupings.

### Filter watchlist by streaming service

When the user asks what's streaming right now on a specific service — "what's on Netflix", "I only have Hulu, anything on my list", "what can I watch on Max tonight", "anything streaming on Disney+" — run:

```bash
node .../lb.js streaming "<service>"
```

For multiple services, comma-separate: `lb.js streaming "netflix,hulu"`.

Known aliases that resolve cleanly to one service: `netflix`, `hulu`, `max` (aka `hbo max`), `prime` (Amazon Prime Video), `disney` / `disney+`, `peacock`, `paramount`, `apple tv`, `kanopy`, `mubi`, `criterion`. Unknown names fall back to substring match. Returns subscription streaming only (no rent/buy).

Output: tab-separated `Title\tYear\tService\tWatchURL`, one row per (film, matched service). Reply by listing matched films grouped under a service header. **Don't wrap titles in Markdown links** — Telegram mangles JustWatch URLs with special chars. Just put the title and put the URL on its own line so Telegram unfurls it. Or skip the URLs entirely if there are many results — they get noisy. Example:

```
🍿 Netflix
• Train Dreams (2025)
• The Ritual (2017)
• James Acaster: Repertoire (2018)
```

If output is `nothing on your watchlist is currently streaming on X`, relay that plainly.

**Disambiguation:** if the user says something that could route to `browse` OR `streaming` ("what should I watch on netflix tonight", "what's good on hulu") — naming a service wins → use `streaming`.

This call fans out across the watchlist and can take a few seconds — that's expected. If a stderr line appears like `(N films couldn't be checked)`, mention it briefly: "some availability data was unreachable, showing what I could fetch."

### Show the trailer for a film

When the user says "give me the trailer", "show me the trailer (for X)", "trailer for X", or just "trailer" referring to a film from earlier in the conversation, run:

```bash
node .../lb.js trailer "<title>"
```

If the user said just "the trailer" without naming a film, use the most recently mentioned film in the conversation. If unclear, ask which film.

Output is two lines: title on the first, YouTube URL on the second. Reply to the user with the URL on its own line — Telegram/most chat clients will auto-unfurl it into a playable preview. Example reply:

> Here's the trailer for *Obsession (2025)*:
> https://www.youtube.com/watch?v=...

If the script prints `no trailer on letterboxd for ...`, relay that as: "no trailer on letterboxd for {title}".

### Check whether a film is on the watchlist

```bash
node .../lb.js check "Dune"
```

Prints either `X (year) is on your watchlist` or `X (year) is NOT on your watchlist`. Does NOT add anything — use this when the user is asking, not telling.

### Look up a film without adding

```bash
node .../lb.js search "dune"
```

Returns up to 5 `<id>\t<Title> (Year)` rows. Useful for disambiguation ("did you mean Dune (1984) or Dune (2021)?").

## When to use which trigger

| User says | Run |
|---|---|
| "add X to watchlist", "save X", "put X on my list" | `add` |
| "what's on my watchlist", "show watchlist", "what should I watch", "in the mood for X" | **`browse`** (default — grouped by mood/genre) |
| "just list them all", "flat list", "every film as one list" | `list` (rare — only when user explicitly asks for a flat list) |
| "is X on my watchlist", "do I have X saved" | `check` |
| "remove X from watchlist", "take X off my list" | `remove` |
| "give me the trailer", "trailer for X", "show me the trailer" | `trailer` |
| "what's on netflix/hulu/max", "I only have X right now", "anything streaming on X" | `streaming` |

**Default rule:** any time the user asks about the contents of her watchlist (browsing, recommending, checking what's there), use `browse` and present it grouped by mood/genre. The flat `list` command exists only for the rare case where she explicitly wants an unsorted dump.

## Errors you might see

- **`token refresh failed`** → refresh_token is dead. Tell the user to re-run the mitmproxy capture. This should be rare.
- **`/me failed` with status 401** → same as above, refresh_token revoked.
- **`couldn't find "{title}" on letterboxd`** → title didn't match anything. Ask the user for a more specific title or a year.
- **Any other non-2xx** → report the status and stop. Don't retry indefinitely.
