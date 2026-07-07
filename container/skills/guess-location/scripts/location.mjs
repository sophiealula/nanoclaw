#!/usr/bin/env node
// Guess-the-location engine for nanoclaw. `start` drops a Google Street View
// photo of a mystery place into the state dir; players guess the landmark or
// the city. All output is the chat-facing game display — the agent relays it
// and adds flavor, never alters facts. The IMAGE: line is the path the agent
// must send with nanoclaw's send_image tool.
// Game-flow "errors" (no round, bad input) exit 0 with a friendly message.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STATE_DIR = process.env.GAMES_STATE_DIR || '/workspace/group/games';
const STATE_FILE = path.join(STATE_DIR, 'location.json');
const IMAGE_FILE = path.join(STATE_DIR, 'location-current.jpg');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCATIONS_FILE = path.join(SCRIPT_DIR, '..', 'data', 'locations.json');
// Fake mode (tests): copy a fixture jpg instead of hitting Google.
const FAKE_MODE = process.env.STREETVIEW_FAKE === '1';
const FIXTURE_FILE =
  process.env.STREETVIEW_FIXTURE ||
  path.join(SCRIPT_DIR, '..', '..', '..', 'tests', 'fixtures', 'streetview.jpg');

const MAX_WRONG = 6;
const MAX_SCORE = 5;
const START_ATTEMPTS = 5;
const NO_GAME_MSG =
  "No location round running right now. Say *start* and I'll drop you somewhere on Earth!";

