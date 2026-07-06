/**
 * Regression tests for snack-bot's pure functions (parsing + matching).
 *
 * Each test pins a regression that ALREADY HIT during development. No happy-
 * path padding — these all encode lessons learned from real bugs.
 *
 * Run: cd /Users/sophiedavis/projects/nanoclaw && npx vitest run \
 *        .claude/skills/add-snack-bot/scripts/snack-bot.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  cleanPhrase,
  parseAddRequest,
  matchItem,
  isAmbiguous,
  type ScrapedItem,
} from './snack-bot.js';

function item(name: string, href: string, price: string = '$10.00'): ScrapedItem {
  return { name, href, price, qty: 1, unavailable: false, productId: null };
}

describe('parseAddRequest — natural-language parsing', () => {
  it('strips leading trigger verbs, "a box of", "please."; supports comma + "and" splitting', () => {
    // Catches regressions where leading-verb stripping or trailing "please" breaks.
    const reqs = parseAddRequest(
      'add 2 cheezits and a box of triscuits, some la croix please.',
    );
    expect(reqs).toEqual([
      { phrase: 'cheezits', qty: 2 },
      { phrase: 'triscuits', qty: 1 },
      { phrase: 'la croix', qty: 1 },
    ]);
  });

  it('parses "<number> bottles of X" as qty=<number>, phrase="X"', () => {
    // Catches the "bottles of"/"jugs of" quantifier-stripping regression.
    const reqs = parseAddRequest('order me 12 bottles of green tea');
    expect(reqs).toEqual([{ phrase: 'green tea', qty: 12 }]);
  });

  it('parses parenthetical qty "(2 of them)" → qty=2 with phrase stripped of the paren', () => {
    // Catches the regression where "add green tea bottles (2 of them)" was
    // parsed as qty=1, phrase="green tea bottles (2 of them)" because the
    // qty extractor only matched a LEADING number.
    const reqs = parseAddRequest('add green tea bottles (2 of them)');
    expect(reqs).toEqual([{ phrase: 'green tea bottles', qty: 2 }]);
  });

  it('parses bare parenthetical qty "(3)" → qty=3', () => {
    const reqs = parseAddRequest('add skinny pops (3)');
    expect(reqs).toEqual([{ phrase: 'skinny pops', qty: 3 }]);
  });

  it('parses trailing "x2" / "×2" multiplier suffix → qty=2', () => {
    expect(parseAddRequest('add cheezits x2')).toEqual([{ phrase: 'cheezits', qty: 2 }]);
    expect(parseAddRequest('add cheezits ×2')).toEqual([{ phrase: 'cheezits', qty: 2 }]);
  });

  it('strips a trailing "and " left over after ", and X" Oxford-comma split', () => {
    // Catches regression where Oxford-comma + "and" double-separator left
    // "and X" stuck on the next chunk (we observed this with Slack-pasted text).
    const reqs = parseAddRequest('add pirate bootie, nut packets, and 2 kirkland green tea');
    expect(reqs).toEqual([
      { phrase: 'pirate bootie', qty: 1 },
      { phrase: 'nut packets', qty: 1 },
      { phrase: 'kirkland green tea', qty: 2 },
    ]);
  });
});

describe('cleanPhrase — leading-article / quantifier stripping', () => {
  it('drops "a bag of" + trailing period/please', () => {
    // Catches regression where the trailing-period stripper failed on "please."
    expect(cleanPhrase('a bag of pretzels please.')).toBe('pretzels');
  });

  it('drops a "to cart - " prefix (Slack message phrasing)', () => {
    expect(cleanPhrase('to cart - pirate bootie')).toBe('pirate bootie');
  });
});

describe('matchItem — token + slug scoring', () => {
  it('matches "cheezits" against a "cheez-it" slug via hyphen-stripped variant + plural fallback', () => {
    // Catches the slug-normalization regression: hyphens must be tried BOTH
    // ways (replaced with spaces AND stripped entirely) so "cheezits" plural
    // → "cheezit" can match a "cheez-it" → "cheezit" condensed slug.
    const scored = matchItem('cheezits', [
      item('Original Backed Snack Crackers, 45 x 1.5 oz', '/products/57666-cheez-it-cheese-crackers-baked-snack-crackers-original-45-ct'),
    ]);
    expect(scored.length).toBe(1);
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('matches via slug-only when the display name has none of the words', () => {
    // Catches the "pirate bootie → Aged White Cheddar" case. The display name
    // is "Aged White Cheddar 40/5 oz bags" but the slug is "/pirate-brands-aged-white-cheddar/".
    const scored = matchItem('pirate bootie', [
      item('Aged White Cheddar 40 / 5 oz bags', '/products/19976660-pirate-brands-aged-white-cheddar-0-5-oz'),
    ]);
    expect(scored.length).toBe(1);
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('produces a tie (ambiguous) when two items share the same key tokens', () => {
    // Catches the silent-pick regression where ambiguous matches were resolved
    // by taking candidates[0] without flagging the tie.
    const scored = matchItem('green tea', [
      item('Green Tea, 12 x 16.9 oz', '/products/19188578-ito-en-green-tea'),
      item('Kirkland Signature Green Tea Bags, 1.5 g, 100-count', '/products/17677005-kirkland-green-tea'),
    ]);
    expect(scored.length).toBe(2);
    expect(isAmbiguous(scored)).toBe(true);
  });

  it('filters stopwords + short tokens so phrases of noise alone return no matches', () => {
    // Catches the token-filter regression where "the and" alone might
    // accidentally score against every item containing "the" / "and".
    const scored = matchItem('the and with', [
      item('Sample Product, 12 ct', '/products/1-sample'),
    ]);
    expect(scored.length).toBe(0);
  });

  it('honors plural-fallback gate at length 4+ ("teas" → "tea")', () => {
    // Catches the off-by-one regression where the plural gate was `> 4`
    // and excluded 4-letter plurals like "teas", "nuts", "figs".
    const withTeas = matchItem('teas', [
      item('Kirkland Green Tea Bags, 100-count', '/products/17677005-kirkland-green-tea'),
    ]);
    expect(withTeas.length).toBe(1);
    expect(withTeas[0].score).toBeGreaterThan(0);
    expect(withTeas[0].score).toBeLessThan(1); // matched via fallback, not exact substring
  });
});
