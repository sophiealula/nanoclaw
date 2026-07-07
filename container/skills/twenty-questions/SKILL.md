---
name: twenty-questions
description: When someone wants to play 20 questions ("let's play 20 questions", "think of something and we'll guess"), or an active game is running (yes/no questions about the secret, "is it a...?" guesses, "how many questions left") — run the 20 questions engine and play the answerer.
---

# 20 Questions

You are the answerer. A script owns the game — it picks the secret, counts the questions, and judges guesses. You learn the secret via `peek`, answer honestly, and never leak it. One careless adjective ruins the game.

All commands:

```bash
node .claude/skills/twenty-questions/scripts/twentyq.mjs <command>
```

| Player says | You run |
|---|---|
| "let's play 20 questions" / "20 questions, animals" | `start` or `start <category>`, then `peek` |
| a yes/no question ("is it alive?") | `count "is it alive?"` — then answer |
| a final guess ("is it an octopus?") | `guess octopus` |
| "how many questions left" / "what have we asked" | `status` |
| "we give up" | `quit` |

Categories: animals, people, things. No category → the script picks.

## The protocol

1. **Start:** run `start` (with category if given), relay its output, then immediately run `peek` ONCE and memorize the secret. `peek` output is for your eyes only — never relay, quote, or hint at it. If you come back to an in-progress game and no longer have the secret in memory, run `peek` again, silently.
2. **Every question costs a slot.** When a player asks a yes/no question, run `count "<their question>"` BEFORE answering. Relay the `Question N of 20` line (and any warning), then give your answer. If their question isn't answerable with yes/no ("what color is it?"), ask them to rephrase it as a yes/no question and do NOT run `count` — it shouldn't cost a slot.
3. **Answer with ONLY one of:** *Yes* / *No* / *Sometimes* / *Doesn't apply*. Answer honestly, based on the secret. No elaboration, no "yes, and it's big!", no volunteering attributes — the fun is in the digging.
4. **Questions vs. guesses.** "Is it a sea creature?" is a question → `count` it and answer. "Is it an octopus?" names a specific thing → that's a final guess → run `guess octopus`. Singularize plural noun guesses before running `guess` ("is it penguins?" → `guess penguin`). When in doubt whether something is a guess, treat category-level probes as questions and only specific-name shots as guesses. Never confirm partial guesses yourself ("you're close!") — the script decides right or wrong.
5. **Giving up:** run `quit`, relay the reveal, and be gracious about it — they fought hard.

## Rules for you

- **Relay the script's output verbatim** (except `peek`). The question counter, warnings, win/loss reveals — exactly as printed. Add your personality around them, never alter the facts.
- **Never say, spell, rhyme, or hint at the secret** until the script reveals it (win, loss at 20, or quit). Refuse riffs like "first letter?" with a playful no — that's what the 20 questions are for.
- **Never read the state file** (`games/twentyq.json`) — use `peek` and `status`.
- The script never crashes on game-flow problems — no game running, empty guesses, repeat guesses all print friendly guidance. Relay those too. Repeated identical wrong guesses are free; wrong guesses otherwise consume a question slot.
- Multiple people can play at once; feed questions and guesses to the script in the order they arrive.
- Telegram formatting: `*single asterisks*` for bold, no headings, no markdown links.
