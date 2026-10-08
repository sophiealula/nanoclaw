import http from 'http';
import { URL } from 'url';
import { v4 as uuidv4 } from 'uuid';
import twilio from 'twilio';

import { ASSISTANT_NAME } from '../config.js';
import { setRegisteredGroup, getRegisteredGroup } from '../db.js';
import { readEnvFile } from '../env.js';
import { verifyTwilioSignature } from '../twilio-signature.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

const SPEECH_TIMEOUT = 'auto';
const MAX_SPEECH_LENGTH = 120;
const SPEECH_LANGUAGE = 'en-US';

const PERSONAL_JID = 'twilio-voice:personal';

// Inbound calls to the Twilio number are dialed through to the operator's own
// phone (TWILIO_FORWARD_TO_NUMBER in .env). The number's VoiceUrl points at
// `${WEBHOOK_BASE_URL}/voice/forward`, which returns TwiML that dials it.

// Abandoned calls (no /voice/status callback) must not accumulate forever.
const TRANSCRIPT_TTL_MS = 2 * 60 * 60 * 1000;

export type SignatureMode = 'off' | 'log' | 'enforce';

// Generate a short 800Hz sine wave tone as a WAV buffer (0.3s, 8kHz mono μ-law)
function generateToneWav(): Buffer {
  const sampleRate = 8000;
  const duration = 1.5;
  const freq = 800;
  const numSamples = Math.floor(sampleRate * duration);

  // PCM 16-bit samples
  const pcm = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Fade in/out over 20ms to avoid click
    const fade = Math.min(t / 0.02, (duration - t) / 0.02, 1);
    const sample = Math.round(fade * 16000 * Math.sin(2 * Math.PI * freq * t));
    pcm.writeInt16LE(sample, i * 2);
  }

  // WAV header
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

const TONE_WAV = generateToneWav();

interface TranscriptEntry {
  time: string;
  text: string;
}

// Per-call transcript buffers keyed by CallSid
const transcripts = new Map<
  string,
  { entries: TranscriptEntry[]; startedAt: Date }
>();

export class TwilioVoiceChannel implements Channel {
  name = 'twilio-voice';

  private server: http.Server;
  private port: number;
  private connected = false;
  private onMsg: OnInboundMessage;
  private onMeta: OnChatMetadata;

  private baseUrl: string;
  private authToken: string;
  private signatureMode: SignatureMode;
  private forwardTo: string | undefined;