function loadLocations() {
  return JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf8'));
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

// Returns { state, loc } or null. Corrupt/unparseable/mis-shapen state (or a
// secret that doesn't resolve to a real location) → friendly reset, never a
// traceback.
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const id = decodeBase64(state.secret_b64);
    const loc = loadLocations().find((l) => l.id === id);
    if (
      !loc ||
      !Array.isArray(state.wrongGuesses) ||
      !state.wrongGuesses.every((guess) => typeof guess === 'string' && guess.trim().length > 0) ||
      state.wrongGuesses.length >= MAX_WRONG ||
      !Number.isInteger(state.hintsUsed) ||
      state.hintsUsed < 0 ||
      state.hintsUsed > loc.hints.length
    ) {
      throw new Error('state shape invalid');
    }
    return { state, loc };
  } catch {
    deleteGame();
    console.log("Uh oh — the previous round's state file was corrupted, so I've reset it.");
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function deleteGame() {
  fs.rmSync(STATE_FILE, { force: true });
  fs.rmSync(IMAGE_FILE, { force: true });
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

function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const curr = [i];
    for (let j = 1; j < cols; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[cols - 1];
}

// Typo tolerance scales with the name: tiny names ("Oia") must be exact,
// short ones allow one edit, longer ones two. Otherwise "rio" wins Oia rounds.
function fuzzyThreshold(name) {
  if (name.length < 5) return 0;
  if (name.length < 8) return 1;
  return 2;
}

function score(state) {
  return Math.max(1, MAX_SCORE - state.hintsUsed);
}

function answerLine(loc) {
  return `It was *${loc.name}* — ${loc.city}, ${loc.country}.`;
}

function imageLine() {
  return `IMAGE: ${path.resolve(IMAGE_FILE)}`;
}

// Returns true (image saved), false (no imagery here — try another spot), or
// the metadata status string for key/quota problems where retrying is useless.
async function fetchStreetView(loc, key) {
  const at = `${loc.lat},${loc.lng}`;
  const meta = await fetch(
    `https://maps.googleapis.com/maps/api/streetview/metadata?location=${at}&radius=150&key=${key}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  const metaBody = await meta.json();
  if (metaBody.status === 'REQUEST_DENIED' || metaBody.status === 'OVER_QUERY_LIMIT') {
    return metaBody.status;
  }
  if (metaBody.status !== 'OK') return false;

  const img = await fetch(
    `https://maps.googleapis.com/maps/api/streetview?size=640x640&location=${at}&heading=${loc.heading}&fov=${loc.fov}&radius=150&key=${key}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!img.ok) return false;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(IMAGE_FILE, Buffer.from(await img.arrayBuffer()));
  return true;
}

async function pickAndDownload() {
  const locations = loadLocations();

  if (FAKE_MODE) {
    const loc = locations[crypto.randomInt(locations.length)];
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.copyFileSync(FIXTURE_FILE, IMAGE_FILE);
    return loc;
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.log(
      [
        "Street View isn't set up yet — the GOOGLE_MAPS_API_KEY environment variable is missing.",
        'Someone with keys to the bot needs to add a Google Maps API key (Street View Static API enabled) before we can play this one. Sorry!',
      ].join('\n'),
    );
    return null;
  }

  const tried = new Set();
  for (let attempt = 0; attempt < START_ATTEMPTS && tried.size < locations.length; attempt++) {
    let idx;
    do {
      idx = crypto.randomInt(locations.length);
    } while (tried.has(idx));
    tried.add(idx);
    const loc = locations[idx];
    try {
      const result = await fetchStreetView(loc, key);
      if (result === true) return loc;
      if (result !== false) {
        console.log(
          [
            `The Street View key looks misconfigured — Google answered ${result}.`,
            'Someone with keys to the bot should check the GOOGLE_MAPS_API_KEY setup (billing enabled, Street View Static API turned on). Retrying won\'t help until then, sorry!',
          ].join('\n'),
        );
        return null;
      }
    } catch {
      // network hiccup or timeout — try another spot
    }
  }
  console.log(
    "Street View is being difficult — I couldn't fetch imagery after several tries. Give *start* another go in a minute!",
  );
  return null;
}

async function cmdStart() {
  const active = loadState();
  if (active) {
    console.log(
      [
        `There's already a location round going (hints used: ${active.state.hintsUsed}/${active.loc.hints.length}, wrong guesses: ${active.state.wrongGuesses.length}/${MAX_WRONG}).`,
        'Finish it, or say *quit* to end it and start fresh.',
      ].join('\n'),
    );
    return;
  }

  const loc = await pickAndDownload();
  if (!loc) return;

  saveState({
    game: 'location',
    secret_b64: Buffer.from(loc.id, 'utf8').toString('base64'),
    wrongGuesses: [],
    hintsUsed: 0,
    startedAt: new Date().toISOString(),
  });

  console.log(
    [
      '*GUESS THE LOCATION*',
      '',
      "I've dropped you somewhere on Earth, Street View style. Name the place — the landmark or the city both count!",
      `Scoring: *${MAX_SCORE} points*, minus one per hint (never below 1). ${MAX_WRONG} wrong guesses ends the round.`,
      'Say *hint* for a clue, *guess <place>* to answer, *reveal* if you give up.',
      imageLine(),
    ].join('\n'),
  );
}

function cmdGuess(rawInput) {
  const active = loadState();
  if (!active) {
    console.log(NO_GAME_MSG);
    return;
  }
  const { state, loc } = active;

  const guess = normalize(rawInput);
  if (!guess) {
    console.log('Guess what, exactly? Try *guess paris* — or say *hint* for a clue.');
    return;
  }

  const targets = [loc.name, loc.city, ...loc.aliases].map(normalize);
  const name = normalize(loc.name);
  const correct = targets.includes(guess) || editDistance(guess, name) <= fuzzyThreshold(name);

  if (correct) {
    const pts = score(state);
    const hints = state.hintsUsed;
    deleteGame();
    console.log(
      [
        `*Correct!* ${answerLine(loc)}`,
        `Score: *${pts}/${MAX_SCORE}* (${hints} hint${hints === 1 ? '' : 's'} used). Say *start* to play again.`,
      ].join('\n'),
    );
    return;
  }

  if (state.wrongGuesses.includes(guess)) {
    console.log(`You already tried "${guess}" — no penalty, but it's still not there!`);
    return;
  }

  state.wrongGuesses.push(guess);
  if (state.wrongGuesses.length >= MAX_WRONG) {
    deleteGame();
    console.log(
      [
        `Nope — and that was wrong guess ${MAX_WRONG}/${MAX_WRONG}. The round is over!`,
        answerLine(loc),
        'Say *start* for another drop.',
      ].join('\n'),
    );
    return;
  }

  saveState(state);
  console.log(
    `Not "${rawInput.trim()}"! Wrong guesses: ${state.wrongGuesses.length}/${MAX_WRONG}. Say *hint* if you need a clue.`,
  );
}

function cmdHint() {
  const active = loadState();
  if (!active) {
    console.log(NO_GAME_MSG);
    return;
  }
  const { state, loc } = active;

  if (state.hintsUsed >= loc.hints.length) {
    console.log(
      `No more hints — you've had all ${loc.hints.length}! Take a swing with *guess <place>*.`,
    );
    return;
  }

  const hint = loc.hints[state.hintsUsed];
  state.hintsUsed += 1;
  saveState(state);
  console.log(
    [
      `*Hint ${state.hintsUsed}/${loc.hints.length}:* ${hint}`,
      `(Winning now is worth ${score(state)} point${score(state) === 1 ? '' : 's'}.)`,
    ].join('\n'),
  );
}

function endRound(loc, lead) {
  deleteGame();
  console.log([lead, answerLine(loc), 'Say *start* for another drop.'].join('\n'));
}

function cmdReveal() {
  const active = loadState();
  if (!active) {
    console.log(NO_GAME_MSG);
    return;
  }
  endRound(active.loc, 'Giving up already? Fine, mystery solved:');
}

function cmdQuit() {
  const active = loadState();
  if (!active) {
    console.log("There's no location round to quit. Say *start* to begin one!");
    return;
  }
  endRound(active.loc, 'Round ended.');
}

function cmdStatus() {
  const active = loadState();
  if (!active) {
    console.log(NO_GAME_MSG);
    return;
  }
  const { state, loc } = active;
  const wrong = state.wrongGuesses;
  console.log(
    [
      '*GUESS THE LOCATION* — round in progress',
      `Hints used: ${state.hintsUsed}/${loc.hints.length} — winning now is worth ${score(state)} point${score(state) === 1 ? '' : 's'}.`,
      `Wrong guesses (${wrong.length}/${MAX_WRONG}): ${wrong.length ? wrong.join(', ') : 'none yet'}`,
      'The photo is below if anyone needs a re-send:',
      imageLine(),
    ].join('\n'),
  );
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'start':
    await cmdStart();
    break;
  case 'guess':
    cmdGuess(rest.join(' '));
    break;
  case 'hint':
    cmdHint();
    break;
  case 'reveal':
    cmdReveal();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'quit':
    cmdQuit();
    break;
  default:
    console.log(
      'Guess-the-location commands: start | guess <place> | hint | reveal | status | quit',
    );
}
