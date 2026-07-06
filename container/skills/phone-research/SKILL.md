---
name: phone-research
description: Place an outbound phone call via ElevenLabs Conversational AI + Twilio to get info from a business, then report the answer back to Soph. Triggers on phrases like "call X and ask Y", "what does X cost", "find out from X", "is X open", "call my <contact> to <do thing>". For businesses with Google Places listings, fires the call without approval. For personal contacts or ambiguous targets, asks Soph to confirm with `go` first. Tries the target's website first if there's a chance the answer is published; only dials if needed.
allowed-tools: Bash(curl:*), Bash(jq:*), Bash(sleep:*), Bash(date:*), Bash(test:*), Bash(rm:*), Bash(mkdir:*), Read, Write, WebFetch, WebSearch, mcp__nanoclaw__send_message, mcp__nanoclaw__edit_obsidian
---

# Phone Research

Make outbound calls via ElevenLabs ConvAI + Twilio, get an answer, report back.

## Required env vars (set in host .env, passed through to container)

- `ELEVENLABS_API_KEY` — auth header `xi-api-key`
- `ELEVENLABS_AGENT_ID` — the ConvAI agent Soph configured ("Sophie's phone assistant")
- `ELEVENLABS_AGENT_PHONE_NUMBER_ID` — the linked Twilio number's ElevenLabs phone_number_id

If any of these are unset, abort immediately with: `"Phone research isn't configured — missing <var>. Set up in ElevenLabs dashboard + add to .env."` Don't try to dial without all three.

## Flow

### 1. Parse the request

From Soph's message, extract:
- **target**: the business or contact name (e.g. "DexaScan", "my dentist", "Joe's Pizza")
- **task**: what to ask / find out (e.g. "the price of a DEXA scan", "if they're open tonight")

If either is unclear, ask Soph ONE clarifying question. Don't guess.

