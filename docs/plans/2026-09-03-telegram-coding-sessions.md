# Telegram Coding Sessions ("light up a session") Implementation Plan
> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** From the Telegram DM with NanoClaw, say "light up a session called foo" to start a real Claude Code session on Sophie's Mac in `~/projects/foo`, then chat with that session entirely in Telegram until "close the session".

**Architecture:** The NanoClaw host process (not the container) drives obra's `claude-session-driver` (`csd`), which runs a Claude Code worker inside tmux and exposes `launch` / `converse` / `status` / `stop` / `handoff`. Session commands are intercepted in `src/index.ts` `onMessage` before storage, mirroring the existing `/remote-control` handler. While a chat has a lit session, every non-command message is forwarded with `csd converse` and the worker's reply is sent back to the chat; the container agent never sees those messages. State (chat → lit session) persists in `data/lit-sessions.json` so it survives NanoClaw restarts; the tmux worker survives them on its own.

**Tech Stack:** TypeScript (Node, ESM), vitest, `child_process.spawn`, tmux, `claude-session-driver` v4 plugin (`csd`).

**Security posture (decided 2026-09-03):** the worker runs on the Mac with permissions bypassed. Mitigations: only the main group (`isMain`) can use session commands; project names are restricted to `^[a-z0-9][a-z0-9-]{0,39}$`; `cwd` is always `~/projects/<name>`; one lit session per chat.

**Prior art checked:** `src/remote-control.ts` (host-spawned `claude remote-control`, hands off to claude.ai/code — different UX, same interception pattern, reuse its style). No upstream NanoClaw skill does this.

* * *
## Task 0: Install csd on the host and grant consent (manual, ~5 min)
**Files:** none in repo.

**Step 1: Install the plugin**

```bash
claude plugin marketplace update superpowers-marketplace
claude plugin install claude-session-driver@superpowers-marketplace
```

**Step 2: Locate the launcher and record the path**

```bash
ls ~/.claude/plugins/cache/superpowers-marketplace/claude-session-driver/*/skills/driving-claude-code-sessions/scripts/csd
```

Expected: one path like `.../claude-session-driver/4.0.0/skills/driving-claude-code-sessions/scripts/csd`. The code in Task 1 globs this; no config needed unless it moves (then set `CSD_BIN` in `.env`).

