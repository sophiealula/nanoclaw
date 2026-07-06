---
name: make-podcast
description: Convert an Obsidian concept note into a two-voice podcast conversation — research, script, synthesize audio, deliver to Telegram.
---

# Make Podcast from Concept

Turn an Obsidian concept note into a two-voice conversational podcast and deliver it to Telegram.

## When to use

When someone asks you to "make a podcast about X", "turn X into a podcast", or "podcast episode on X".

## The flow

### 1. Find the concept in Obsidian

Search `/workspace/extra/concepts/` for matching files. Read the concept note and any `[[wiki-linked]]` related concepts to gather context.

If no matching concept exists, tell the user and ask if they want you to research it from scratch.

### 2. Research

Using the concept note(s) as primary source material, generate a thorough research brief. Build on the USER'S thinking — their angles, examples, and perspectives. Don't just research the topic generically.

Include: key facts, surprising insights, narrative arc suggestions, expert perspectives.

### 3. Write the script

Write a TWO-HOST conversational podcast script modeled on NotebookLM's style.

**Format:** Use `ALEX:` and `SAM:` labels. One speaker per turn.

**Here's a real example of the tone and structure to match:**

```
ALEX: You ever get that feeling like you're just drowning in information? Articles, PDFs, websites, all promising to unlock the secrets of the universe?
SAM: Or at least help you finally finish that research project you've been putting off.
ALEX: Exactly. It's like trying to drink from a fire hose, you know? I mean, I love learning new things, but who has the time to actually go through all of it?
SAM: Well, what if I told you that's exactly what we're diving into today?
ALEX: Wait, seriously?
SAM: Yeah. And get this, it just got a major upgrade. We're talking potential game changer here.
ALEX: Okay, you've got my attention. But let's back up a bit for our listeners. What exactly is this?
SAM: In a nutshell, imagine you're working on a project and you've got, you know, a ton of research.
ALEX: A mountain of research probably, let's be real.
SAM: Right, exactly. It's like having a super smart research assistant who not only reads it all but can answer any question you have.
```

**Key patterns:**
- One host introduces/explains, the other reacts and asks follow-ups. They swap roles throughout.
- Turns are typically 2-4 sentences. Occasionally a short reaction ("Wait, seriously?" or "That's wild.") but most turns have substance.
- Tone is warm and genuinely curious. Not academic, not hype.
- Light filler ("you know," "like") SPARINGLY — maybe 1 in 5 turns. The audio model handles natural speech, so don't overload the text with filler.
- Reactions are grounded: "Hold on." "That's wild." "Okay, now you're talking." Not breathless.
- Occasionally reference the listener.
- NO formal intro/sign-off. Start by jumping in, end on something that lingers.
- NO stage directions, sound cues, or parenthetical actions.
- Aim for ~1200-1500 words (~8-10 minutes).

Save the script to Obsidian:
```
edit_obsidian(action: "create_file", dir: "research", file: "Podcast - {Concept Name}.md", content: "...")
```

### 4. Synthesize audio and deliver

Save the script to a temp file and run the synthesis script:

```bash
cat > /tmp/podcast_script.txt << 'SCRIPT'
{paste the full script text here — including ALEX: and SAM: labels}
SCRIPT

node /home/node/.claude/skills/make-podcast/podcast-synth.mjs /tmp/podcast_script.txt "{Concept Name}" "{chat_id}"
```

The script automatically parses ALEX/SAM labels and uses different voices for each host:
- **Alex** → Alice voice (clear, engaging)
- **Sam** → Daniel voice (steady, grounded)

**Getting the chat ID:** The current chat's ID is in the message context. For the main Telegram chat, use `8535290004`.

### 5. Confirm

Tell the user the podcast has been delivered. Mention the length and that the script is saved in their Research folder.

## Environment variables needed

These must be in the container env:
- `ELEVENLABS_API_KEY` — from elevenlabs.io
- `TELEGRAM_BOT_TOKEN` — already configured
- `ELEVENLABS_MODEL_ID` (optional) — defaults to eleven_v3
