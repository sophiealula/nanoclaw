# pp-google-maps

Save a place to a Google Maps **city list** when Soph forwards a rec from Telegram (or any other channel).

Design doc: [`docs/plans/2026-05-22-pp-google-maps-design.md`](../../../docs/plans/2026-05-22-pp-google-maps-design.md)

## What it does

Soph texts something like:

> Chloe rec'd Bar Tatu in Mexico City

The in-container agent recognizes the pattern, verifies the place on Maps, and asks:

> Found Bar Tatu (Roma Norte, Ciudad de México).
> Existing list: "Mexico City"
> Note to attach: "Chloe recommended this"
>
> Reply `yes` to save, or `no` to drop.

On `yes`, the place is saved to the right city list with the comment attached as a note on the pin. If no list exists for that city, the agent creates one (preserving Soph's exact naming — `Mexico City` stays `Mexico City`, not auto-shortened to `CDMX`).

## How it works

Pure SKILL.md skill, no new binary. The in-container Claude drives Google Maps via the existing `agent-browser` (Playwright) CLI, using a Playwright auth state file mounted from the host.

| Layer | Path |
|---|---|
| In-container skill | `/home/node/.claude/skills/pp-google-maps/SKILL.md` (synced from this dir) |
| Auth state (host) | `~/Library/Application Support/nanoclaw/google-maps/state.json` |
| Auth state (container) | `/home/node/.config/google-maps/state.json` (read-write mount) |
| Login script | `scripts/login.sh` (runs on host, headed Chromium) |
| Container mount wired in | [`src/container-runner.ts`](../../../src/container-runner.ts) (`googleMapsHostDir`) |

## One-time setup

Run the login ceremony on your laptop (not in container):

```bash
./scripts/login.sh
```

What happens:

1. A headed Chromium window opens at maps.google.com.
2. You sign in to your **personal** Google account (not `sophie@2389.ai`).
3. Click around your Saved lists to confirm the session is healthy.
4. Press Enter in the terminal — the script saves Playwright state to the mount path.
5. Restart NanoClaw (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`) so the next container picks up the mount.

Re-run `./scripts/login.sh` whenever the in-container skill reports `"Maps session expired"`.

## Why headed login on host

Google detects pure-Playwright logins and challenges them harder than a real browser. Running headed on the host (with real user interaction for any CAPTCHA / "is this you" prompts) produces an auth state Google trusts.

The container then loads that state into a headless run — Google sees an existing logged-in session, no fresh login attempt.

## Test plan (after setup)

1. From your main Telegram chat, send: `Chloe rec'd Bar Tatu in Mexico City`
2. Agent should reply with a recap asking for `yes`/`no`.
3. Reply `yes`.
4. Open Google Maps on your phone — Bar Tatu should be on your Mexico City list with the note "Chloe recommended this".
5. Test a new-city flow: `save Loulou in Brighton, Eden told me about it` — agent should propose creating a new "Brighton" list.
6. Test detection guard: `where should we eat tonight?` — agent should NOT trigger the skill, just chat normally.

If detection misfires (triggers when it shouldn't), tighten the patterns in Section 1 of `SKILL.md`.

## Related

- `pp-instacart` — sibling browser-driven skill, similar auth/confirmation pattern (reference for hard-rules formatting)
- `agent-browser` — the underlying Playwright CLI both skills use
