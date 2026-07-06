# Google Maps Saver — Handoff

**What it does:** When Soph forwards a place rec in her main Telegram DM (e.g. *"Chloe rec'd Bar Tatu in Mexico City"*), NanoClaw recognizes it, confirms with her, and saves the place to the matching Google Maps **city list** — with the recommender's note attached to the pin. Supports batches (multiple places in one message).

**Status:** Working. Branch `feat/pp-google-maps` (not yet merged to `main`). Last real run (2026-05-26) succeeded: 1 saved + verified, 2 already-saved.

---

## Architecture (the important part)

There are **two save paths**. Path A is the one in use; Path B is deprecated but its mount/scaffolding still lingers.

### Path A — Chrome extension + host queue (CURRENT)

Google has no write API for Saved Places, and pure-Playwright logins get challenged hard and rotate out every few weeks. The fix: do the actual DOM clicks **inside Soph's real Chrome**, where the session never expires and Google sees no automation.

```
Telegram rec → container agent (pp-google-maps skill) → confirms with Soph
   → on "yes", writes intent JSON to queue:
        container: /home/node/.config/maps-queue/pending/<id>.json
        host:      ~/Library/Application Support/nanoclaw/maps-queue/pending/
   → host HTTP server (src/maps-queue.ts, 127.0.0.1:7733) serves the queue
   → Maps Saver Chrome extension polls every 4s, finds intent,
        opens a background Maps tab, content-script clicks Save → picks list
        → fills note → closes tab, POSTs outcome back to host
   → outcome written to results/<id>.json
   → skill polls results/, reports per-item outcome to Soph via Telegram
```

### Path B — Playwright auth-state (DEPRECATED, do not extend)

Original approach: in-container Claude drove `agent-browser` (Playwright) against a mounted `state.json` auth file produced by a headed host login. Removed in commit `23efc1b`. The SKILL.md no longer uses it. **Leftover scaffolding still present** (see Cleanup below) — the `google-maps/state.json` mount, `scripts/login.sh`, and the README in the skill dir all describe Path B and are stale.

---

## Components & files

| Piece | Path | Role |
|---|---|---|
| Bot skill | `container/skills/pp-google-maps/SKILL.md` | Pattern-matches recs, confirms, enqueues intents, polls results. Synced into container at `/home/node/.claude/skills/pp-google-maps/`. |
| Host queue server | `src/maps-queue.ts` | HTTP server on `127.0.0.1:7733`. Started from `src/index.ts:777`. Serves `pending/`, accepts outcome POSTs → `results/`. |
| Chrome extension | `chrome-extensions/maps-saver/` | `background.js` (polls queue), `content-script.js` (DOM save flow — Save button, list picker, note), `popup.*` (connection status), `manifest.json`, `install.sh` (auto-loads unpacked ext via macOS UI scripting). |
| Container mounts | `src/container-runner.ts` | Mounts `maps-queue/` **read-write** (~line 445) and legacy `google-maps/` **read-only** (~line 428). Both applied. |
| Queue data (host) | `~/Library/Application Support/nanoclaw/maps-queue/{pending,results}/` | Intent/outcome JSON. `pending/` empty = healthy. |

Two READMEs exist (`container/skills/pp-google-maps/README.md`, `chrome-extensions/maps-saver/README.md`). The skill README still documents the deprecated Playwright path and a "apply this mount snippet when ready" note that is **already applied** — treat it as stale; the extension README is current.

---

## Setup (one-time, on Soph's Mac)

1. NanoClaw must be running (it owns the `:7733` queue server).
2. Install the extension: `cd chrome-extensions/maps-saver && ./install.sh` (needs Accessibility access for Terminal). Manual fallback: `chrome://extensions/` → Developer mode → Load unpacked → select the folder.
3. Verify: click the extension icon → popup should say **"Connected ✓"**.
4. Smoke test from the main Telegram DM: `Eden rec'd Loulou in Brighton` → bot recaps → reply `yes` → a background Maps tab flashes open in Chrome → check phone Maps → Saved → Brighton.

**Requirements to keep saves landing:** Chrome running on the Mac and signed into the personal Google account. If Chrome is closed, intents queue and land when it reopens.

---

## Operating notes

- **Gated to the main DM only** — group-chat sends would leak recaps publicly. If a rec doesn't trigger, confirm it came via main DM.
- **Mandatory pending-file invariant:** before the recap, the skill MUST write `/workspace/group/.private/pp-google-maps/pending.json`. Without it, Soph's `yes` refers to nothing and saves are lost (this bug lost the Puesto/Georges/Cottage/Pavilions batch on 2026-05-22). Enforced with a hard abort in SKILL.md Sections 4–5.
- **List naming preserved exactly** — `Mexico City` stays `Mexico City`, not auto-shortened to `CDMX`. Creates the list if none exists for the city.
- **Outcome statuses** in `results/<id>.json`: `saved` (with `verified`, `note_attached`), `already-saved`, `error` (with `reason` + diagnostic dump).

---

## Known issues & maintenance

- **Maps DOM drift is the #1 fragility.** Google A/B-tests the Save button and list-picker dialog. If saves silently fail, the selectors live in `chrome-extensions/maps-saver/content-script.js` (~lines 35–95) and mirror `SKILL.md` Sections 5–6. The most recent commits (`53bcc54`, `d6d14a5`) hardened picker detection and batch saves after a `list-picker-dialog-not-found` error surfaced in diagnostics — that error is now resolved, but it's the canonical failure mode to watch.
- **Fail-loud on list mismatch** (commit `53bcc54`) — if the picked list doesn't match the intent, it errors rather than saving to the wrong list. Good; keep it.
- **Port collision:** if `:7733` is taken, change `MAPS_QUEUE_PORT` in **both** `src/maps-queue.ts` and `chrome-extensions/maps-saver/background.js`, plus `manifest.json` host_permissions.
- **Note attachment is best-effort** — a recent success showed `note_attached: false` while `status: saved`. The place lands even if the note step fails; worth a glance if notes matter.

---

## Cleanup / open items for next person

1. **Remove Path B scaffolding** now that the extension path is proven: the `google-maps/state.json` read-only mount in `src/container-runner.ts` (~lines 428–440), `container/skills/pp-google-maps/scripts/login.sh`, and the stale Playwright sections of `container/skills/pp-google-maps/README.md`. Leaving them risks future confusion about which path is live.
2. **Reconcile the skill README** with reality (drop the "apply mount snippet when ready" note — it's applied; drop the login ceremony).
3. **Merge `feat/pp-google-maps` to `main`** once the above is tidied — the feature is committed and working but still on the branch.
4. **Extension health is invisible to the container** (different network namespace). The skill only infers a problem from a stale `pending/` entry. A heartbeat from the extension → queue server would make "Chrome is closed / extension unloaded" detectable instead of a silent timeout.

## Pointers

- Sibling browser skill for reference: `container/skills/pp-instacart/` (same auth/confirmation/hard-rules pattern).
- Build/deploy reminder: host changes (`src/`) need `launchctl unload → npm run build → load`; container skill changes need `./container/build.sh`.
