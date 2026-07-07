#!/usr/bin/env node
/**
 * podcast-synth.mjs — Two-voice podcast synthesis via ElevenLabs, delivered to Telegram.
 *
 * Usage: node podcast-synth.mjs <script-file> <topic> [chat-id] [narrator-voice-id]
 *
 * Script format: Lines starting with "ALEX:" or "SAM:" for each speaker.
 * A script with no ALEX:/SAM: labels is synthesized as a single narrator,
 * using narrator-voice-id if given (default: Alice).
 *
 * Env vars required:
 *   ELEVENLABS_API_KEY
 *   ELEVENLABS_MODEL_ID (default: eleven_v3)
 *   TELEGRAM_BOT_TOKEN
 */

import { readFileSync, writeFileSync } from "fs";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_v3";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MAX_CHARS = 4500;

// Two distinct voices for the conversation
const VOICE_ALEX = "Xb7hH8MSUJpSbSDYk0k2"; // Alice — clear, engaging
const VOICE_SAM = "onwK4e9ZLuTAKqWW03F9";   // Daniel — steady, grounded

function parseDialogue(script, narratorVoice) {
  const segments = [];
  let currentVoice = null;
  let currentText = [];

  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("ALEX:")) {
      if (currentVoice && currentText.length) {
        segments.push({ voice: currentVoice, text: currentText.join(" ") });
      }
      currentVoice = VOICE_ALEX;
      currentText = [trimmed.slice(5).trim()];
    } else if (trimmed.startsWith("SAM:")) {
      if (currentVoice && currentText.length) {
        segments.push({ voice: currentVoice, text: currentText.join(" ") });
      }
      currentVoice = VOICE_SAM;
      currentText = [trimmed.slice(4).trim()];
    } else if (currentVoice) {
      currentText.push(trimmed);
    }
  }
  if (currentVoice && currentText.length) {
    segments.push({ voice: currentVoice, text: currentText.join(" ") });
  }

  // Fallback: no labels found, treat as single voice
  if (!segments.length) {
    segments.push({ voice: narratorVoice || VOICE_ALEX, text: script });
  }

  return segments;
}

function batchSegments(segments) {
  const batches = [];
  for (const { voice, text } of segments) {
    if (batches.length && batches.at(-1).voice === voice && batches.at(-1).text.length + text.length + 1 < MAX_CHARS) {
      batches.at(-1).text += " " + text;
    } else if (text.length > MAX_CHARS) {
      const sentences = text.split(/(?<=[.!?])\s+/);
      let chunk = "";
      for (const s of sentences) {
        if (chunk.length + s.length + 1 > MAX_CHARS) {
          if (chunk) batches.push({ voice, text: chunk.trim() });
          chunk = s;
        } else {
          chunk = chunk ? chunk + " " + s : s;
        }
      }
      if (chunk.trim()) batches.push({ voice, text: chunk.trim() });
    } else {
      batches.push({ voice, text });
    }
  }
  return batches;
}

async function tts(text, voiceId) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.4 },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs error ${res.status}: ${err}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function sendAudioToTelegram(audioBuffer, chatId, topic) {
  const boundary = "----PodcastBoundary" + Date.now();

  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n🎙️ ${topic}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${topic}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="performer"\r\n\r\nConcept to Podcast`);
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="podcast.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`
  );

  const preamble = Buffer.from(parts.join("\r\n") + "\r\n", "utf-8");
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
  const body = Buffer.concat([preamble, audioBuffer, epilogue]);

  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAudio`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram error ${res.status}: ${err}`);
  }
  return await res.json();
}

async function main() {
  const [scriptFile, topic, chatId, narratorVoice] = process.argv.slice(2);
  if (!scriptFile || !topic) {
    console.error("Usage: node podcast-synth.mjs <script-file> <topic> [chat-id] [narrator-voice-id]");
    process.exit(1);
  }
  if (!ELEVENLABS_API_KEY) {
    console.error("Error: ELEVENLABS_API_KEY not set");
    process.exit(1);
  }

  const script = readFileSync(scriptFile, "utf-8");
  const segments = parseDialogue(script, narratorVoice);
  const batches = batchSegments(segments);
  console.log(`Synthesizing ${batches.length} segment(s)...`);

  const audioParts = [];
  for (let i = 0; i < batches.length; i++) {
    const name =
      batches[i].voice === VOICE_ALEX ? "Alex" :
      batches[i].voice === VOICE_SAM ? "Sam" : "Narrator";
    console.log(`  [${i + 1}/${batches.length}] ${name}: ${batches[i].text.slice(0, 50)}...`);
    audioParts.push(await tts(batches[i].text, batches[i].voice));
  }

  const fullAudio = Buffer.concat(audioParts);
  const outPath = "/tmp/podcast.mp3";
  writeFileSync(outPath, fullAudio);
  console.log(`Audio saved: ${outPath} (${(fullAudio.length / 1024 / 1024).toFixed(1)} MB)`);

  if (chatId && TELEGRAM_BOT_TOKEN) {
    console.log("Sending to Telegram...");
    await sendAudioToTelegram(fullAudio, chatId, topic);
    console.log("Delivered!");
  } else if (!TELEGRAM_BOT_TOKEN) {
    console.log("No TELEGRAM_BOT_TOKEN — skipping delivery");
  }

  console.log(JSON.stringify({ success: true, path: outPath, size: fullAudio.length }));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
