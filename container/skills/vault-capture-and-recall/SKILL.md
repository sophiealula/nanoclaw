---
name: vault-capture-and-recall
description: Capture forwarded/pasted emails (or content Soph shares in chat) into her Obsidian vault under Trips / Reservations / Places, AND recall info from those files when she asks operational questions. Triggers on (capture) "save this", "save to my vault", forwarded email content, "label this", or detection of long pasted text that looks like a booking/itinerary/house-instructions email; AND on (recall) "what's the alarm code at <house>", "wifi at <place>", "walk me through arrival at <house>", "when's my <city> trip", "what's at <place>", "remind me about <thing>".
allowed-tools: Read, Write, Bash(ls:*), Bash(grep:*), Bash(cat:*), Bash(find:*), mcp__nanoclaw__send_message, mcp__nanoclaw__edit_obsidian, mcp__gsuite__gmail_get_message, mcp__gsuite__gmail_list_messages
---

# Vault Capture & Recall

Two flows: **capture** new info into the vault, and **recall** stored info to answer Soph's questions.

## The vault structure she relies on

```
/workspace/extra/vault/Reference/
├── Trips.md                 — trip metadata (when/where), auto-populated by trips-daily-scan
├── Reservations.md          — point-in-time bookings (dinners, events, salon, doctor)
└── Places/
    ├── Mom's San Diego House.md
    ├── <other houses she stays at>.md
    └── ...
```

Each Place file has a fixed section template — see `Mom's San Diego House.md` for the canonical example.

## CAPTURE flow

### Triggers
- Soph pastes the body of a forwarded email in chat
- She says: "save this" / "save to vault" / "remember this" / "log this"
- She forwards a long structured email that looks like booking confirmation / house ops / itinerary
- A scheduled scan picked up a Gmail `andy/save`-labeled message (this skill is invoked from the scheduled task too)

### Classify the content into ONE of four types

| Type | Signal | Routes to |
|---|---|---|
| **Trip** | flight/hotel/Airbnb/train confirmation; "your reservation for [city]"; multi-day date range; carrier domain (delta, united, marriott, airbnb, amtrak, etc.) | `Reference/Trips.md` |
| **Reservation** | OpenTable / Resy / Tock / Eventbrite / Ticketmaster / SeatGeek / salon / doctor / spa; single point-in-time (date+time, one slot) | `Reference/Reservations.md` |
| **Place** | house-ops content (alarm codes, wifi, lock codes, utility shutoffs, where things are, who comes when); usually a forwarded email from a host/family; pertains to a specific physical location | `Reference/Places/<descriptive name>.md` (one file per house) |
| **Invoice / Receipt** | invoice, receipt, "payment received", "thank you for your purchase", "your order has been billed", any financial document with a vendor + amount + date | `Reference/Invoices.md` (chronological log) |

If ambiguous, ask Soph ONE clarifying question. Don't guess and route silently.

### After classification, write the entry

**For Trips** — append to `Trips.md` via `mcp__nanoclaw__edit_obsidian add_line` after the marker `<!-- New auto-detected trips will be appended below this line. -->`. Format:
```
## <City> — <date range>

- <transport / accommodation> — <provider> — confirmation <#>
- Source: <gmail msg id OR forwarded by Soph in chat>

---
```

**For Reservations** — append to `Reservations.md`. If the file doesn't exist yet, create it with a frontmatter header first. Format:
```
## <Restaurant/event name> — <date> @ <time>

- <party size / seat / details>
- Address: <if known>
- Source: <gmail msg id OR Soph in chat>

---
```

**For Places** — IF a file already exists for this place (grep `Reference/Places/` for the city/owner), UPDATE the relevant sections using `edit_obsidian replace_line` or `add_line`. Otherwise CREATE a new file using the **section template below**. Use `Write` tool for create (Places/ is not the synced vault root — wait, it IS under the vault; use `edit_obsidian create_file` with `dir: "Reference/Places"`).