**Step 3: Grant one-time consent (non-interactive is supported by csd's** `readLine`**)**

```bash
echo yes | ~/.claude/plugins/cache/superpowers-marketplace/claude-session-driver/*/skills/driving-claude-code-sessions/scripts/csd grant-consent
ls ~/.claude/.claude-session-driver-consent && echo consent-ok
```

**Step 4: Smoke test csd by hand**

```bash
CSD=$(ls ~/.claude/plugins/cache/superpowers-marketplace/claude-session-driver/*/skills/driving-claude-code-sessions/scripts/csd)
mkdir -p ~/projects/csd-smoke && $CSD launch csd-smoke ~/projects/csd-smoke
/tmp/csd-workers/bin/csd-smoke converse "Reply with exactly: pong" 120
/tmp/csd-workers/bin/csd-smoke stop
rmdir ~/projects/csd-smoke
```

Expected: `converse` prints `pong`. If launch hangs, check `tmux ls` and `which claude` from a shell with the launchd PATH (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`).

* * *
## Task 1: Command parser (pure function)
**Files:**

- Create: `src/session-driver.ts`
  
- Test: `src/session-driver.test.ts`
  

**Step 1: Write the failing test**

```ts
// src/session-driver.test.ts
import { describe, it, expect } from 'vitest';

import { parseSessionCommand } from './session-driver.js';

describe('parseSessionCommand', () => {
  it('parses light up with a name', () => {
    expect(parseSessionCommand('light up a session called foo-bar')).toEqual({ kind: 'light', name: 'foo-bar' });
    expect(parseSessionCommand('Light up a session named Foo')).toEqual({ kind: 'light', name: 'foo' });
    expect(parseSessionCommand('light up a session in letterboxd')).toEqual({ kind: 'light', name: 'letterboxd' });
    expect(parseSessionCommand('/lit foo')).toEqual({ kind: 'light', name: 'foo' });
  });

  it('parses light up without a name', () => {
    expect(parseSessionCommand('light up a session')).toEqual({ kind: 'light', name: null });
  });

  it('rejects unsafe names', () => {
    expect(parseSessionCommand('light up a session called ../etc')).toEqual({ kind: 'light', name: null });
    expect(parseSessionCommand('light up a session called "a b"')).toEqual({ kind: 'light', name: null });
  });

  it('parses close, status, handoff', () => {
    expect(parseSessionCommand('close the session')).toEqual({ kind: 'close' });
    expect(parseSessionCommand('/unlit')).toEqual({ kind: 'close' });
    expect(parseSessionCommand("what's lit")).toEqual({ kind: 'status' });
    expect(parseSessionCommand('whats lit?')).toEqual({ kind: 'status' });
    expect(parseSessionCommand('hand off the session')).toEqual({ kind: 'handoff' });
  });

  it('returns null for ordinary messages', () => {
    expect(parseSessionCommand('what did I bookmark today')).toBeNull();
    expect(parseSessionCommand('please light up the room')).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/session-driver.test.ts` Expected: FAIL, cannot find module `./session-driver.js`.

**Step 3: Write minimal implementation**

```ts
// src/session-driver.ts
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type SessionCommand =
  | { kind: 'light'; name: string | null }
  | { kind: 'close' }
  | { kind: 'status' }
  | { kind: 'handoff' };

export function parseSessionCommand(text: string): SessionCommand | null {
  const t = text.trim().replace(/[.!?]+$/, '');
  let m = t.match(/^(?:\/lit\s+(\S+)|light up a (?:coding |claude )?session(?:\s+(?:called|named|in|for|on)\s+(\S+))?)$/i);
  if (m) {
    const raw = (m[1] ?? m[2] ?? '').replace(/^["'`]|["'`]$/g, '').toLowerCase();
    return { kind: 'light', name: raw && NAME_RE.test(raw) ? raw : null };
  }
  if (/^(?:\/unlit|close (?:the )?session|end (?:the )?session)$/i.test(t)) return { kind: 'close' };
  if (/^what'?s lit$/i.test(t)) return { kind: 'status' };
  if (/^hand ?off(?: the session)?$/i.test(t)) return { kind: 'handoff' };
  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/session-driver.test.ts` Expected: PASS (5 tests).

**Step 5: Commit**

```bash
git add src/session-driver.ts src/session-driver.test.ts
git commit -m "session-driver: parse light-up / close / status / handoff commands"
```

* * *
## Task 2: State store and csd runner
**Files:**

- Modify: `src/session-driver.ts`
  
- Test: `src/session-driver.test.ts`
  

Design: one lit session per chat, stored in `DATA_DIR/lit-sessions.json` as `{ [chatJid]: LitSession }`. All csd invocations go through an injectable `runCsd(args, opts)` so tests never spawn tmux.

**Step 1: Write the failing tests**

Append to `src/session-driver.test.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', () => ({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sd-test-')) }));

import {
  _resetForTesting,
  _setRunnerForTesting,
  getLitSession,
  lightUp,
  sayToSession,
  closeSession,
  restoreLitSessions,
  projectDirFor,
} from './session-driver.js';

describe('lit sessions', () => {
  const calls: string[][] = [];
  let projectsRoot: string;

  beforeEach(() => {
    _resetForTesting();
    calls.length = 0;
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-projects-'));
    _setRunnerForTesting(async (args) => {
      calls.push(args);
      if (args[0] === 'launch') return { code: 0, stdout: `/tmp/csd-workers/bin/${args[1]}\n`, stderr: '' };
      if (args[1] === 'converse') return { code: 0, stdout: 'done: hello\n', stderr: '' };
      if (args[1] === 'status') return { code: 0, stdout: 'idle\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }, projectsRoot);
  });

  afterEach(() => fs.rmSync(projectsRoot, { recursive: true, force: true }));

  it('lightUp creates the project dir, git-inits it, launches a worker, and persists', async () => {
    const res = await lightUp('tg:1', 'foo');
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, 'foo', '.git'))).toBe(true);
    expect(calls[0].slice(0, 3)).toEqual(['launch', 'foo', path.join(projectsRoot, 'foo')]);
    expect(getLitSession('tg:1')?.name).toBe('foo');
    _resetForTesting();
    restoreLitSessions();
    expect(getLitSession('tg:1')?.name).toBe('foo');
  });

  it('lightUp refuses a second session in the same chat', async () => {
    await lightUp('tg:1', 'foo');
    const res = await lightUp('tg:1', 'bar');
    expect(res.ok).toBe(false);
    expect(getLitSession('tg:1')?.name).toBe('foo');
  });

  it('lightUp reuses an existing project dir without re-initialising git', async () => {
    fs.mkdirSync(path.join(projectsRoot, 'existing', 'src'), { recursive: true });
    const res = await lightUp('tg:1', 'existing');
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, 'existing', 'src'))).toBe(true);
  });

  it('sayToSession runs converse via the shim and returns stdout', async () => {
    await lightUp('tg:1', 'foo');
    const out = await sayToSession('tg:1', 'say hello');
    expect(out).toEqual({ ok: true, text: 'done: hello' });
    const converse = calls.find((c) => c[1] === 'converse')!;
    expect(converse[0]).toBe('/tmp/csd-workers/bin/foo');
    expect(converse).toContain('say hello');
  });

  it('closeSession stops the worker and clears state', async () => {
    await lightUp('tg:1', 'foo');
    const res = await closeSession('tg:1');
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c[0] === '/tmp/csd-workers/bin/foo' && c[1] === 'stop')).toBe(true);
    expect(getLitSession('tg:1')).toBeNull();
  });

  it('projectDirFor rejects names outside the allowlist', () => {
    expect(() => projectDirFor('../x')).toThrow();
    expect(() => projectDirFor('Foo')).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/session-driver.test.ts` Expected: FAIL, missing exports.

**Step 3: Write the implementation**

Append to `src/session-driver.ts`:

```ts
export interface LitSession {
  name: string;
  cwd: string;
  shim: string;
  chatJid: string;
  startedAt: string;
}

export interface RunResult { code: number; stdout: string; stderr: string; }
export type Runner = (args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

const STATE_FILE = path.join(DATA_DIR, 'lit-sessions.json');
const CONVERSE_TIMEOUT_S = 900; // 15 min per turn; csd's own default is 120s
let sessions: Record<string, LitSession> = {};
let projectsRoot = path.join(os.homedir(), 'projects');

function resolveCsdBin(): string {
  if (process.env.CSD_BIN) return process.env.CSD_BIN;
  const base = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'superpowers-marketplace', 'claude-session-driver');
  const versions = fs.existsSync(base) ? fs.readdirSync(base).sort() : [];
  const latest = versions[versions.length - 1];
  if (!latest) throw new Error('claude-session-driver plugin not installed (see docs/plans/2026-09-03-telegram-coding-sessions.md Task 0)');
  return path.join(base, latest, 'skills', 'driving-claude-code-sessions', 'scripts', 'csd');
}

// args[0] is either a csd top-level subcommand ('launch', 'list') or an absolute shim path.
const defaultRunner: Runner = (args, opts = {}) =>
  new Promise((resolve) => {
    const [head, ...rest] = args;
    const bin = head.startsWith('/') ? head : resolveCsdBin();
    const argv = head.startsWith('/') ? rest : [head, ...rest];
    const proc = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(() => proc.kill('SIGTERM'), opts.timeoutMs) : null;
    proc.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    proc.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ code: 1, stdout, stderr: String(err) }); });
  });
