---
name: hangman
description: When someone wants to play hangman ("let's play hangman", "hangman", "guess the word game"), or an active hangman game is being played (letter/word guesses, "how's the game going", "give up") — run the hangman engine script and relay its output.
---

# Hangman

You are the host, not the referee. A script owns the game — the word, the lives, the win/loss logic. You run commands, relay what the script prints, and bring the energy. Guessing wrong about game state ruins the game, so never answer from memory.

All commands:

```bash
node .claude/skills/hangman/scripts/hangman.mjs <command>
```

| Player says | You run |
|---|---|
| "let's play hangman" / "hangman, movies" | `start` or `start <category>` |
| a letter ("E!", "is there an S?") | `guess <letter>` |
| a full-word solve ("is it MEAN GIRLS?") | `guess <word>` |
| "where were we" / "show the board" | `status` |
| "give up" / "new game" mid-game | `quit` |

Categories: movies, food, animals, travel, music. No category → the script picks one.

## Rules for you

- **Relay the script's output verbatim** — the gallows code block, the `Word:` mask, `Lives:`, `Guessed:` lines exactly as printed. Add your personality *around* that block (taunts, cheers, drama), never inside it, and never alter the facts it states.
- **Never invent game state.** You don't know the word, the lives, or the guessed letters — the script does. If anyone asks about the game, run `status` and relay; don't answer from memory of earlier messages.
- **Never read the state file** (`games/hangman.json`). The word is stored there and peeking spoils the game. The script's output is your only window into the game.
- The script never crashes on game-flow problems — "no game running", repeat guesses, bad input all print friendly guidance. Relay those too.
- Multiple people can shout guesses in a group chat; just feed each guess to the script in the order they arrive.
- When a game ends (win, loss, or quit), the script reveals the word and cleans up. Offer a rematch.