  constructor(
    opts: ChannelOpts,
    port: number,
    baseUrl: string,
    security: {
      authToken: string;
      signatureMode?: SignatureMode;
      forwardTo?: string;
    },
  ) {
    this.onMsg = opts.onMessage;
    this.onMeta = opts.onChatMetadata;
    this.port = port;
    this.baseUrl = baseUrl;
    this.authToken = security.authToken;
    this.signatureMode = security.signatureMode ?? 'log';
    this.forwardTo = security.forwardTo;

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        this.connected = true;
        logger.info(
          { port: this.port },
          'Twilio Voice webhook server listening',
        );
        resolve();
      });
    });
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // Draft one: no voice response. Agent output goes to Obsidian only.
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('twilio-voice:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const pathname = url.pathname;

    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (pathname === '/voice/tone' && req.method === 'GET') {
      logger.info({ size: TONE_WAV.length }, 'Serving tone WAV');
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': String(TONE_WAV.length),
        'Cache-Control': 'no-cache',
      });
      res.end(TONE_WAV);
      return;
    }

    // Everything below is a Twilio webhook. The server is reachable through a
    // public tunnel, so every request must carry a valid X-Twilio-Signature —
    // otherwise anyone with the URL can inject text into a main-group agent or
    // use /voice/forward as a free call relay.
    if (pathname !== '/voice/forward' && req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    try {
      const params =
        req.method === 'POST' ? parseFormBody(await readBody(req)) : {};
      if (!this.checkSignature(req, url, params)) {
        res.writeHead(403);
        res.end();
        return;
      }

      if (pathname === '/voice/forward') {
        const from = params.From || url.searchParams.get('From') || 'unknown';
        if (!this.forwardTo) {
          logger.error(
            { from },
            'Inbound call but TWILIO_FORWARD_TO_NUMBER is not set',
          );
          res.writeHead(503);
          res.end();
          return;
        }
        logger.info({ from }, 'Inbound call → forwarding to operator phone');
        const twiml = new VoiceResponse();
        twiml.dial({ timeout: 25, answerOnBridge: true }, this.forwardTo);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(twiml.toString());
        return;
      }

      if (pathname === '/voice/incoming') {
        this.handleIncomingCall(params, res);
      } else if (pathname === '/voice/gather') {
        this.handleGather(params, res);
      } else if (pathname === '/voice/status') {
        this.handleStatus(params, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (err) {
      logger.error({ err, pathname }, 'Twilio webhook error');
      res.writeHead(500);
      res.end();
    }
  }

  /**
   * Validate X-Twilio-Signature. Twilio signs the public URL it called, so we
   * try the URL as seen through the tunnel (Host + X-Forwarded-Proto) and the
   * configured base URL. Mode `log` records mismatches without rejecting, so a
   * tunnel/URL mismatch can be spotted before switching to `enforce`.
   */
  private checkSignature(
    req: http.IncomingMessage,
    url: URL,
    params: Record<string, string>,
  ): boolean {
    if (this.signatureMode === 'off') return true;
    const signature = req.headers['x-twilio-signature'] as string | undefined;
    const pathAndQuery = url.pathname + url.search;
    const proto =
      (req.headers['x-forwarded-proto'] as string | undefined) || 'https';
    const candidates = [
      req.headers.host ? `${proto}://${req.headers.host}${pathAndQuery}` : null,
      `${this.baseUrl}${pathAndQuery}`,
    ].filter((u): u is string => !!u);
    const ok = candidates.some((u) =>
      verifyTwilioSignature(this.authToken, u, params, signature),
    );
    if (ok) return true;
    logger.warn(
      {
        path: url.pathname,
        mode: this.signatureMode,
        hasSignature: !!signature,
        candidates,
        remote: req.socket.remoteAddress,
      },
      'Twilio webhook signature mismatch',
    );
    return this.signatureMode !== 'enforce';
  }

  /**
   * /voice/incoming — Start silent listening.
   */
  private handleIncomingCall(
    params: Record<string, string>,
    res: http.ServerResponse,
  ): void {
    const callSid = params.CallSid;
    const from = params.From || 'unknown';

    logger.info({ callSid, from }, 'Incoming voice call');

    const cutoff = Date.now() - TRANSCRIPT_TTL_MS;
    for (const [sid, t] of transcripts) {
      if (t.startedAt.getTime() < cutoff) transcripts.delete(sid);
    }
    transcripts.set(callSid, { entries: [], startedAt: new Date() });

    this.onMeta(
      PERSONAL_JID,
      new Date().toISOString(),
      'Voice Line',
      'twilio-voice',
      false,
    );

    const toneUrl = `${this.baseUrl}/voice/tone`;
    logger.info({ toneUrl }, 'TwiML will reference tone URL');

    const twiml = new VoiceResponse();
    const gather = twiml.gather({
      input: ['speech'],
      action: '/voice/gather',
      method: 'POST',
      speechTimeout: SPEECH_TIMEOUT,
      speechModel: 'experimental_conversations',
      language: SPEECH_LANGUAGE,
      timeout: MAX_SPEECH_LENGTH,
    });
    gather.play(toneUrl);
    // If gather times out with no speech, hang up
    twiml.hangup();

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }

  /**
   * /voice/gather — Buffer transcribed speech, loop back to listen.
   */
  private handleGather(
    params: Record<string, string>,
    res: http.ServerResponse,
  ): void {
    const callSid = params.CallSid;
    const speechResult = params.SpeechResult;
    const confidence = params.Confidence;

    if (speechResult) {
      const now = new Date();
      const time = now
        .toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
        })
        .toLowerCase();

      logger.info(
        { callSid, speechResult, confidence },
        'Speech chunk buffered',
      );

      const transcript = transcripts.get(callSid);
      if (transcript) {
        transcript.entries.push({ time, text: speechResult });
      }
    }

    // Loop: gather more speech
    const twiml = new VoiceResponse();
    const gather = twiml.gather({
      input: ['speech'],
      action: '/voice/gather',
      method: 'POST',
      speechTimeout: SPEECH_TIMEOUT,
      speechModel: 'experimental_conversations',
      language: SPEECH_LANGUAGE,
      timeout: MAX_SPEECH_LENGTH,
    });
    gather.say({ voice: 'Polly.Matthew' }, '');
    twiml.hangup();

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }

  /**
   * /voice/status — On call end, send full transcript to agent.
   */
  private handleStatus(
    params: Record<string, string>,
    res: http.ServerResponse,
  ): void {
    const callSid = params.CallSid;
    const status = params.CallStatus;
    const from = params.From || 'unknown';

    logger.info({ callSid, status }, 'Call status update');

    if (
      status === 'completed' ||
      status === 'failed' ||
      status === 'busy' ||
      status === 'no-answer'
    ) {
      const transcript = transcripts.get(callSid);
      transcripts.delete(callSid);

      if (transcript && transcript.entries.length > 0) {
        const startedAt = transcript.startedAt;
        const dateStr = startedAt.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
        const timeStr = startedAt
          .toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          })
          .toLowerCase();

        const lines = transcript.entries.map((e) => e.text).join('\n');

        const message = [
          `Call ended. Process this transcript and save to Obsidian.`,
          ``,
          `Date: ${dateStr}`,
          `Time: ${timeStr}`,
          `From: ${from}`,
          `Duration: ${transcript.entries.length} speech segments`,
          ``,
          `--- TRANSCRIPT ---`,
          lines,
          `--- END TRANSCRIPT ---`,
        ].join('\n');

        this.onMsg(PERSONAL_JID, {
          id: uuidv4(),
          chat_jid: PERSONAL_JID,
          sender: from,
          sender_name: from,
          content: `@${ASSISTANT_NAME} ${message}`,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
        });

        logger.info(
          { callSid, segments: transcript.entries.length },
          'Transcript sent to agent for processing',
        );
      } else {
        logger.info({ callSid }, 'Call ended with no speech captured');
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end('<Response/>');
  }
}