let runCsd: Runner = defaultRunner;

function saveState(): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(sessions, null, 2));
}

export function restoreLitSessions(): void {
  try { sessions = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { sessions = {}; }
  if (Object.keys(sessions).length) logger.info({ chats: Object.keys(sessions) }, 'Restored lit sessions');
}

export function getLitSession(chatJid: string): LitSession | null {
  return sessions[chatJid] ?? null;
}

export function projectDirFor(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`Invalid project name: ${name}`);
  const dir = path.join(projectsRoot, name);
  if (!path.resolve(dir).startsWith(path.resolve(projectsRoot) + path.sep)) throw new Error('Path escape');
  return dir;
}

function gitInit(dir: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
}

export async function lightUp(chatJid: string, name: string): Promise<{ ok: true; created: boolean; cwd: string } | { ok: false; error: string }> {
  const existing = sessions[chatJid];
  if (existing) return { ok: false, error: `"${existing.name}" is already lit here. Close it first.` };
  let cwd: string;
  try { cwd = projectDirFor(name); } catch (e: any) { return { ok: false, error: e.message }; }
  const created = !fs.existsSync(cwd);
  if (created) {
    fs.mkdirSync(cwd, { recursive: true });
    await gitInit(cwd);
    fs.writeFileSync(path.join(cwd, 'README.md'), `# ${name}\n\nStarted from Telegram on ${new Date().toISOString().slice(0, 10)}.\n`);
  }
  const res = await runCsd(['launch', name, cwd], { timeoutMs: 120_000 });
  const shim = res.stdout.trim().split('\n').pop() ?? '';
  if (res.code !== 0 || !shim.startsWith('/')) {
    logger.error({ name, cwd, code: res.code, stderr: res.stderr.slice(-500) }, 'csd launch failed');
    return { ok: false, error: `csd launch failed: ${res.stderr.trim().split('\n').pop() ?? 'unknown error'}` };
  }
  sessions[chatJid] = { name, cwd, shim, chatJid, startedAt: new Date().toISOString() };
  saveState();
  logger.info({ chatJid, name, cwd, shim }, 'Lit session started');
  return { ok: true, created, cwd };
}

