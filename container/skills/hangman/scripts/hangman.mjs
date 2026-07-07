#!/usr/bin/env node
// Hangman engine for nanoclaw. All output is the chat-facing game display;
// the agent relays it verbatim and adds flavor around it.
// Game-flow "errors" (no game, bad input) exit 0 with a friendly message.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STATE_DIR = process.env.GAMES_STATE_DIR || '/workspace/group/games';
const STATE_FILE = path.join(STATE_DIR, 'hangman.json');
const WORDS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'words.json',
);

const MAX_LIVES = 6;

const GALLOWS = [
  `  +---+
  |   |
      |
      |
      |
      |
=========`,
  `  +---+
  |   |
  O   |
      |
      |
      |
=========`,
  `  +---+
  |   |
  O   |
  |   |
      |
      |
=========`,
  `  +---+
  |   |
  O   |
 /|   |
      |
      |
=========`,
  `  +---+
  |   |
  O   |
 /|\\  |
      |
      |
=========`,
  `  +---+
  |   |
  O   |
 /|\\  |
 /    |
      |
=========`,
  `  +---+
  |   |
  O   |
 /|\\  |
 / \\  |
=========`,
];

function loadWords() {
  return JSON.parse(fs.readFileSync(WORDS_FILE, 'utf8'));
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('bad encoded secret');
  }
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (!decoded || Buffer.from(decoded, 'utf8').toString('base64') !== value) {
    throw new Error('bad encoded secret');
  }
  return decoded;
}

function validateState(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('bad state shape');
  }

  const words = loadWords();
  const secret = decodeBase64(state.secret_b64);
  const categoryWords = words[state.category];

  if (
    typeof state.category !== 'string' ||
    !Array.isArray(categoryWords) ||
    !categoryWords.includes(secret) ||
    !Number.isInteger(state.lives) ||
    state.lives < 1 ||
    state.lives > MAX_LIVES ||
    !Array.isArray(state.guessed) ||
    !state.guessed.every((letter) => typeof letter === 'string' && /^[a-z]$/.test(letter)) ||
    new Set(state.guessed).size !== state.guessed.length ||
    isSolved(secret, state.guessed)
  ) {
    throw new Error('bad state shape');
  }

  if (state.wrongWords === undefined) state.wrongWords = [];
  if (
    !Array.isArray(state.wrongWords) ||
    !state.wrongWords.every(
      (word) => typeof word === 'string' && word.length > 0 && normalizeWord(word) === word,
    )
  ) {
    throw new Error('bad state shape');
  }

  return state;
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return validateState(state);
  } catch {
    deleteState();
    console.log("Uh oh — the previous game's state file was corrupted, so I've reset it.");
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function deleteState() {
  fs.rmSync(STATE_FILE, { force: true });
}

function decodeSecret(state) {
  return decodeBase64(state.secret_b64);
}

function gallowsBlock(lives) {
  return '```\n' + GALLOWS[MAX_LIVES - lives] + '\n```';
}

function mask(secret, guessed) {
  return secret
    .split('')
    .map((ch) => {
      if (ch === ' ') return '/';
      return guessed.includes(ch.toLowerCase()) ? ch.toUpperCase() : '_';
    })
    .join(' ');
}

function isSolved(secret, guessed) {
  return secret
    .toLowerCase()
    .split('')
    .every((ch) => ch === ' ' || guessed.includes(ch));
}

function render(state) {
  const secret = decodeSecret(state);
  const guessedLine = state.guessed.length
    ? state.guessed.map((l) => l.toUpperCase()).join(' ')
    : '(none yet)';
  return [
    gallowsBlock(state.lives),
    `Word: ${mask(secret, state.guessed)}`,
    `Lives: ${state.lives}/${MAX_LIVES}`,
    `Guessed: ${guessedLine}`,
  ].join('\n');
}

function normalizeWord(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z ]/g, '')
    .trim();
}

