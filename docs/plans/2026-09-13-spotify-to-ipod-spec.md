# Spotify Playlists → Click-Wheel iPod — Design Spec

**Status:** Draft for review
**Date:** 2026-09-13
**Scope:** iPod Classic (5th–7th gen), iPod Nano (1st–7th gen), iPod Shuffle (1st–4th gen). **Not** iPod Touch.

---

## Goal

Take a Spotify playlist and end up with those songs playable on a click-wheel iPod, kept in sync over time.

Spotify is the **source of truth for what music you want**. It is not the source of audio bytes. Audio comes from files you are already licensed to hold — CD rips, purchased downloads, existing library. Tracks with no match are reported as a buy-list, never fetched.

This boundary is the central design constraint, not a footnote. It is what separates this from the DRM-stripping "Spotify converter" category (AudiFab, TuneFab, DRmare, et al.), whose entire product is defeating Spotify's content protection. Everything below assumes the boundary holds.

---

## Decisions (locked)

1. **Spotify Web API for metadata only.** OAuth 2.0 Authorization Code + PKCE. Read scopes only.
2. **No audio acquisition inside the tool.** The missing-tracks output is a report with purchase links. A human buys.
3. **Two device-writer backends** behind one interface: iTunes/Music automation, and direct `iTunesDB` writing via libgpod. Neither dominates — see [Device writing](#5-device-writing-the-hard-part).
4. **SQLite state store.** Syncs are incremental and resumable. Full re-copy of a 160GB device is hours over USB 2.0 and is never the default path.
5. **The device database is backed up before every write.** Non-negotiable. libgpod-family tools have a history of eating libraries.
6. **Dry-run is a first-class mode**, not a debug flag.

---

## Architecture

```
┌─────────────┐
│ Spotify API │  playlists, tracks, ISRCs
└──────┬──────┘
       │ (metadata only)
       ▼
┌─────────────┐     ┌──────────────┐
│   Ingest    │────▶│  Normalize   │
└─────────────┘     └──────┬───────┘
                           ▼
┌──────────────┐    ┌──────────────┐
│ Local library│───▶│   Resolve    │──┬──▶ matched
│    index     │    │ (match       │  ├──▶ ambiguous → review queue
└──────────────┘    │  cascade)    │  └──▶ missing   → buy-list report
                    └──────────────┘
                           │ matched
                           ▼
                    ┌──────────────┐
                    │  Transcode   │  FLAC/Opus → ALAC/AAC
                    │  + tag       │  gapless, artwork, Soundcheck
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │ DeviceWriter │  ── iTunes COM / Music.app
                    │  (interface) │  └─ libgpod (iTunesDB)
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │  Reconcile   │  SQLite state, incremental diff
                    └──────────────┘
```

---

## 1. Ingest

### Auth

Authorization Code + PKCE. Spotify removed the implicit grant; do not build against it. Client secret is not required for PKCE, which means this can ship as a desktop app without embedding a secret.

Scopes: `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`.

Refresh tokens rotate — persist the new refresh token on every refresh or you will silently lose auth after a few days.

### Endpoints

| Purpose | Endpoint |
|---|---|
| User's playlists | `GET /v1/me/playlists` (paginated, 50/page) |
| Playlist contents | `GET /v1/playlists/{id}/tracks` (paginated, 100/page) |
| Liked Songs | `GET /v1/me/tracks` (paginated, 50/page) |

Use the `fields` parameter aggressively on the tracks endpoint. The default payload carries a large amount you will discard, and trimming it materially cuts sync time on a 5,000-track library.

### Fields captured per track

`id`, `name`, `artists[].name`, `album.name`, `album.artists[].name`, `album.release_date`, `disc_number`, `track_number`, `duration_ms`, `external_ids.isrc`, `explicit`, `added_at`, and the item's ordinal position in the playlist.

**ISRC is the highest-value field here.** The International Standard Recording Code identifies a specific recording, and where both sides have one, matching is near-exact. Two caveats that must be designed around rather than assumed away:

- Spotify's ISRCs are occasionally wrong, and frequently point at a *re-release* rather than the original master — so an ISRC match can land you on the 2011 remaster when your rip is the 1987 CD. Usually fine; occasionally audible.
- The same recording legitimately carries different ISRCs across territories and releases. A non-match is weak evidence of difference.

Treat ISRC as a strong prior, not a proof.

### Edge cases that must not crash the pipeline

| Case | Detection | Handling |
|---|---|---|
| Local file in playlist | `track.is_local == true` | No ID/ISRC/duration reliability. Match on title/artist only, low confidence, route to review. |
| Removed track | playlist item's `track` is `null` | Skip, log, count in report. |
| Region-unavailable | `track.is_playable == false` with market applied | Still ingest — you may well own the file even if Spotify can't serve it. |
| Podcast episode in playlist | `type == "episode"` | Skip with a note. Out of scope. |
| Duplicate track in one playlist | Same `id` twice | Preserve both positions; dedupe only at the file-copy layer. |

### Rate limiting

Spotify enforces a rolling window and returns `429` with `Retry-After`. Implement exponential backoff honouring that header. Do not parallelise aggressively — a single well-behaved worker with batched requests finishes faster than a fan-out that trips the limiter.

---

## 2. Normalize

Build a canonical `Track` record holding **both raw and normalized forms**. Raw drives tagging; normalized drives matching. Conflating them corrupts your metadata.

Normalization for matching:

- Unicode NFKD, strip combining diacritics, casefold
- Extract and separate featured artists (`feat.` / `ft.` / `featuring` / `with`) into a distinct field
- Normalize `&` ↔ `and`, strip punctuation, collapse whitespace
- Strip noise suffixes: `(Remastered 2011)`, `- 2009 Remaster`, `(Deluxe Edition)`, `[Explicit]`, `(Bonus Track)`

**The trap:** over-normalization collapses recordings that are genuinely different. `(Live at Wembley)`, `(Radio Edit)`, `(Acoustic)`, `(Instrumental)` and remix credits are *not* noise — they are the discriminator. If you strip them during candidate generation (reasonable, for recall), you must re-introduce them as scoring features, with a hard penalty for mismatch. A tool that cheerfully syncs the studio version when you asked for the live one is worse than one that reports a miss.

Maintain the noise-suffix list as data, not code. It will grow.

---

## 3. Local library index

Scan configured directories, extract tags, persist to SQLite.

Per file: `path`, `container`, `codec`, `bitrate`, `sample_rate`, `channels`, `duration_ms`, `artist`, `albumartist`, `album`, `title`, `track_number`, `disc_number`, `isrc`, `musicbrainz_recording_id`, `mtime`, `size`, `content_hash`.

Tag sources by format: ID3v2.3/2.4 (MP3), MP4 atoms (M4A/AAC/ALAC), Vorbis comments (FLAC/Ogg/Opus).

Two fields punch above their weight and are worth explicitly hunting for:

- **ISRC** — ID3 `TSRC` frame, Vorbis `ISRC`. Present on most MusicBrainz-tagged rips and many purchased downloads.
- **MusicBrainz Recording ID** — ID3 `UFID` with owner `http://musicbrainz.org`, or `MUSICBRAINZ_TRACKID`. Present if the user has ever run Picard. This is the single best matching key available, better than ISRC, because it identifies the recording rather than a release of it.

Re-scan incrementally on `mtime`+`size`; full re-index only on demand.

---

## 4. Resolve — the make-or-break stage

Match quality determines whether this tool is delightful or infuriating. Budget accordingly; this is where the engineering time actually goes.

### Match cascade, highest confidence first

| Tier | Key | Confidence |
|---|---|---|
| 1 | MusicBrainz Recording ID equality | Near-certain |
| 2 | ISRC equality | Very high |
| 3 | Normalized (artist, title, album) + duration within ±2s | High |
| 4 | Normalized (artist, title) + duration within ±2s | Good |
| 5 | Fuzzy token-set scoring + duration proximity | Scored |
| 6 | Acoustic fingerprint (Chromaprint/AcoustID) | Opt-in |

Tier 1 requires enriching the Spotify side — take the ISRC, look it up against MusicBrainz to get the Recording ID, cache the result aggressively (MusicBrainz asks for ≤1 req/sec and means it).

Tier 6 is the escape hatch for a badly-tagged library. Fingerprinting every file is slow and most users don't need it; offer it as a pass that runs only against the unmatched bucket.

### Scoring

Composite 0–1:

```
score = 0.35·artist + 0.35·title + 0.20·duration + 0.10·album
duration_component = max(0, 1 − |Δms| / 15000)
```

String components via token-set ratio (rapidfuzz or equivalent) — token-set handles reordering and extra tokens far better than plain Levenshtein, which matters for `"Artist feat. Other"` vs `"Artist & Other"`.

Apply a hard multiplicative penalty (×0.5 or lower) when version qualifiers disagree — live/studio, remix/original, acoustic/electric.

Bands:

- **≥ 0.92** → auto-accept
- **0.75 – 0.92** → review queue
- **< 0.75** → missing

**These numbers are a starting point, not a result.** Calibrate them against a hand-labelled sample of a few hundred tracks from a real library before trusting them. Ship the thresholds as config.

### On duration matching

Duration is the cheapest strong discriminator and also the most common source of false negatives. Spotify's durations and a CD rip's durations disagree routinely: leading/trailing silence is handled differently, gapless album tracks can drift a second or two, and some Spotify entries are simply wrong.

**Do not use a hard ±2s gate at tiers 3–4 without a fallback.** Better: widen to ±5s and let the scoring function express the penalty continuously. A hard gate turns a metadata quirk into a reported miss, and a user who knows they own the track loses confidence in the whole tool.

### Output buckets

- **matched** → proceed to transcode
- **ambiguous** → review queue: an interactive picker showing the Spotify track and the top 3 candidates with scores and the reason each scored as it did. Decisions persist so the same track is never re-asked.
- **missing** → buy-list

---

## 5. Acquire (report only)

Group missing tracks by album — buying the album is often cheaper per track and yields better-tagged files than single purchases.

Emit CSV/HTML with artist, album, track, and search links to licensed stores (Bandcamp, Qobuz, 7digital, Apple Music/iTunes Store). Optionally hit those stores' search APIs to produce direct product links rather than search URLs.

The tool never downloads. This is the boundary from the Goal section, enforced in code: there is no audio-fetching code path to accidentally enable.

---

## 6. Transcode and prepare

### Codec support by device

| Device | Supported |
|---|---|
| Classic 5th–7th gen | MP3 (≤320, VBR ok), AAC/ALAC in M4A, AIFF, WAV, Audible |
| Nano (varies by gen) | MP3, AAC, ALAC, AIFF, WAV; later gens add limited video |
| Shuffle | MP3, AAC, ALAC, AIFF, WAV |

**No FLAC. No Ogg. No Opus.** A FLAC library — which is what a careful ripper has — must be transcoded. ALAC preserves losslessness and the Classic plays it natively; AAC 256 saves roughly 4× the space.

### Capacity planning

Run this *before* transfer and warn. A 160GB Classic holds roughly 400–500 albums in ALAC versus several thousand at AAC 256. Users routinely discover this after a three-hour sync. Project the total, show it, make the codec choice explicitly rather than by default.

### Gapless — the under-documented failure mode

Gapless playback on the iPod depends on encoder delay/padding metadata travelling with the file:

- **AAC/M4A** — the `iTunSMPB` free-form atom
- **MP3** — the Xing/LAME header carrying encoder delay and padding

If you transcode and don't carry this through, gapless silently breaks. The album still plays; it just has a click between every track on *Dark Side of the Moon*, and the user blames the iPod. Verify the tag survives the transcode and assert on it.

### Other tagging

- **Artwork** — embed in the file, and separately generate the device's own thumbnails (see below).
- **Soundcheck** — the iPod's volume normalization reads the `iTunNORM` tag. Compute ReplayGain and write `iTunNORM` if consistent loudness is wanted across a library assembled from mixed sources. It usually is.
- Preserve album artist, disc number, compilation flag — these drive the iPod's browse hierarchy, and getting them wrong scatters a compilation across 14 artist entries.

---

## 7. Device writing (the hard part)

Abstract behind a `DeviceWriter` interface: `open()`, `backup_db()`, `add_track()`, `remove_track()`, `set_playlist()`, `commit()`, `close()`.

### Strategy A — automate iTunes / Music

**Windows:** iTunes 12.x exposes a COM API (`iTunes.Application`, `iTunesLib`). Drive it from Python via `pywin32`, or C#/PowerShell. Add files, build playlists, trigger sync.

**macOS:** Music.app via AppleScript/JXA. Works, but Apple has degraded click-wheel iPod support steadily since Catalina retired iTunes and moved sync into Finder. Classic sync from a modern macOS is flaky in ways that are not your bug and not your fix.

- **Pro:** Apple writes the database. Hashing, artwork formats, per-model quirks all handled. Effectively cannot brick the library.
- **Con:** requires the app installed and running, GUI-dependent, slow, brittle automation surface.

### Strategy B — write `iTunesDB` directly

Reference implementation is **libgpod** (C, with Python bindings). Lineage: gtkpod, Rhythmbox, Amarok.

The database lives at `/iPod_Control/iTunes/iTunesDB` — nested chunks with four-character magic headers:

| Magic | Meaning |
|---|---|
| `mhbd` | Database header |
| `mhsd` | Dataset (tracks / playlists / podcasts) |
| `mhlt` / `mhit` | Track list / track item |
| `mhod` | String or data object (title, artist, album, path; also smart-playlist rules) |
| `mhlp` / `mhyp` / `mhip` | Playlist list / playlist / playlist item |

Two structural quirks that surprise people:

- **Paths use colon separators** — `:iPod_Control:Music:F07:ABCD.mp3` — an HFS-era holdover.
- **Files are scattered across `F00`–`F49`** with random four-character names. This is deliberate: it avoids pathologically large directories on the volume. **Identity lives in the database, not the filename.** Never try to infer library state from the filesystem.

#### The hash problem

This is the reason third-party iPod tools have a reputation for mysteriously producing an empty device.

Starting with the 2007 models, Apple added a firmware-validated checksum over the database. Mismatch → the iPod reports zero songs, with no error, despite the files being present.

- **`hash58`** (offset 0x58 in `mhbd`) — the first wave, covering **iPod Classic** and Nano 3rd/4th gen. Reverse-engineered and implemented in libgpod. Requires the device's `FirewireGuid`, read from `SysInfoExtended` on the device (libgpod ships `ipod-read-sysinfo-extended`, which pulls it over SCSI inquiry).
- **`hashAB`** (offset 0xAB) — later firmware, keyed, substantially harder. libgpod's support is incomplete. This is precisely why "gtkpod wrote my Nano 7 and it shows empty" is a perennial complaint.

**For the iPod Classic — the device in scope — `hash58` applies and libgpod handles it.** Strategy B is genuinely viable for a Classic. Confirm `SysInfoExtended` is present on the device during `open()` and fail loudly if it isn't, rather than writing a database the firmware will reject.

#### Artwork

Stored separately under `/iPod_Control/Artwork/`: an `ArtworkDB` plus `F####_1.ithmb` files containing raw uncompressed thumbnail bitmaps in device-specific pixel formats (typically RGB565) at per-model dimensions. libgpod carries the model table and generates these. Getting dimensions wrong yields visible corruption, not a clean failure.

#### Shuffle is a different animal

The Shuffle uses `iTunesSD` (plus `iTunesStats`) — flat, ordered, no display, radically simpler. 2nd-gen `iTunesSD` is trivially writable. 3rd/4th gen added VoiceOver, which expects pre-rendered speech files for track and playlist names; without them the feature is silent but the device still plays.

### Recommendation

Support both. Default to **A on Windows** for safety. Offer **B via libgpod for the Classic** on Linux/macOS where a working iTunes isn't available — which, on any current Mac, is most of the time.

---

## 8. Reconcile and sync

SQLite state store mapping: Spotify track ID → resolved local file → on-device track ID (`mhit` unique ID / dbid) → playlist memberships.

On re-run: diff the playlist against state, compute the minimal add/remove/reorder set, apply only that. Never re-copy a file already present. A full 160GB sync over USB 2.0 at roughly 25 MB/s is several hours; an incremental sync should be seconds.

Playlist order comes from `mhip` positions — preserve Spotify's ordering.

When a track leaves a Spotify playlist, remove it from the iPod playlist but **keep the file by default**. It's the user's own music; deleting it because a playlist changed is presumptuous and slow to undo.

---

## Cross-cutting requirements

**Safety**
- Copy `iTunesDB` (and `ArtworkDB`) aside before any write. Keep the last N backups with a one-command restore.
- Verify free space before copying; a full device mid-sync is a bad state to recover from.
- Never write without a successful `SysInfoExtended` read on hash58-era devices.

**Robustness**
- Idempotent operations; a sync interrupted mid-copy resumes cleanly.
- Dry-run mode showing the exact plan: files to copy, bytes, projected free space, playlist deltas.

**Environment**
- Mac-formatted iPods are HFS+ — needs `hfsprogs` on Linux; native on macOS. Windows-formatted are FAT32 and universally readable. Detect and report; don't assume.
- The Classic's 1.8" ATA drive is slow and spins down. Long syncs stall in ways that look like hangs. Surface progress per file, not per sync.

---

## Milestones

| # | Deliverable | Proves |
|---|---|---|
| M0 | Spotify OAuth + playlist dump to JSON | Auth and ingest work |
| M1 | Library indexer + match cascade, report only | **Match quality — the real risk.** Measure on a labelled sample before building further. |
| M2 | Review queue UI for the ambiguous bucket | Humans can resolve what the matcher can't |
| M3 | Transcode + tag pipeline, gapless assertions | Files are device-ready |
| M4 | `DeviceWriter` — iTunes COM backend | End-to-end on Windows |
| M5 | `DeviceWriter` — libgpod backend, hash58 | End-to-end on Linux/macOS for Classic |
| M6 | Incremental reconcile | Usable repeatedly rather than once |

**M1 is the gate.** If match rates on a real library are poor, no amount of device-writing polish saves the product. Measure before proceeding.

---

## Open questions / risks

1. **Match rate on a real library is unknown.** The whole value proposition rests on it. Needs measurement at M1 against an actual collection, not a synthetic one.
2. **`hashAB` blocks late Nanos.** Nano 6/7 may be unreachable via Strategy B. Acceptable if Classic is the target; a hard limit to state up front rather than discover.
3. **macOS Finder sync quality is outside our control** and has trended downward. The honest recommendation for a Classic may be "keep a Windows box or a pinned old macOS VM," which is a product answer, not an engineering one.
4. **Spotify API terms** permit metadata use but constrain redistribution and derived datasets. Worth a read before any distribution beyond personal use.
5. **Transcoding lossless → lossy is destructive and one-way.** Never transcode in place; always write to a device-staging directory and keep originals.
6. **Version disambiguation may need a user preference** — "prefer original over remaster" vs "prefer whatever matches Spotify" is a genuine taste question with no correct default.

---

## Explicitly out of scope

- Any extraction, decryption, capture, or recording of Spotify audio streams. The tool reads metadata via the official API and reads audio only from files already on the user's disk. There is no audio-acquisition code path.
- iPod Touch (runs the Spotify app natively; no problem to solve).
- Video, podcasts, audiobooks, Audible.
- Playlist *writing* back to Spotify.
