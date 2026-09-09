/**
 * Ranking a list against what someone has typed.
 *
 * Written because nothing in the repo does this. Every "search" here is
 * `String.includes` over a lowercased haystack — the takes wall, the camera
 * bank, the @mention menu — which is fine when the list is short and the
 * words are whole, and useless in a palette: `dz` should find "Dolly zoom",
 * `nkaw` should find "Nike — AW26", and the best match must come first
 * rather than the first one the array happens to hold.
 *
 * Deliberately small. Not a fuzzy matcher in the Levenshtein sense: no typo
 * tolerance, because a wrong letter in a palette is a keystroke to fix, and
 * a matcher that forgives them also matches things a person did not mean.
 * What it does is the three ways people actually type at a palette —
 * a prefix, a word, or initials — and it says which of those it was, so the
 * ranking is explainable rather than a magic number.
 */

export type Hit = {
  /** Higher is better. Comparable only within one query. */
  score: number;
  /** The character positions that matched, for highlighting. */
  at: number[];
};

const WORD_START = /[\s\-–—_/·:.]/;

/**
 * Score one candidate against a lowercased needle.
 *
 * The ladder, best first:
 *   the whole needle is the start of the text        exact-ish, what people expect
 *   the whole needle starts a word inside the text   "aw" in "Nike — AW26"
 *   the whole needle appears anywhere                substring, the old behaviour
 *   the needle's letters are the words' initials     "dz" for "Dolly zoom"
 *   the needle's letters appear in order             last resort, weakest
 */
export function score(text: string, needle: string): Hit | null {
  if (!needle) return { score: 0, at: [] };
  const hay = text.toLowerCase();
  const n = needle.toLowerCase();

  const direct = hay.indexOf(n);
  if (direct === 0) return { score: 1000 - text.length, at: span(0, n.length) };

  if (direct > 0) {
    const atWordStart = WORD_START.test(hay[direct - 1] ?? "");
    return {
      score: (atWordStart ? 800 : 500) - direct - text.length / 100,
      at: span(direct, n.length),
    };
  }

  const initials = initialsOf(hay);
  const iAt = initials.letters.indexOf(n);
  if (iAt === 0) return { score: 700 - text.length / 100, at: initials.at.slice(0, n.length) };
  if (iAt > 0) return { score: 600 - text.length / 100, at: initials.at.slice(iAt, iAt + n.length) };

  /* In order but not contiguous. Scored low on purpose: it is the rule that
     matches almost everything, so it must never outrank a real substring. */
  const at: number[] = [];
  let j = 0;
  for (let i = 0; i < hay.length && j < n.length; i++) {
    if (hay[i] === n[j]) { at.push(i); j++; }
  }
  if (j < n.length) return null;
  const spread = at[at.length - 1] - at[0];
  return { score: 200 - spread - text.length / 100, at };
}

/** How much a match is discounted per key position. Under one band's width. */
const KEY_STEP = 100;

const span = (from: number, len: number) => Array.from({ length: len }, (_, i) => from + i);

function initialsOf(hay: string): { letters: string; at: number[] } {
  let letters = "";
  const at: number[] = [];
  for (let i = 0; i < hay.length; i++) {
    const prev = hay[i - 1];
    if (i === 0 || WORD_START.test(prev ?? "")) {
      if (!WORD_START.test(hay[i])) { letters += hay[i]; at.push(i); }
    }
  }
  return { letters, at };
}

/**
 * Rank a list, best first, dropping what does not match at all.
 *
 * `keys` are searched in order and the best one wins, so a thing can be found
 * by its name OR by the production it belongs to without the second diluting
 * the first. Ties keep the order they came in, which is how the caller's own
 * sense of importance survives — a palette that reshuffles equal matches on
 * every keystroke is unusable.
 */
export function rank<T>(
  items: T[], needle: string, keys: (item: T) => (string | null | undefined)[],
): { item: T; hit: Hit; key: number }[] {
  const out: { item: T; hit: Hit; key: number; i: number }[] = [];
  items.forEach((item, i) => {
    let best: Hit | null = null;
    let bestKey = 0;
    keys(item).forEach((text, k) => {
      if (!text) return;
      const raw = score(text, needle);
      if (!raw) return;
      /* Later keys are worth less, by a fixed step per level.
      
         Without this, a match on a SECONDARY key could outrank a match of the
         same quality on a PRIMARY one purely on length: searching "nike" put
         shot SH010 above shot NIKE-1, because SH010's production is "Nike"
         (4 characters) and the other shot's own code is "NIKE-1" (6). Being
         found by your own name has to beat being found by your production's.
      
         The step is smaller than the gap between match bands, so a genuinely
         better secondary match — a prefix on the production against a
         scattered match on the code — still wins. It breaks ties; it does not
         hide the key. */
      const hit = { ...raw, score: raw.score - k * KEY_STEP };
      if (!best || hit.score > best.score) { best = hit; bestKey = k; }
    });
    if (best) out.push({ item, hit: best, key: bestKey, i });
  });
  return out
    .sort((a, b) => b.hit.score - a.hit.score || a.i - b.i)
    .map(({ item, hit, key }) => ({ item, hit, key }));
}
