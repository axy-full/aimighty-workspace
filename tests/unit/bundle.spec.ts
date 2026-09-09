import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { VENDOR_RATES } from "../../lib/vendorRates";
import { DEFAULT_MARGINS } from "../../lib/creditTerms";

/**
 * §2: the margin is never shown.
 *
 * This is the only check that proves it, because it reads the artifact a
 * browser is actually served rather than the imports we meant to write. Two
 * halves used to be in there and either one is enough to give the markup away:
 *
 *   · the vendors' per-second rates (`withoutAudio:.084`), because the
 *     estimator is bundled so the composer can reprice without a round trip;
 *   · the margin table itself (`identity-training":1.38`), a literal in
 *     lib/creditTerms.ts, which the browser imported for the same reason.
 *
 * It needs a build. Without one it says so and skips rather than passing on
 * nothing — a green tick for a check that never ran is worse than a red one.
 */

const DIR = ".next/static/chunks";

function chunks(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith(".js")).map((f) => `${DIR}/${f}`);
}

const numbers = (o: unknown, out: number[] = []): number[] => {
  if (typeof o === "number") out.push(o);
  else if (Array.isArray(o)) for (const v of o) numbers(v, out);
  else if (o && typeof o === "object") for (const v of Object.values(o)) numbers(v, out);
  return out;
};

test("no vendor rate reaches the browser", () => {
  const files = chunks();
  test.skip(files.length === 0, "no build in .next — run `next build` first");

  /* Every distinct vendor figure in the catalogue, as it would appear
     minified: JS drops a leading zero, so 0.084 is written `.084`. */
  const rates = [...new Set(numbers(VENDOR_RATES))].filter((n) => n > 0 && n < 1000);
  const found: string[] = [];

  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const n of rates) {
      const bare = String(n);
      const minified = bare.startsWith("0.") ? bare.slice(1) : bare;
      /* Bounded so a rate is not "found" inside a longer number or a hash:
         what would betray it is the rate beside the key it belongs to. */
      for (const key of ["withoutAudio", "withAudio", "withoutVideo", "withVideo", "imageRefInUsd"]) {
        if (text.includes(`${key}:${minified}`) || text.includes(`${key}:${bare}`)) {
          found.push(`${f.split("/").pop()}: ${key}:${minified}`);
        }
      }
    }
  }
  expect(found, `vendor rates in the client bundle:\n${found.join("\n")}`).toEqual([]);
});

test("no margin reaches the browser", () => {
  const files = chunks();
  test.skip(files.length === 0, "no build in .next — run `next build` first");

  /* The margin table is keyed by engine id, so the pair is what gives it
     away: a bare 1.38 could be anything, `"identity-training":1.38` could
     not. */
  const found: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const [engine, margin] of Object.entries(DEFAULT_MARGINS)) {
      const bare = String(margin);
      const minified = bare.startsWith("0.") ? bare.slice(1) : bare;
      for (const m of [bare, minified]) {
        if (text.includes(`"${engine}":${m}`) || text.includes(`${JSON.stringify(engine)}:${m}`)) {
          found.push(`${f.split("/").pop()}: "${engine}":${m}`);
        }
      }
    }
  }
  expect(found, `margins in the client bundle:\n${found.join("\n")}`).toEqual([]);
});

test("the browser still has the estimator, just nothing to divide", () => {
  const files = chunks();
  test.skip(files.length === 0, "no build in .next — run `next build` first");

  /* A guard on the guards. The two tests above would also pass if the
     composer had simply stopped pricing — no rates, no leak, no prices — and
     a green tick for that would be the worst outcome of the three.
     
     What it checks is the ESTIMATOR, not a number: `withoutAudio` appears in
     the bundle as a property the estimator reads, and measured on the built
     output it appears with no digits after it anywhere. The figures
     themselves now arrive at runtime in the session, which is better than
     this change set set out to do — the browser holds the arithmetic and the
     server holds the numbers. */
  const any = files.some((f) => readFileSync(f, "utf8").includes("withoutAudio"));
  expect(any, "the estimator is gone from the bundle — the composer cannot price").toBe(true);

  /* And no digits after it, in any chunk: that is the leak, stated the other
     way round. */
  const withNumbers = files.filter((f) => /withoutAudio:\s*\.?\d/.test(readFileSync(f, "utf8")));
  expect(withNumbers, "a rate literal is back in the bundle").toEqual([]);
});