**PII sanitization on `task` — REQUIRED before passing to the ElevenLabs agent:**
The `task` string ends up in `dynamic_variables.task` which the agent may read aloud or quote. STRIP from `task` before continuing:
- Phone numbers (any `\d{3}[- .]?\d{3}[- .]?\d{4}` patterns)
- Street addresses (numeric + street suffix)
- Card numbers / SSN-shaped strings (any `\d{4}`+ sequences that aren't dates)
- Email addresses

If Soph's message includes context like "they have my number 555-1234 on file" — REWRITE `task` to drop the number ("reschedule for next Thursday — they have my contact on file") and tell Soph in your reply: "Stripped your phone number from the task before sending — the agent doesn't need it."

### 2. Try the website first (skip the call if possible)

Many "what does X cost / is X open" questions are answerable from a website without dialing.

- `WebSearch` for the target + "site:<domain>" + the question keyword
- If a promising URL is found, `WebFetch` it with the task as the prompt
- **Pass criterion (strict):** the page must contain the *specific data point* Soph asked about — e.g. an actual dollar amount for the exact service she named, not a generic "pricing starts at" header. If the topic is on the page but the specific answer isn't, treat as "web didn't have it" and proceed to call.
- If the answer is clearly on the page, quote it verbatim + source URL. Use this message template:
  ```
  💻 Found it on <URL> — didn't need to call <target>.

  <verbatim answer>
  ```
  Then skip to step 7 (log as web-answer, not as a call).

If the website doesn't have it, or there's no website, proceed.

### 3. Resolve the phone number

In order:
1. Did Soph give a number in her message? Use it.
2. Did she give a known name that matches a contact in `/workspace/extra/vault/People/`? Check there.
3. `WebSearch` for `<target> phone number <city if known>` and parse the result.
4. If still nothing: ask Soph for the number. Don't dial a guess.

Validate the number is in E.164 format (`+1XXXXXXXXXX` for US). Fix if needed.

### 4. Classify: business or personal?

- **Business signals**: Google/Bing search result includes a Google Business listing, Yelp page, or "near me" results. Target name is a brand/store name. Soph said "the X" or "a X".
- **Personal signals**: target matches a contact in `/workspace/extra/vault/People/`. Soph used a possessive ("my dentist", "my mom", "Kari"). Number is from her contacts.

**Tiebreaker: ANY personal signal wins.** If a target has BOTH a Google Business listing AND matches a People/ entry (e.g. Soph's regular spot where she knows the owner) → treat as personal → approve-first.

- **Ambiguous (no signal either way)**: default to personal/approve-first (safer).

### 5a. Fire-and-return path (business only)

Skip to step 6. Dial immediately.

### 5b. Approve-first path (personal or ambiguous)

Send Soph this recap via `mcp__nanoclaw__send_message`:

```
About to call <target> at <number>.
Task: "<task>"
Reply `go` within 2 minutes to dial, or `cancel` to drop it.
```

Write a pending-state file `/workspace/group/.phone-pending.json`:
```json
{
  "created_at": "<ISO 8601>",
  "target": "<name>",
  "number": "<E.164>",
  "task": "<full task text>",
  "expected_token": "go"
}
```

End your turn. The skill picks back up when Soph's next message arrives.

**ALWAYS check pending-file age FIRST, before honoring `go`:**
1. `stat -f %m /workspace/group/.phone-pending.json` (or read `created_at` from the JSON). Compute age in seconds.
2. If age > 120 (2 min): delete the file, reply `"Confirmation window expired — say it again if you still want me to call."` STOP. Do not honor `go` on a stale file even if she typed it.
3. Only after the age check passes, branch on her message content:
   - Exact match `go` (case-insensitive, trimmed): proceed to step 6.
   - `cancel` / `nvm` / `nevermind` / anything that's not `go`: delete the pending file, reply `"Cancelled."`

### 6. Place the call

Rename `.phone-pending.json` → `.phone-in-flight.json` (atomic; abort if rename fails).

```bash
RESPONSE=$(curl -s -X POST \
  https://api.elevenlabs.io/v1/convai/twilio/outbound-call \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"agent_id\": \"$ELEVENLABS_AGENT_ID\",
    \"agent_phone_number_id\": \"$ELEVENLABS_AGENT_PHONE_NUMBER_ID\",
    \"to_number\": \"<E.164 number>\",
    \"conversation_initiation_client_data\": {
      \"dynamic_variables\": {
        \"task\": \"<task text>\",
        \"target_name\": \"<target>\"
      }
    },
    \"call_recording_enabled\": true,
    \"telephony_call_config\": { \"ringing_timeout_secs\": 45 }
  }")

CONVERSATION_ID=$(echo "$RESPONSE" | jq -r '.conversation_id // ""')
SUCCESS=$(echo "$RESPONSE" | jq -r '.success // false')
ERR_MSG=$(echo "$RESPONSE" | jq -r '.detail // .message // .error // "unknown error"')
```

If `$SUCCESS` is not `true` OR `$CONVERSATION_ID` is empty OR equals the literal string `"null"`:
- Delete `/workspace/group/.phone-in-flight.json`
- Reply to Soph: `"Call to <target> didn't initiate. ElevenLabs said: $ERR_MSG. Check the API key + agent config."`
- STOP. Do NOT retry.

(Note: `jq -r .conversation_id` returns the literal string `null` when the field is missing — explicit check required.)

### 6b. Poll until done

The call typically takes 1–3 minutes. Poll every 10s, up to 6 minutes total. **Use this loop EXACTLY — don't refactor to `while true`, don't change the cap, don't add escape hatches.**

```bash
for i in $(seq 1 36); do
  sleep 10
  CONV=$(curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" \
    https://api.elevenlabs.io/v1/convai/conversations/$CONVERSATION_ID)
  STATUS=$(echo "$CONV" | jq -r '.status // ""')
  test "$STATUS" = "done" -o "$STATUS" = "failed" && break
done
```

**On `STATUS = failed`:**
- `ERR=$(echo "$CONV" | jq -r '.metadata.error // .metadata.termination_reason // "unknown"')`
- Delete `/workspace/group/.phone-in-flight.json`
- Reply: `"Call to <target> failed: $ERR."` STOP. Do NOT retry.

**On loop exit without `done` or `failed` (6-min timeout):**
- Delete `/workspace/group/.phone-in-flight.json` ← critical, prevents stuck single-flight lock
- Reply: `"Call to <target> ran past 6 min — abandoning. Check the ElevenLabs dashboard for conversation $CONVERSATION_ID."` STOP.

### 6c. Extract the answer

`$CONV` (the full conversation response) contains:
- `transcript`: array of `{ role, message, time_in_call_secs }` turns
- `metadata.call_duration_secs`, `metadata.termination_reason`, `metadata.cost`

Read the agent's last few turns to extract the answer to the task. **Never fabricate.** If any of these are true, report what actually happened — don't dress it up as "got the answer":
- `termination_reason` indicates voicemail / answering machine → the agent leaves a callback message automatically. Report: "Got voicemail at <target>. Left a callback message — call may come back to your Twilio number, which forwards to your cell."
- The human said "I don't have that info" / "call back Tuesday" / "speak to manager" → quote what they said and ask Soph for next step
- Transcript ends with the human hanging up mid-question → say "They hung up before answering — want me to try again?"
- Agent got an answer that contradicts the task or sounds confused → flag uncertainty: "Agent reported: '<X>'. Not sure if that's the answer to your question — full transcript at <link>."

### 6d. Report to Soph

```
📞 Called <target> — got the answer.

<one-line direct answer to the task, e.g. "DEXA scan = $129 cash / $189 with insurance billing">

Duration: <Xm Ys>  ·  Cost: $<cost>
Full transcript: Reference/Phone-Calls.md (entry #<id>)
```

Brief. The Phone-Calls.md log has the full transcript for later reference.

### 7. Log the call

Append to `Reference/Phone-Calls.md` via `mcp__nanoclaw__edit_obsidian` (NEVER Write — sync conflicts):

If `Phone-Calls.md` doesn't exist, create_file first with frontmatter:
```
---
type: phone-calls-log
purpose: Chronological log of outbound calls placed by Andy via ElevenLabs. Each entry has task, target, outcome, full transcript.
---

# Phone Calls

<!-- New calls will be appended below this line. -->
```

Then `add_line` with the full entry:
```
## <YYYY-MM-DD HH:MM> — <Target> — <one-line outcome>

**Task:** <task text>
**Number called:** <E.164>
**Duration:** <Xm Ys>  ·  **Cost:** $<cost>
**Outcome:** <one-line summary>

**Transcript:**
> agent: <message>
> human: <message>
> agent: <message>
> ...

---
```

(Transcript turns are quoted, role-prefixed, in chronological order.)

**Web-first answer log entry** — use this template (parallel to the call template, just no phone metadata):
```
## <YYYY-MM-DD HH:MM> — <Target> — <one-line outcome>

**Task:** <task text>
**Source:** website (<URL>)
**Outcome:** <verbatim answer from the page>

---
```
Logs every research request — call or not.

### 8. Release lock

Delete `.phone-in-flight.json`.

## Hard rules

- **NEVER dial without all three env vars.** If `ELEVENLABS_API_KEY` / `ELEVENLABS_AGENT_ID` / `ELEVENLABS_AGENT_PHONE_NUMBER_ID` aren't set, abort. Don't half-attempt.
- **NEVER skip the approve-first gate for personal contacts.** Even if Soph sounds urgent — calling her dentist without a `go` is a high-blast-radius mistake.
- **NEVER retry a failed call automatically.** The call may have actually connected and dropped — retry = double-call the human. If a call fails, report and wait for Soph to say "try again."
- **NEVER share Soph's contact info, address, or payment details on the call.** The agent's system prompt should already enforce this; the skill reinforces by passing minimal `dynamic_variables` (just `task` + `target_name`, no PII).
- **NEVER lie about whether a call happened.** If the website answered it, say "Got the answer from <URL> — didn't need to call." Don't say "Called them" when you didn't.
- **One in-flight call per group.** If `.phone-in-flight.json` exists when a new "call X" request comes in, refuse and report the existing in-flight call.

## Failure modes

- **No phone number found** → ask Soph for it
- **API error (auth, rate limit)** → report the error message, suggest checking ElevenLabs dashboard
- **Voicemail picked up** → ElevenLabs agent leaves a short message stating the task + callback number `918-534-8157`, then hangs up. (Configured in the agent's system prompt.) Report back: "Got voicemail at <target>. Left a callback message — call may come into the Twilio number, which forwards to your cell."
- **Wrong number / disconnected** → report; ask Soph to verify
- **IVR maze the agent can't crack** → report what the agent got stuck on
- **Hold music indefinitely** → 6-minute total timeout catches this; report "On hold past 6 min; abandoning."
