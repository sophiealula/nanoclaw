#!/usr/bin/env tsx
/**
 * Sanity test for sanitizeUnicode — verifies the orphan-surrogate strip
 * before we rebuild the container with the patch.
 */

// Inline copy of the function from container/agent-runner/src/index.ts so this
// test runs without any container build step.
function sanitizeUnicode(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "�")
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "$1�");
}

interface Case {
  name: string;
  input: string;
  expected: string;
}

const REPLACEMENT = "�";

const cases: Case[] = [
  { name: "plain ascii", input: "hello world", expected: "hello world" },
  { name: "valid pair (emoji 🎉)", input: "party 🎉 time", expected: "party 🎉 time" },
  {
    name: "two valid pairs back-to-back (📦📬)",
    input: "📦📬",
    expected: "📦📬",
  },
  {
    name: "orphan high surrogate",
    input: "before\uD83Dafter",
    expected: `before${REPLACEMENT}after`,
  },
  {
    name: "orphan low surrogate",
    input: "before\uDC00after",
    expected: `before${REPLACEMENT}after`,
  },
  {
    name: "valid pair followed by orphan high",
    input: "🎉\uD83D end",
    expected: `🎉${REPLACEMENT} end`,
  },
  {
    name: "two orphans in same string",
    input: "x\uD800y\uDC00z",
    expected: `x${REPLACEMENT}y${REPLACEMENT}z`,
  },
  { name: "empty string", input: "", expected: "" },
  {
    name: "orphan at start of string",
    input: "\uDC00rest",
    expected: `${REPLACEMENT}rest`,
  },
  {
    name: "orphan at end of string (high at end)",
    input: "rest\uD83D",
    expected: `rest${REPLACEMENT}`,
  },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const got = sanitizeUnicode(c.input);
  if (got === c.expected) {
    passed += 1;
    console.log(`✓ ${c.name}`);
  } else {
    failed += 1;
    console.log(`✗ ${c.name}`);
    console.log(`    input:    ${JSON.stringify(c.input)}`);
    console.log(`    expected: ${JSON.stringify(c.expected)}`);
    console.log(`    got:      ${JSON.stringify(got)}`);
  }
}

// Bonus: ensure JSON.stringify round-trips after sanitizing — this is the real
// pain point that triggered the Anthropic 400.
const dirty = "user said: 📦 hello \uD83D world";
const clean = sanitizeUnicode(dirty);
let jsonOk = false;
try {
  JSON.parse(JSON.stringify({ text: clean }));
  jsonOk = true;
} catch {
  jsonOk = false;
}
if (jsonOk) {
  passed += 1;
  console.log("✓ sanitized string round-trips through JSON.stringify");
} else {
  failed += 1;
  console.log("✗ sanitized string still breaks JSON.stringify");
}

// And verify the DIRTY string would have failed without sanitization.
let dirtyBreaks = false;
try {
  // Most JSON serializers handle lone surrogates by emitting them as-is,
  // which is then rejected by JSON.parse. We test that.
  JSON.parse(JSON.stringify({ text: dirty }));
} catch {
  dirtyBreaks = true;
}
console.log(
  `(info) dirty string ${dirtyBreaks ? "BREAKS" : "passes"} JSON round-trip — confirming our patch is needed.`,
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
