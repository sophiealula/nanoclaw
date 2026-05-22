/**
 * Maps Queue HTTP server.
 *
 * The Chrome extension (chrome-extensions/maps-saver/) polls this server to
 * find pending Google Maps save intents from NanoClaw, performs them in
 * Sophie's real signed-in Chrome session, and POSTs the outcome back.
 *
 * Why this exists: Google blocks Playwright-driven Maps saves with bot
 * detection. Driving the same DOM from a Chrome extension inside Sophie's
 * real session bypasses every layer of that detection.
 *
 * Storage is filesystem-based so the in-container agent can write to the
 * queue via a bind-mount without needing network connectivity to the host.
 *
 *   ~/Library/Application Support/nanoclaw/maps-queue/
 *     pending/<id>.json     — save intent, written by container, read by ext
 *     results/<id>.json     — outcome, written by ext, read by container
 *
 * The server binds 127.0.0.1 only — no external exposure.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';

export const MAPS_QUEUE_PORT = 7733;

export function getMapsQueueDir(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'nanoclaw',
    'maps-queue',
  );
}

function ensureDirs(): void {
  const root = getMapsQueueDir();
  fs.mkdirSync(path.join(root, 'pending'), { recursive: true });
  fs.mkdirSync(path.join(root, 'results'), { recursive: true });
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function listPending(): unknown[] {
  const dir = path.join(getMapsQueueDir(), 'pending');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  // Sort by filename — filenames embed timestamp so this is also chronological.
  files.sort();
  const items: unknown[] = [];
  for (const f of files) {
    const item = readJson(path.join(dir, f));
    if (item) items.push(item);
  }
  return items;
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function recordResult(id: string, result: unknown): void {
  const root = getMapsQueueDir();
  const resultPath = path.join(root, 'results', `${id}.json`);
  const tmpPath = `${resultPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2));
  fs.renameSync(tmpPath, resultPath);
  // Remove from pending so the extension doesn't reprocess.
  const pendingPath = path.join(root, 'pending', `${id}.json`);
  try { fs.unlinkSync(pendingPath); } catch {}
}

export function startMapsQueueServer(): Server {
  ensureDirs();
  const server = createServer(async (req, res) => {
    const url = req.url ?? '';
    try {
      // GET /queue — return pending items as a JSON array.
      if (req.method === 'GET' && url === '/queue') {
        respondJson(res, 200, listPending());
        return;
      }

      // POST /queue/<id>/result — record the extension's outcome.
      const m = /^\/queue\/([\w.:-]+)\/result$/.exec(url);
      if (req.method === 'POST' && m) {
        const id = m[1];
        const body = await readBody(req);
        let result: unknown = {};
        try { result = JSON.parse(body); } catch { result = { raw: body }; }
        recordResult(id, result);
        logger.info({ id, result }, 'Maps queue result recorded');
        respondJson(res, 200, { ok: true });
        return;
      }

      // GET /queue/<id>/result — let the container skill poll for results.
      const rm = /^\/queue\/([\w.:-]+)\/result$/.exec(url);
      if (req.method === 'GET' && rm) {
        const id = rm[1];
        const resultPath = path.join(getMapsQueueDir(), 'results', `${id}.json`);
        if (!fs.existsSync(resultPath)) {
          respondJson(res, 404, { error: 'not-ready' });
          return;
        }
        const result = readJson(resultPath);
        respondJson(res, 200, result);
        return;
      }

      respondJson(res, 404, { error: 'not-found', url });
    } catch (err) {
      logger.error({ err }, 'Maps queue server error');
      respondJson(res, 500, { error: 'internal' });
    }
  });

  server.listen(MAPS_QUEUE_PORT, '127.0.0.1', () => {
    logger.info(
      { port: MAPS_QUEUE_PORT, dir: getMapsQueueDir() },
      'Maps queue server listening (127.0.0.1 only)',
    );
  });

  return server;
}