export async function sayToSession(chatJid: string, text: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const s = sessions[chatJid];
  if (!s) return { ok: false, error: 'No lit session in this chat.' };
  const res = await runCsd([s.shim, 'converse', text, String(CONVERSE_TIMEOUT_S)], { timeoutMs: (CONVERSE_TIMEOUT_S + 30) * 1000 });
  if (res.code !== 0) {
    logger.warn({ chatJid, name: s.name, code: res.code, stderr: res.stderr.slice(-500) }, 'csd converse failed');
    return { ok: false, error: res.stderr.trim().split('\n').pop() || 'worker did not reply' };
  }
  return { ok: true, text: res.stdout.trim() || '(worker finished the turn with no text reply)' };
}

export async function sessionStatus(chatJid: string): Promise<string> {
  const s = sessions[chatJid];
  if (!s) return 'Nothing is lit here.';
  const res = await runCsd([s.shim, 'status'], { timeoutMs: 15_000 });
  return `${s.name} is lit (${res.stdout.trim() || 'unknown'}) in ${s.cwd}, since ${s.startedAt.slice(0, 16).replace('T', ' ')}.`;
}

export async function sessionHandoff(chatJid: string): Promise<string> {
  const s = sessions[chatJid];
  if (!s) return 'Nothing is lit here.';
  const res = await runCsd([s.shim, 'handoff'], { timeoutMs: 15_000 });
  return res.stdout.trim() || `tmux attach -t ${s.name}`;
}

export async function closeSession(chatJid: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const s = sessions[chatJid];
  if (!s) return { ok: false, error: 'Nothing is lit here.' };
  await runCsd([s.shim, 'stop'], { timeoutMs: 30_000 });
  delete sessions[chatJid];
  saveState();
  logger.info({ chatJid, name: s.name }, 'Lit session closed');
  return { ok: true, name: s.name };
}

/** @internal testing only */
export function _resetForTesting(): void { sessions = {}; }
/** @internal testing only */
export function _setRunnerForTesting(r: Runner, root: string): void { runCsd = r; projectsRoot = root; }
```

Note for the implementer: `git init` and README only happen when the directory did not exist. Existing projects under `~/projects` (e.g. `nanoclaw`) are opened as-is.

**Step 4: Run tests**

Run: `npx vitest run src/session-driver.test.ts` Expected: PASS (11 tests).

**Step 5: Commit**

```bash
git add src/session-driver.ts src/session-driver.test.ts
git commit -m "session-driver: lit-session state + csd launch/converse/stop runner"
```

* * *
## Task 3: Wire into the message loop
**Files:**

- Modify: `src/index.ts` (imports near line 62; `restoreRemoteControl()` call near line 667; `onMessage` near line 723)
  

**Step 1: Import and restore**

Next to the remote-control import:

```ts
import {
  closeSession,
  getLitSession,
  lightUp,
  parseSessionCommand,
  restoreLitSessions,
  sayToSession,
  sessionHandoff,
  sessionStatus,
} from './session-driver.js';
```

Directly after `restoreRemoteControl();`:

```ts
restoreLitSessions();
```

**Step 2: Add the handler next to** `handleRemoteControl`

```ts
  // Per-chat serial queue so two quick Telegram messages reach the worker in order.
  const litQueues = new Map<string, Promise<void>>();
  function enqueueLit(chatJid: string, job: () => Promise<void>): void {
    const prev = litQueues.get(chatJid) ?? Promise.resolve();
    const next = prev.then(job, job).catch((err) =>
      logger.error({ err, chatJid }, 'Lit session job error'),
    );
    litQueues.set(chatJid, next);
  }

  // "light up a session" — host-level Claude Code worker driven by csd. Main group only.
  async function handleLitSession(chatJid: string, msg: NewMessage): Promise<boolean> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) return false;
    const channel = findChannel(channels, chatJid);
    if (!channel) return false;
    const say = (text: string) => channel.sendMessage(chatJid, text);

    const cmd = parseSessionCommand(msg.content);
    const lit = getLitSession(chatJid);

    if (cmd?.kind === 'light') {
      if (!cmd.name) {
        await say('Name it: "light up a session called <name>" (lowercase letters, digits, dashes).');
        return true;
      }
      await say(`Lighting up ${cmd.name}…`);
      const res = await lightUp(chatJid, cmd.name);
      await say(
        res.ok
          ? `🔥 ${cmd.name} is lit (${res.created ? 'new project' : 'existing project'} at ${res.cwd}). Everything you send here now goes to that Claude Code session. Say "close the session" when done.`
          : `Couldn't light it: ${res.error}`,
      );
      return true;
    }
    if (cmd?.kind === 'close') {
      const res = await closeSession(chatJid);
      await say(res.ok ? `${res.name} closed. Back to normal.` : res.error);
      return true;
    }
    if (cmd?.kind === 'status') { await say(await sessionStatus(chatJid)); return true; }
    if (cmd?.kind === 'handoff') { await say(await sessionHandoff(chatJid)); return true; }

    if (!lit) return false;

    // Forward everything else to the worker while lit.
    enqueueLit(chatJid, async () => {
      const res = await sayToSession(chatJid, msg.content);
      await say(res.ok ? res.text : `⚠️ ${lit.name}: ${res.error}`);
    });
    return true;
  }