function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split('&')) {
    const [key, ...rest] = pair.split('=');
    if (key)
      params[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
  }
  return params;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// Self-register the channel
registerChannel('twilio-voice', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'TWILIO_WEBHOOK_PORT',
    'TWILIO_WEBHOOK_BASE_URL',
    'TWILIO_FORWARD_TO_NUMBER',
    'TWILIO_SIGNATURE_MODE',
  ]);

  if (
    !env.TWILIO_ACCOUNT_SID ||
    !env.TWILIO_AUTH_TOKEN ||
    !env.TWILIO_PHONE_NUMBER
  ) {
    logger.warn('Twilio Voice: credentials not set in .env — skipping');
    return null;
  }

  const group: RegisteredGroup = {
    name: 'Voice Line',
    folder: 'twilio-voice',
    trigger: `@${ASSISTANT_NAME}`,
    added_at:
      getRegisteredGroup(PERSONAL_JID)?.added_at || new Date().toISOString(),
    requiresTrigger: false,
    isMain: true,
    containerConfig: {
      additionalMounts: [
        {
          hostPath: '~/obsidian-vault/personal',
          containerPath: 'obsidian',
          readonly: false,
        },
      ],
    },
  };
  setRegisteredGroup(PERSONAL_JID, group);
  opts.registeredGroups()[PERSONAL_JID] = group;

  const port = parseInt(env.TWILIO_WEBHOOK_PORT || '3100', 10);
  const baseUrl = env.TWILIO_WEBHOOK_BASE_URL || `http://localhost:${port}`;
  const mode = env.TWILIO_SIGNATURE_MODE;
  const signatureMode: SignatureMode =
    mode === 'off' || mode === 'enforce' ? mode : 'log';
  return new TwilioVoiceChannel(opts, port, baseUrl, {
    authToken: env.TWILIO_AUTH_TOKEN,
    signatureMode,
    forwardTo: env.TWILIO_FORWARD_TO_NUMBER,
  });
});
