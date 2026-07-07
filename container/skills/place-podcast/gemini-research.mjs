#!/usr/bin/env node
/**
 * gemini-research.mjs — Grounded research via the Gemini API (google_search tool).
 *
 * Usage:
 *   node gemini-research.mjs angles "<place>"            # 3-4 podcast-worthy historical angles
 *   node gemini-research.mjs brief "<place>" "<angle>"   # full research brief for one angle
 *
 * Env vars:
 *   GEMINI_API_KEY  (required)
 *   GEMINI_MODEL    (optional, default: gemini-2.5-flash)
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const [mode, place, angle] = process.argv.slice(2);

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set");
  process.exit(1);
}
if (mode === "angles" && !place) {
  console.error('Usage: gemini-research.mjs angles "<place>"');
  process.exit(1);
}
if (mode === "brief" && (!place || !angle)) {
  console.error('Usage: gemini-research.mjs brief "<place>" "<angle>"');
  process.exit(1);
}
if (mode !== "angles" && mode !== "brief") {
  console.error(`Unknown mode "${mode}" — use "angles" or "brief"`);
  process.exit(1);
}

const PROMPTS = {
  angles: `You are helping plan a short history podcast for someone currently walking around: ${place}

Search for what is genuinely interesting about this specific place's history. Then propose the 3-4 most compelling, DISTINCT angles for a ~10 minute episode.

Rules:
- Angles must be concrete and specific to this place ("the grain silos — industrial rise and fall", "Expo 67 and the waterfront's reinvention"), never generic categories ("architecture", "culture", "immigration").
- If the immediate spot has thin history, zoom out honestly: the block, then the neighborhood, then the city-level story that runs through this spot. Say plainly that you zoomed out, and return 2 strong angles instead of padding to 4.
- One line per angle: a short title, a dash, and one sentence on why it's compelling.

Output ONLY the angle list (and the one-line zoom-out note if applicable). No preamble.`,

  brief: `Research brief for a ~10 minute single-narrator walking-tour podcast episode.

Place: ${place}
Chosen angle: ${angle}

Search thoroughly and write a dense research brief containing:
- The narrative arc: how the story starts, turns, and lands
- Key dates, names, and numbers (only ones you found via search — no invention)
- 3-5 vivid anecdotes or surprising details worth telling aloud
- PROMINENT STRUCTURES STILL STANDING TODAY at or near this place that relate to the story — named, with one line each on what they are. Only include structures you can verify still exist; the narrator will reference these conditionally ("if you can spot...").
- Common myths or oversimplifications to avoid
- How this story connects to the city's larger history

Write it as material for a scriptwriter, not as the script itself.`,
};

console.log(`[gemini-research] ${mode} via ${MODEL}...`);

const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
  {
    method: "POST",
    headers: {
      "x-goog-api-key": GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPTS[mode] }] }],
      tools: [{ google_search: {} }],
    }),
  }
);

if (!res.ok) {
  console.error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 2000)}`);
  process.exit(1);
}

const data = await res.json();
const parts = data.candidates?.[0]?.content?.parts || [];
const text = parts.map((p) => p.text || "").join("");

if (!text.trim()) {
  console.error(`Empty response from Gemini: ${JSON.stringify(data).slice(0, 2000)}`);
  process.exit(1);
}

// Surface how grounded the answer actually was
const queries = data.candidates?.[0]?.groundingMetadata?.webSearchQueries;
if (queries?.length) {
  console.log(`[gemini-research] grounded on ${queries.length} searches: ${queries.join(" | ")}`);
} else {
  console.log("[gemini-research] WARNING: no grounding metadata — answer may be from model memory");
}

console.log("\n" + text.trim());
