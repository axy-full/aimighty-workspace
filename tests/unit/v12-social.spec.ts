import { test, expect } from "@playwright/test";
import { BED_SECONDS, LINES_MAX, bedBody, bedOpening, canMakeBed, canNarrate, narrationBody, narrationOpening } from "../../lib/v12/social";
import { stagePage, stagesOf } from "../../lib/v12/board/stages";
import { audioRequest, quoteRequest } from "../../lib/v12/quote";

/**
 * The Social · narrated board's Voice stage data (lib/v12/social.ts; redesign P6-b): what a card can run, the quote-only bodies of a
 * narration and a bed (the payload Make's sound form quotes and submits), what Make opens with, and the stage page. Pure.
 */
const setup = (over: Record<string, unknown> = {}) => ({ configured: true, vendors: { elevenlabs: true, xai: false }, speechModels: [{ id: "m", label: "M" }], ...over }) as never;

test("a card shows only for what the workspace can run", () => {
  expect(canNarrate(setup())).toBe(true);
  expect(canMakeBed(setup())).toBe(true);
  expect(canMakeBed(setup({ vendors: { elevenlabs: false, xai: true } }))).toBe(false);
  expect(canNarrate(setup({ vendors: { elevenlabs: false, xai: true } }))).toBe(true);
  expect(canNarrate(setup({ speechModels: [] }))).toBe(false);
  for (const none of [null, undefined, setup({ configured: false })]) { expect(canNarrate(none)).toBe(false); expect(canMakeBed(none)).toBe(false); }
});

test("a narration is quoted as written: words, voice and model, and nothing to price without all three", () => {
  expect(narrationBody("  Hello there  ", "v1", "m1")).toEqual({ task: "speech", text: "Hello there", voiceId: "v1", modelId: "m1" });
  expect(narrationBody("", "v1", "m1")).toBeNull();
  expect(narrationBody("   ", "v1", "m1")).toBeNull();
  expect(narrationBody("Hello", "", "m1")).toBeNull();
  expect(narrationBody("Hello", "v1", "")).toBeNull();
  expect(narrationBody("x".repeat(LINES_MAX + 50), "v1", "m1")!.text).toHaveLength(LINES_MAX);
});

test("a bed is instrumental, at Make's own opening length, and nothing to price without a description", () => {
  expect(bedBody("Slow strings")).toEqual({ task: "music", text: "Slow strings", lengthMs: BED_SECONDS * 1000, instrumental: true });
  expect(bedBody("  ")).toBeNull();
});

test("Make opens in its audio mode with the words, and for a narration the voice", () => {
  expect(narrationOpening(" Hello ", "v1", "Voice A")).toEqual({ prompt: "Hello", type: "audio", billing: "workspace", note: "Narration · Voice A", sound: { voiceId: "v1" } });
  expect(narrationOpening("Hello", "v1", null).note).toBe("Narration");
  expect(bedOpening("Slow strings")).toMatchObject({ type: "audio", model: "eleven_music", note: "Music bed", sound: { instrumental: true, seconds: BED_SECONDS } });
});

test("the audio read is the same request the generic builder makes, and carries quoteOnly", () => {
  const source = { route: "audio" as const, body: { task: "speech", text: "Hi", voiceId: "v", modelId: "m" } };
  const narrow = audioRequest(source);
  expect(narrow).toEqual(quoteRequest(source));
  expect(narrow.url).toBe("/api/audio");
  expect(JSON.parse(String(narrow.init.body))).toEqual({ ...source.body, quoteOnly: true });
  expect(narrow.init.method).toBe("POST");
});

test("Voice is a page of a narrated board; every other stage and every other kind keeps its cards", () => {
  expect(stagePage("voice", "narrated")).toBe("voice");
  for (const id of ["hook", "script", "scenes", "captions", "deliver"]) expect(stagePage(id, "narrated"), id).toBeNull();
  expect(stagePage("voice", "clips")).toBeNull();
  expect(stagePage("voice", "film")).toBeNull();
  expect(stagesOf("narrated", null).map((s) => s.id)).toContain("voice");
});