```

**Step 3: Intercept in** `onMessage`**, right after the remote-control block**

```ts
      // Lit coding sessions — intercept before storage so the container agent never sees them
      if (!msg.is_bot_message && (parseSessionCommand(trimmed) || getLitSession(chatJid))) {
        handleLitSession(chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Lit session command error'),
        );
        return;
      }
```

Implementer note: `handleLitSession` returns `false` only for non-main groups, which then fall through — but the `return` above already skipped storage. Make the intercept condition include the main-group check so non-main chats are unaffected:

```ts
      if (!msg.is_bot_message && registeredGroups[chatJid]?.isMain && (parseSessionCommand(trimmed) || getLitSession(chatJid))) {
```

**Step 4: Build and run the full suite**

Run: `npm run build && npm test` Expected: tsc exit 0; all vitest files pass (existing 16 + session-driver).

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "telegram: light up / drive / close a host Claude Code session via csd"
```

* * *
## Task 4: Tell the container agent about the phrases
**Files:**

- Modify: `groups/telegram_main/CLAUDE.md` (append a short section)
  

**Step 1: Add**

```markdown
## Coding sessions (host-handled)
"light up a session called <name>", "close the session", "what's lit", and "hand off" are handled by the NanoClaw host, not by you — you will never see those exact messages. If Soph asks for something like this in other words (e.g. "start a coding session for X"), reply with the exact phrase to use: `light up a session called x` (lowercase, dashes ok). Do not try to create projects yourself.
```

**Step 2: Commit**

```bash
git add groups/telegram_main/CLAUDE.md
git commit -m "telegram_main: point the agent at the host-handled light-up phrases"
```

* * *
## Task 5: Deploy and test end to end from Telegram (~10 min)
**Step 1: Restart the host**

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && npm run build && launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
tail -5 logs/nanoclaw.log
```

**Step 2: From Telegram, in order**

1. `light up a session called scratch-test` → expect "🔥 scratch-test is lit (new project at /Users/sophiedavis/projects/scratch-test)…"
  
2. `create hello.txt containing the single word hi, then tell me the file size` → expect a reply from the worker.
  
3. On the Mac: `cat ~/projects/scratch-test/hello.txt` → `hi`. `tmux ls` shows a `scratch-test` session.
  
4. `what's lit` → status line with `idle`.
  
5. `close the session` → "scratch-test closed. Back to normal."
  
6. `what did I bookmark today` → answered by the normal container agent (proves routing restored).
  
7. Clean up: `rm -rf ~/projects/scratch-test` (announce before running).
  

**Step 3: Restart survival**

Light one up, `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`, send another message → the worker still answers (tmux kept it; state file restored the mapping).

**Step 4: Commit any fixes, then update memory**

Add a `project` memory: how lit sessions work, csd path, the state file, and that workers run bypass-permissions on the Mac.

* * *
## Out of scope (deliberately)
- Separate Telegram forum topics per project.
  
- Streaming intermediate tool calls to Telegram (csd `read-events --follow` could do this later).
  
- Multiple lit sessions per chat.
  
- Auto-closing idle workers.
