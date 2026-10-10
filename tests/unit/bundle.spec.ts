import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { VENDOR_RATES } from "../../lib/vendorRates";
import { DEFAULT_MARGINS } from "../../lib/creditTerms";
import { IMAGE_OUT_USD } from "../../lib/vendorPricing";

/**
 * §2: the margin is never shown.
 *
 * This is the only check that proves it, because it reads the artifact a
 * browser is actually served rather than the imports we meant to write. Two
 * halves used to be in there and neither may reach a browser:
 *
 *   · the vendors' per-second rates (`withoutAudio:<rate>`), which the old
 *     composer's client estimator once carried (every live price now comes
 *     from the server's quote routes);
 *   · the margin table itself (`"<engine>":<margin>`), a literal in
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
     away: a bare number could be anything, `"<engine>":<margin>` could
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

test("the browser asks the server for its prices, and holds no rate to divide", () => {
  const files = chunks();
  test.skip(files.length === 0, "no build in .next — run `next build` first");

  /* A guard on the guards. The two tests above would also pass if the
     browser had simply stopped pricing — no rates, no leak, no prices — and
     a green tick for that would be the worst outcome of the three.

     This used to prove pricing by finding the client ESTIMATOR in the bundle
     (`withoutAudio`, a property lib/rateTable.ts reads). The estimator left the
     client with the old composer (docs/old-shells.md): Release 1 prices every
     figure on the server — Make's button and line from POST
     /api/generate/quote, the engine list's rows from GET
     /api/workbench/engines?<settings> (components/graphite/make/use-make.ts,
     lib/workspace/use-composer.ts) — and lib/rateTable.ts's arithmetic runs
     only in server code. So what proves the browser still prices is that it
     asks those routes. */
  const text = files.map((f) => readFileSync(f, "utf8"));
  for (const route of ["/api/generate/quote", "/api/workbench/engines"]) {
    expect(text.some((t) => t.includes(route)), `no client chunk asks ${route} — the browser cannot price`).toBe(true);
  }

  /* And no rate literal, in any chunk: the leak, stated by its shape rather
     than by today's figures, so a rate added tomorrow is caught too. Any
     vendor or table rate key with a number after it — as minified
     (`withoutAudio:.084`) or as JSON (`"withoutAudio":0.084`, how a bundler
     inlines a large object literal). */
  const RATE = /\b(withoutAudio|withAudio|withoutVideo|withVideo|imageRefInUsd|imageRefIn|usdPerMinute|usdPerMinuteMin|usdPerMinuteMax)\\?"?\s*:\s*-?\.?\d/;
  const withNumbers = files.flatMap((f, i) => {
    const hit = text[i].match(RATE);
    return hit ? [`${f.split("/").pop()}: ${hit[0]}`] : [];
  });
  expect(withNumbers, `a rate literal is in the bundle:\n${withNumbers.join("\n")}`).toEqual([]);

  /* The fallback image prices (lib/vendorPricing.ts), by size beside value. */
  const sizes = Object.entries(IMAGE_OUT_USD).flatMap(([size, usd]) => {
    const bare = String(usd), minified = bare.startsWith("0.") ? bare.slice(1) : bare;
    return [`${size}:${minified}`, `"${size}":${minified}`, `${size}:${bare}`, `"${size}":${bare}`];
  });
  const imagePrices = files.filter((_, i) => sizes.some((p) => text[i].includes(p)));
  expect(imagePrices, "the vendor's image prices are in the bundle").toEqual([]);
});
