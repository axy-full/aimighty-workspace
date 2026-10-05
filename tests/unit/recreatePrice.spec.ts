import { test, expect } from "@playwright/test";
import { ctxPrice, priceWords, quoteRecreate, type QuoteReader } from "../../lib/shell/recreate-price";
import { ctxItems, type CtxCapabilities } from "../../lib/shell/context-menu";
import type { RecipeSource } from "../../lib/shell/recipe";

/* Recreate shows Make's own price in the right-click menu: the server's quote for the take's recipe, never a guess. */

const take = (fields: Partial<RecipeSource> & { params: Record<string, unknown> }): RecipeSource => ({
  id: "gen_take", kind: "video", model: "seedance_2_5", prompt: "wide on the water", provider: "byteplus", task: "generate", ...fields,
});
const engines = { models: [{ id: "seedance_2_5", kind: "video", resolutions: ["480p", "720p", "1080p"], ratios: ["16:9", "9:16"], durations: [5, 10], draft: true }] };
const reader = (log: string[], answers: Record<string, unknown>): QuoteReader => async (url, init) => {
  log.push(`${init?.method ?? "GET"} ${url}${init ? ` ${JSON.stringify(init.body)}` : ""}`);
  const hit = Object.entries(answers).find(([key]) => url.startsWith(key));
  if (!hit) throw new Error("not mocked");
  if (hit[1] instanceof Error) throw hit[1];
  return hit[1];
};

test("a video take is priced at its own engine, size and length through the engines quote", async () => {
  const log: string[] = [];
  const price = await quoteRecreate(take({ params: { ratio: "9:16", resolution: "1080p", duration: 5 } }), reader(log, { "/api/workbench/engines?": { credits: 43 }, "/api/workbench/engines": engines }));
  expect(price).toEqual({ state: "ready", credits: 43, approximate: false });
  expect(log.at(-1)).toContain("model=seedance_2_5&resolution=1080p&ratio=9%3A16&duration=5");
  expect(priceWords(price as never)).toBe("43 cr");
});

test("an approximate engine says about; the dollars follow the workspace's credit rate", async () => {
  const price = await quoteRecreate(take({ params: { resolution: "720p", duration: 5 } }), reader([], { "/api/workbench/engines?": { credits: 12, approximate: true }, "/api/workbench/engines": engines }));
  expect(price).toEqual({ state: "ready", credits: 12, approximate: true });
  expect(ctxPrice(price, 0.1)).toEqual({ state: "ready", text: "about 12 cr", hover: "About US$1.20" });
  expect(ctxPrice({ state: "ready", credits: 43, approximate: false }, 0.1)).toEqual({ state: "ready", text: "43 cr", hover: "US$4.30" });
  expect(ctxPrice({ state: "ready", credits: 43, approximate: false }, undefined)).toEqual({ state: "ready", text: "43 cr" });
});

test("no price is never a figure: the server's refusal, a missing engine and a read failure each say why", async () => {
  const refused = await quoteRecreate(take({ params: {} }), reader([], { "/api/workbench/engines?": new Error("No confirmed price for this setting yet."), "/api/workbench/engines": engines }));
  expect(refused).toEqual({ state: "unavailable", reason: "No confirmed price for this setting yet." });
  const none = await quoteRecreate(take({ params: {} }), reader([], { "/api/workbench/engines": { models: [] } }));
  expect(none).toMatchObject({ state: "unavailable" });
  const failed = await quoteRecreate(take({ params: {} }), reader([], { "/api/workbench/engines": new Error("Failed to fetch") }));
  expect(failed).toEqual({ state: "unavailable", reason: "No price is available for this take right now. Try again." });
  const unpriced = await quoteRecreate(take({ params: {} }), reader([], { "/api/workbench/engines?": { credits: null }, "/api/workbench/engines": engines }));
  expect(unpriced).toMatchObject({ state: "unavailable" });
});

test("a take Make cannot recreate has no price, and the reason is Make's own", async () => {
  const price = await quoteRecreate(take({ params: { task: "dub" } }), reader([], {}));
  expect(price).toMatchObject({ state: "unavailable" });
  expect((price as { reason: string }).reason).toMatch(/source clip/);
});

test("the menu shows the price after Recreate; with none the item is disabled with the reason; nothing else is priced", () => {
  const caps = (price: CtxCapabilities["price"]): CtxCapabilities => ({ can: { retry: true, copy: true, delete: true }, why: {}, hasClipboard: false, canUndo: false, price });
  const items = (c: CtxCapabilities) => ctxItems({ kind: "asset", id: "a" }, c).filter((i) => !i.sep) as Extract<ReturnType<typeof ctxItems>[number], { command: string }>[];
  const retry = (c: CtxCapabilities) => items(c).find((i) => i.command === "retry")!;
  expect(retry(caps({ retry: { state: "ready", text: "43 cr", hover: "US$4.30" } }))).toMatchObject({ price: "43 cr", hover: "US$4.30" });
  expect(retry(caps({ retry: { state: "ready", text: "43 cr", hover: "US$4.30" } })).disabled).toBeUndefined();
  expect(retry(caps({ retry: { state: "reading" } }))).toMatchObject({ disabled: true, reason: "Reading the price…" });
  expect(retry(caps({ retry: { state: "unavailable", reason: "No confirmed price for this setting yet." } }))).toMatchObject({ disabled: true, reason: "No confirmed price for this setting yet." });
  expect(items(caps({ retry: { state: "ready", text: "43 cr" } })).filter((i) => i.price).map((i) => i.command)).toEqual(["retry"]);
});
