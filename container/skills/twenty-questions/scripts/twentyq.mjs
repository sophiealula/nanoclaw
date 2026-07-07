#!/usr/bin/env node
// 20 Questions engine for nanoclaw. All output is the chat-facing game display,
// EXCEPT `peek`, which is for the agent's eyes only (it reveals the secret).
// The agent relays everything else verbatim and adds flavor around it.
// Game-flow "errors" (no game, bad input) exit 0 with a friendly message.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STATE_DIR = process.env.GAMES_STATE_DIR || '/workspace/group/games';
const STATE_FILE = path.join(STATE_DIR, 'twentyq.json');
const SECRETS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'secrets.json',
);

const MAX_QUESTIONS = 20;
const NO_GAME_MSG =
  'No 20 Questions game running right now. Say *start* (categories: animals, people, things) to begin one!';

function loadSecrets() {
  return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
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

  const secrets = loadSecrets();
  const secret = decodeBase64(state.secret_b64);
  const categorySecrets = secrets[state.category];

  if (
    typeof state.category !== 'string' ||
    !Array.isArray(categorySecrets) ||
    !categorySecrets.some((entry) => entry.name === secret) ||
    !Array.isArray(state.questions) ||
    state.questions.length >= MAX_QUESTIONS ||
    !state.questions.every(
      (entry, index) =>
        entry &&
        typeof entry === 'object' &&
        Number.isInteger(entry.n) &&
        entry.n === index + 1 &&
        typeof entry.q === 'string' &&
        entry.q.trim().length > 0,
    )
  ) {
    throw new Error('bad state shape');
  }

  if (state.wrongGuesses === undefined) state.wrongGuesses = [];
  if (
    !Array.isArray(state.wrongGuesses) ||
    !state.wrongGuesses.every((guess) => typeof guess === 'string' && guess.trim().length > 0)
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

// Lowercase, strip accents, drop apostrophes, turn other punctuation into
// spaces, collapse whitespace, drop a leading article. "The Eiffel Tower!"
// and "eiffel tower" both land on "eiffel tower".
function normalize(text) {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

// Aliases live in secrets.json, not the state file — look the entry back up.
function aliasesFor(state, secret) {
  try {
    const list = loadSecrets()[state.category] || [];
    const entry = list.find((e) => e.name === secret);
    return entry ? entry.aliases : [];
  } catch {
    return [];
  }
}

function questionsUsed(state) {
  return state.questions.length;
}

function warningLine(n) {
  const left = MAX_QUESTIONS - n;
  if (left <= 0 || left > 5) return null;
  return left === 1 ? 'Only *1* question left — make it count!' : `Only *${left}* questions left!`;
}

function revealLine(secret) {
  return `I was thinking of: *${secret}*`;
}

function cmdStart(categoryArg) {
  const existing = loadState();
  if (existing) {
    console.log(
      [
        `There's already a 20 Questions game going (category: *${existing.category}*, ${questionsUsed(existing)}/${MAX_QUESTIONS} questions used).`,
        'Finish it, or say *quit* to end it and start fresh.',
      ].join('\n'),
    );
    return;
  }

  const secrets = loadSecrets();
  const categories = Object.keys(secrets);
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

  const list = secrets[category];
  const secret = list[crypto.randomInt(list.length)].name;
  const state = {
    game: 'twentyq',
    secret_b64: Buffer.from(secret, 'utf8').toString('base64'),
    category,
    questions: [],
    wrongGuesses: [],
    startedAt: new Date().toISOString(),
  };
  saveState(state);

  console.log(
    [
      `*20 QUESTIONS* — category: *${category}*`,
      '',
      `I'm thinking of something... You get *${MAX_QUESTIONS}* yes/no questions to figure out what it is.`,
      'Ask away — I can answer *Yes*, *No*, *Sometimes*, or *Doesn\'t apply*. Name it when you\'re sure!',
    ].join('\n'),
  );
}

function cmdPeek() {
  const state = loadState();
  if (!state) {
    console.log(NO_GAME_MSG);
    return;
  }
  const secret = decodeSecret(state);
  console.log(
    [
      'AGENT EYES ONLY — never relay this output to the chat.',
      `Secret: ${secret} (category: ${state.category})`,
      'Answer the players\' questions honestly about this secret, and never say it until the game ends.',
    ].join('\n'),
  );
}

function endByReveal(secret, lead) {
  deleteState();
  console.log([lead, revealLine(secret), 'Say *start* for another round.'].join('\n'));
}

function cmdCount(rawText) {
  const state = loadState();
  if (!state) {
    console.log(NO_GAME_MSG);
    return;
  }
  const text = (rawText ?? '').trim();
  if (!text) {
    console.log('Count what? Pass the question text, e.g. count "is it alive?" — nothing was counted.');
    return;
  }

  const n = questionsUsed(state) + 1;
  state.questions.push({ n, q: text });
  const header = `*Question ${n} of ${MAX_QUESTIONS}:* "${text}"`;

  if (n >= MAX_QUESTIONS) {
    const secret = decodeSecret(state);
    endByReveal(secret, `${header}\nThat was the last question — game over!`);
    return;
  }

  saveState(state);
  const lines = [header];
  const warning = warningLine(n);
  if (warning) lines.push(warning);
  console.log(lines.join('\n'));
}

function cmdGuess(rawInput) {
  const state = loadState();
  if (!state) {
    console.log(NO_GAME_MSG);
    return;
  }

  const guess = normalize(rawInput);
  if (!guess) {
    console.log('Guess what, exactly? Try *guess octopus* — or keep asking questions.');
    return;
  }

  const secret = decodeSecret(state);
  const targets = [secret, ...aliasesFor(state, secret)].map(normalize);

  if (targets.includes(guess)) {
    const n = questionsUsed(state) + 1;
    deleteState();
    console.log(
      [
        `You got it! ${revealLine(secret)}`,
        `Solved in ${n} of ${MAX_QUESTIONS} questions. Say *start* for another round.`,
      ].join('\n'),
    );
    return;
  }

  state.wrongGuesses = state.wrongGuesses || [];
  if (state.wrongGuesses.includes(guess)) {
    console.log(`You already tried "${rawInput.trim()}" — no penalty, but it's still not that!`);
    return;
  }

  state.wrongGuesses.push(guess);
  const n = questionsUsed(state) + 1;
  state.questions.push({ n, q: `(guess) ${rawInput.trim()}` });

  if (n >= MAX_QUESTIONS) {
    endByReveal(secret, `Nope, it's not "${rawInput.trim()}" — and that was your last question. Game over!`);
    return;
  }

  saveState(state);
  const lines = [`Nope, it's not "${rawInput.trim()}"! That guess used up question ${n} of ${MAX_QUESTIONS}.`];
  const warning = warningLine(n);
  if (warning) lines.push(warning);
  console.log(lines.join('\n'));
}

function cmdStatus() {
  const state = loadState();
  if (!state) {
    console.log(NO_GAME_MSG);
    return;
  }
  const lines = [
    `*20 QUESTIONS* — category: *${state.category}*`,
    `Questions used: ${questionsUsed(state)}/${MAX_QUESTIONS}`,
  ];
  if (state.questions.length) {
    lines.push('');
    for (const { n, q } of state.questions) lines.push(`${n}. ${q}`);
  } else {
    lines.push('No questions asked yet — ask away!');
  }
  console.log(lines.join('\n'));
}

function cmdQuit() {
  const state = loadState();
  if (!state) {
    console.log("There's no 20 Questions game to quit. Say *start* to begin one!");
    return;
  }
  const secret = decodeSecret(state);
  deleteState();
  console.log(`Game ended. ${revealLine(secret)}\nSay *start* whenever you want another round.`);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'start':
    cmdStart(rest[0]);
    break;
  case 'peek':
    cmdPeek();
    break;
  case 'count':
    cmdCount(rest.join(' '));
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
    console.log(
      '20 Questions commands: start [animals|people|things] | count <question text> | guess <text> | status | quit | peek (agent only)',
    );
}