**For Invoices / Receipts** — if `Reference/Invoices.md` doesn't exist, create it via `edit_obsidian create_file` with the template at the bottom of this skill. Then append via `edit_obsidian add_line`:
```
## <Vendor name> — <YYYY-MM-DD> — $<amount>

- <what was billed / item or service description>
- Invoice #: <if present>
- Account: <default OR personal — which gmail it came from>
- Source: gmail msg <id>

---
```
Newest at bottom (chronological append-only).

**Place section template** — every Place file looks like this:
```markdown
---
type: place
city: <city>
captured: <YYYY-MM-DD>
source: <how it was captured>
---

# <House name> — <city>

**Address:** <if known, else "_not yet specified_">
**Owner / context:** <who owns it, why Soph stays there>

## Access & Codes
- Alarm OFF / ON codes, key location, path from door to panel, time pressure

## Utilities
- Water shutoff, gas, breaker box, anything you have to do on arrival/departure

## Wi-Fi
- SSID, password location

## What's Where
- Layout, which rooms are guest-ready, where supplies live, what's OK to use vs. not

## Routines (people who show up)
- Name — role — typical day/time

## Streaming / Entertainment
- TV, services, anything she's allowed to use

## Notes / Quirks
- Free-form: anything that doesn't fit above
```

**HARD RULE — never lie about the write.** Do NOT say "Saved!" / "Logged!" / "Added!" until the actual `edit_obsidian` / `Write` call has returned successfully. If you're asking a clarifying question first, say `"Got it — I'll save it to <file> once you confirm <question>."` (See past failure: 2026-05-19 the agent said "Added!" but never wrote anything to additions.md.)

### Confirm with Soph after writing

Short, one-line confirmation: `"Saved → Reference/Places/Mom's San Diego House.md (Access & Codes, Utilities, Wi-Fi sections populated)."` So she knows exactly what landed where.

## RECALL flow

### Triggers
- "What's the wifi at <place>"
- "What's the alarm code at <house>"
- "Walk me through arrival at <house>"
- "When am I going to <city>" (also triggers — read Trips.md)
- "What's at <place>"
- "Remind me about <thing>" (broad — search across Trips, Reservations, Places)
- Any question that sounds like she's at a location and needs operational info

### Procedure

1. **Identify which file(s) to read.**
   - If question mentions a CITY: read `Trips.md` (find matching trip), then look in `Places/` for files matching that city.
   - If question mentions a HOUSE NAME or POSSESSIVE ("mom's", "the lake house"): grep `Places/` for matching files.
   - If question is about a date/time event ("dinner Friday"): read `Reservations.md`.
   - If unclear: read all three and synthesize.

2. **Read the file** with the `Read` tool. Do NOT scan all of Gmail for the answer — the vault is the answer cache.

3. **Answer narrowly.** If she asked for the wifi password, answer with just the wifi section content. Don't dump the whole file unless she asked "walk me through".

4. **If the file doesn't have the answer:**
   - First check: is the info just missing from the vault? Reply: "Vault doesn't have that — want me to ask you for it now and save it?"
   - DO NOT fall back to scanning Gmail unless she explicitly says so. Vault-first is the contract.

## Hard rules

- **Vault is the answer cache.** For trip dates, house ops, reservations: vault first, Gmail never (unless she explicitly asks).
- **Never lie about a write.** If you didn't actually call edit_obsidian/Write, don't say "saved."
- **Sensitive data in plaintext.** Alarm codes, wifi passwords, lock codes go in the vault in plaintext per Soph's explicit OK on 2026-05-19. Don't redact, don't ask permission per-entry.
- **One file per house.** Don't create multiple files for the same place. Grep before creating.
- **For Places, ALWAYS use the section template.** Don't invent ad-hoc structure — recall depends on consistent sectioning.
- **Cross-link when relevant.** When adding a new trip to Trips.md and a matching Place file exists, link to it: `## San Diego — May 22–25 → [[Places/Mom's San Diego House]]`. Same when capturing a new Place: if Trips.md has an upcoming trip to that city, add a back-link.
