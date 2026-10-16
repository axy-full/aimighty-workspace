import { test, expect } from "@playwright/test";
import { HINDI, SOURCE_LANGUAGE, TOO_LONG, TRANSLATE_MAX_CHARS, quoteBody, runBody, translateFromResponse, translateProblem } from "../../lib/v12/translate-script";
import { quoteFromResponse, quoteRequest } from "../../lib/v12/quote";

/** The Hindi script's tool interface (lib/v12/translate-script.ts; demo plan PR 11): one quote, one run a person approves, one way to say "Nothing billed". */
test("a quote and a run name English to Hindi; a run carries the figure the person was shown", () => {
  expect(quoteBody({ text: "  Hello  " })).toEqual({ text: "Hello", source: SOURCE_LANGUAGE, target: HINDI, mode: "quote" });
  expect(runBody({ text: "Hello" }, 3)).toEqual({ text: "Hello", source: SOURCE_LANGUAGE, target: HINDI, mode: "run", approved: 3 });
});

test("text that is empty or too long is refused in words before anything is asked", () => {
  expect(translateProblem("   ")).toBe("Write the script first.");
  expect(translateProblem("x".repeat(TRANSLATE_MAX_CHARS))).toBeNull();
  expect(translateProblem("x".repeat(TRANSLATE_MAX_CHARS + 1))).toBe(TOO_LONG);
  expect(translateProblem("हिन्दी".repeat(400))).toBe(TOO_LONG);
});

test("the quote is the server's, exact, in the unit the workspace pays in; the house is never shown credits", () => {
  const source = { route: "translate" as const, body: quoteBody({ text: "Hello" }) };
  expect(quoteRequest(source).url).toBe("/api/v12/translate-script");
  const credits = { paysInDollars: false, creditUsd: 0.1 };
  expect(quoteFromResponse(source, true, { estimatedCredits: 2, price: 2, unit: "cr" }, credits)).toEqual({ state: "ready", price: { unit: "cr", value: { kind: "exact", credits: 2 } } });
  expect(quoteFromResponse(source, true, { estimatedCredits: 2, price: 0.02, unit: "usd" }, credits).state).toBe("error");
  const house = { paysInDollars: true, creditUsd: 0.1 };
  expect(quoteFromResponse(source, true, { estimatedCredits: 2, price: 0.021, unit: "usd" }, house)).toEqual({ state: "ready", price: { unit: "usd", usd: 0.021, upTo: false } });
  expect(quoteFromResponse(source, true, { estimatedCredits: 2, price: 2, unit: "cr" }, house).state).toBe("error");
  expect(quoteFromResponse(source, false, { error: "There is no such tool here." }, credits)).toEqual({ state: "error", message: "There is no such tool here." });
});

test("a failed run says Nothing billed, once, and offers a retry (the caller's)", () => {
  expect(translateFromResponse(true, { ok: true, text: "नमस्ते", estimatedCredits: 1 })).toEqual({ ok: true, text: "नमस्ते" });
  expect(translateFromResponse(false, { error: "Sarvam could not do this." })).toEqual({ ok: false, error: "Sarvam could not do this. Nothing billed.", free: true });
  expect(translateFromResponse(false, { error: "Sarvam could not do this. Nothing was billed." })).toMatchObject({ error: "Sarvam could not do this. Nothing was billed." });
  expect(translateFromResponse(false, null)).toMatchObject({ ok: false, error: "The Hindi script could not be made. Nothing billed." });
});

test("without ENGINE_MOCK the stand-in is no tool at all: 404, whoever asks, before it reads anything", async () => {
  const before = process.env.ENGINE_MOCK;
  process.env.ENGINE_MOCK = "";
  try {
    const { POST } = await import("../../app/api/v12/translate-script/route");
    for (const body of [{ mode: "quote", text: "Hello", source: "en-IN", target: "hi-IN" }, { mode: "run", text: "Hello", source: "en-IN", target: "hi-IN", approved: 99 }]) {
      const reply = await POST(new Request("http://localhost/api/v12/translate-script", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({}) } as never);
      expect(reply.status).toBe(404);
      expect(await reply.json()).toEqual({ error: "There is no such tool here." });
    }
  } finally {
    if (before === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = before;
  }
});