function cmdStart(categoryArg) {
  const existing = loadState();
  if (existing) {
    console.log(
      [
        `There's already a hangman game going (category: *${existing.category}*):`,
        '',
        render(existing),
        '',
        'Finish it, or say *quit* to end it and start fresh.',
      ].join('\n'),
    );
    return;
  }

  const words = loadWords();
  const categories = Object.keys(words);
  let category;
  if (categoryArg) {
    category = categories.find((c) => c.toLowerCase() === categoryArg.toLowerCase());
    if (!category) {
      console.log(
        `I don't have a *${categoryArg}* category. Pick one of: ${categories.join(', ')} — or just say *start* and I'll pick.`,
      );
      return;
    }
  } else {
    category = categories[crypto.randomInt(categories.length)];
  }

  const list = words[category];
  const secret = list[crypto.randomInt(list.length)];
  const state = {
    game: 'hangman',
    secret_b64: Buffer.from(secret, 'utf8').toString('base64'),
    category,
    guessed: [],
    wrongWords: [],
    lives: MAX_LIVES,
    startedAt: new Date().toISOString(),
  };
  saveState(state);

  console.log(
    [
      `*HANGMAN* — category: *${category}*`,
      '',
      render(state),
      '',
      'Guess a letter with *guess <letter>*, or go for broke with *guess <the whole thing>*.',
    ].join('\n'),
  );
}

function winMessage(state, secret) {
  return [
    'You got it! The word was: *' + secret.toUpperCase() + '*',
    `Lives left: ${state.lives}/${MAX_LIVES}. Say *start* for another round.`,
  ].join('\n');
}

function lossMessage(state, secret) {
  return [
    gallowsBlock(0),
    `Game over! The word was: *${secret.toUpperCase()}*`,
    'Rematch? Say *start*.',
  ].join('\n');
}

function cmdGuess(rawInput) {
  const state = loadState();
  if (!state) {
    console.log('No hangman game running right now. Say *start* (optionally with a category) to begin one!');
    return;
  }

  const input = normalizeWord(rawInput ?? '');
  if (!input) {
    console.log('Guess what, exactly? Try *guess e* or *guess the lion king*.\n\n' + render(state));
    return;
  }

  const secret = decodeSecret(state);

  if (input.length > 1) {
    // full-word guess
    if (input === normalizeWord(secret)) {
      deleteState();
      console.log(winMessage(state, secret));
      return;
    }
    state.wrongWords = state.wrongWords || [];
    if (state.wrongWords.includes(input)) {
      console.log(`You already tried "${input}" — no penalty, guess something else!\n\n` + render(state));
      return;
    }
    state.wrongWords.push(input);
    state.lives -= 1;
    if (state.lives <= 0) {
      deleteState();
      console.log(`Nope, it's not "${input}" — and that was the last life.\n` + lossMessage(state, secret));
      return;
    }
    saveState(state);
    console.log(`Nope, it's not "${input}"! That cost a life.\n\n` + render(state));
    return;
  }

  // single-letter guess
  const letter = input.toLowerCase();
  if (!/^[a-z]$/.test(letter)) {
    console.log(`"${input}" isn't a letter — guess a single letter (a-z) or the full word.\n\n` + render(state));
    return;
  }
  if (state.guessed.includes(letter)) {
    console.log(`You already tried *${letter.toUpperCase()}* — no penalty, pick another!\n\n` + render(state));
    return;
  }

  state.guessed.push(letter);

  if (secret.toLowerCase().includes(letter)) {
    if (isSolved(secret, state.guessed)) {
      deleteState();
      console.log(winMessage(state, secret));
      return;
    }
    saveState(state);
    console.log(`Nice — *${letter.toUpperCase()}* is in there!\n\n` + render(state));
    return;
  }

  state.lives -= 1;
  if (state.lives <= 0) {
    deleteState();
    console.log(`No *${letter.toUpperCase()}*... ` + lossMessage(state, secret));
    return;
  }
  saveState(state);
  console.log(`No *${letter.toUpperCase()}* in it, sorry!\n\n` + render(state));
}

function cmdStatus() {
  const state = loadState();
  if (!state) {
    console.log('No hangman game running right now. Say *start* (optionally with a category) to begin one!');
    return;
  }
  console.log(`*HANGMAN* — category: *${state.category}*\n\n` + render(state));
}

function cmdQuit() {
  const state = loadState();
  if (!state) {
    console.log("There's no hangman game to quit. Say *start* to begin one!");
    return;
  }
  const secret = decodeSecret(state);
  deleteState();
  console.log(`Game ended. The word was: *${secret.toUpperCase()}*\nSay *start* whenever you want another round.`);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'start':
    cmdStart(rest[0]);
    break;
  case 'guess':
    cmdGuess(rest.join(' '));
    break;
  case 'status':
    cmdStatus();
    break;
  case 'quit':
    cmdQuit();
    break;
  default:
    console.log('Hangman commands: start [category] | guess <letter or word> | status | quit');
}
