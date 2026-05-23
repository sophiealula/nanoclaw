# NanoClaw Maps Saver — Chrome extension

Saves places to your real signed-in Google Maps Saved Places lists from your NanoClaw Telegram bot. Bypasses Google's bot detection because it runs inside your own Chrome session — no Playwright, no automation framework, just JavaScript clicking your own DOM.

## How it works

```
Telegram → NanoClaw container → writes save intent → ~/Library/Application Support/nanoclaw/maps-queue/pending/
                                                          │
                          NanoClaw host HTTP server (localhost:7733) serves the queue
                                                          │
                          This extension polls every 4 sec, finds an intent, opens a Maps tab,
                          content-script clicks Save → picks list → fills note → closes tab,
                          POSTs outcome back to the host. Container reads the outcome.
```

## Install (one-time)

**Auto-install (recommended):**

```bash
cd chrome-extensions/maps-saver
./install.sh
```

The script opens Chrome, enables Developer mode, clicks Load unpacked, and navigates the file picker automatically via macOS UI scripting. Requires Accessibility access for Terminal (`System Preferences → Privacy & Security → Accessibility`).

**Manual fallback** (if the script misfires):

1. **Make sure NanoClaw is running** (it owns the localhost:7733 queue server).
2. Open Chrome → `chrome://extensions/`
3. Top right: toggle **Developer mode** on
4. Click **Load unpacked** → select this folder (`chrome-extensions/maps-saver/`)
5. Pin the extension if you want (puzzle icon in toolbar → pin Maps Saver). The popup shows whether the queue is reachable.

## Verify it works

- Click the extension's icon in your toolbar. Popup should say **"Connected ✓"**.
- From Telegram: `Eden rec'd Loulou in Brighton`. Bot recaps + you say yes. A background Maps tab will flash open in your Chrome, save the place, close itself. Phone → Maps → Saved → Brighton list should show Loulou.

## When you'd update it

- **Maps DOM changes** — Google A/B tests the Save button / list picker. If saves silently fail, check the content-script's selectors (`content-script.js` lines 35-95). The patterns mirror `container/skills/pp-google-maps/SKILL.md` Sections 5-6.
- **Port collision** — if `localhost:7733` is taken, edit `MAPS_QUEUE_PORT` in both `src/maps-queue.ts` and `chrome-extensions/maps-saver/background.js` (+ `manifest.json` host_permissions).

## Why this exists

Google doesn't expose a Saved Places write API. The earlier Playwright approach (drives a fresh Chromium with mounted auth state) breaks every few weeks when Google rotates the session, and was a constant maintenance burden. Running inside your real Chrome side-steps every layer of that fight — your session never expires, your cookies are always fresh, and Google has no signal that an automation is at work.

## Tradeoffs

- **Chrome must be running on your Mac** for saves to land. If Chrome's closed when you text the bot, the intent queues up and lands the moment you open Chrome.
- The extension runs in your Default profile. If you sign out of Google in Chrome, saves stop working until you sign back in.
- Background tabs flash open briefly (~3 sec) and auto-close. Not invisible, but not disruptive.

## Related

- `chrome-extensions/maps-saver/background.js` — service worker, polls queue
- `chrome-extensions/maps-saver/content-script.js` — DOM save flow
- `src/maps-queue.ts` — host-side HTTP server (port 7733)
- `container/skills/pp-google-maps/SKILL.md` — bot-side skill (will be updated to use this queue)
