# letterboxd-watchlist-skill

A [NanoClaw](https://github.com/2389-research/nanoclaw) container skill that lets you text your bot natural-language watchlist commands — add a film, see what's streaming on Netflix, ask for the trailer.

> **Note:** uses Letterboxd's API via refresh-token auth extracted from the iOS app (the mitmproxy method documented [here](https://blog.alexbeals.com/posts/extracting-letterboxd-tokens-with-mitmproxy)). Letterboxd's preferred path for API access is `api@letterboxd.com` — this is provided for personal/educational use. Don't use it to build something that drives meaningful traffic at them.

## What you can say

```
add Past Lives to watchlist          → adds it
what's on my watchlist                → grouped by mood/genre
what should I watch tonight           → same, with recommendation framing
what's streaming on netflix           → filters watchlist to subscription streaming on a named service
trailer for Obsession                 → YouTube URL, auto-unfurls in chat
is Inception on my watchlist          → check without adding
remove COVID Obsession                → undo
```

```
you:    add Past Lives to watchlist
nano:   Added Past Lives (2023) to your watchlist 🎬

you:    what's on my watchlist
nano:   • Past Lives (2023)
        • Anatomy of a Fall (2023)
        • The Zone of Interest (2023)
        ...
```

## How it works

NanoClaw skill that calls the Letterboxd v0 API directly using refresh-token auth captured once from the iOS app. No browser, no Cloudflare hassles, sub-second per request, and the refresh token effectively never expires.

## Files

| File | Purpose |
|---|---|
| `SKILL.md` | Instructions the NanoClaw agent reads to handle watchlist queries |
| `lb.js` | Node.js CLI: `add`, `remove`, `list`, `browse`, `check`, `search`, `trailer`, `streaming` |
| `package.json` | Declares `"type": "commonjs"` so the script works under parent ESM projects |
| `README.md` | This file |

## One-time setup

Capture three values from the Letterboxd iOS app via [mitmproxy](https://mitmproxy.org/): `client_id`, `client_secret`, and `refresh_token`. This walks through it — credit to [Alex Beals' writeup](https://blog.alexbeals.com/posts/extracting-letterboxd-tokens-with-mitmproxy) which covers the same flow in more detail.

### 1. Install mitmproxy on your laptop

```bash
brew install mitmproxy
```

### 2. Start mitmproxy and trust its CA on your iPhone

On your laptop:

```bash
mitmweb
```

A web UI opens at `http://localhost:8081`. Note your laptop's local IP (`ipconfig getifaddr en0`).

On your iPhone:

1. Settings → Wi-Fi → tap your network → "Configure Proxy" → Manual. Server: your laptop's IP. Port: `8080`.
2. Open Safari, go to `http://mitm.it`. Tap the Apple icon, download and install the CA profile.
3. Settings → General → About → Certificate Trust Settings → enable the mitmproxy cert.

### 3. Capture the login

Force-quit the Letterboxd app, then reopen it. It should hit `/auth/token` to refresh on launch (if not, log out and back in).

In the mitmweb UI, find the request to `api.letterboxd.com/api/v0/auth/token`. Click it.

- **Request → Form**: copy the `refresh_token` value, and the `client_id` value if present.
- **Request → Headers**: the `Authorization: Basic ...` header contains base64 of `client_id:client_secret`. Decode it (e.g. `echo "<base64>" | base64 -d`) to get both pieces.

### 4. Save the creds

Create `~/projects/nanoclaw/groups/telegram_main/.letterboxd-api.json` (host path — nanoclaw mounts this folder into the container as `/workspace/group/`, which is the path `lb.js` reads from by default):

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "..."
}
```

That's it. The skill caches access tokens inside the same file (auto-refreshed when they expire).

To decode the basic-auth header from mitmweb, `printf` is more reliable than `echo` on macOS:

```bash
printf '<base64-from-mitmweb>' | base64 -d
# prints: <client_id>:<client_secret>
```

### 5. Undo the proxy

Don't forget to flip the iPhone Wi-Fi back: Settings → Wi-Fi → your network → Configure Proxy → Off. Otherwise all your phone traffic keeps routing through mitmproxy.

## Install into nanoclaw

```bash
cp -R ~/projects/personal/watchlist_skill \
      ~/projects/nanoclaw/container/skills/letterboxd-watchlist
```

NanoClaw auto-syncs `container/skills/` into each group on container startup. No Docker rebuild.


## When tokens stop working

If you ever start getting "Letterboxd session expired" replies, the refresh_token was probably revoked (you logged out everywhere, or Letterboxd cycled it). Repeat the mitmproxy capture and replace `.letterboxd-api.json`.

Letterboxd would prefer you go through their official `api@letterboxd.com` application process. This skill works today; consider applying officially if you build something bigger on it.
