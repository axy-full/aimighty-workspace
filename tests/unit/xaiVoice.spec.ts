import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { XaiHttpError, xaiSubmissionRejected } from "../../lib/xaiErrors";
import { PreflightError } from "../../lib/preflight";
import { audioVendor, grokSpeech, grokSpeechUsd, grokTranscribe, GROK_VOICE_ID, grokVoicesForScreen, listGrokVoices, transcriptSrt } from "../../lib/xaiVoice";

/**
 * Owner, 23 September: Grok APIs wherever possible — Grok Voice (xAI text to
 * speech) and Grok transcription, on the xAI key. The network is stubbed.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-xai-voice-"));
process.env.PLATFORM_DATABASE_URL ??= "file:" + path.join(dir, "platform.db");
async function withKey<T>(run: () => Promise<T>, key = "xai-unit"): Promise<T> {
  const saved = { key: process.env.XAI_API_KEY, mock: process.env.ENGINE_MOCK };
  process.env.XAI_API_KEY = key; delete process.env.ENGINE_MOCK;
  try { return await run(); } finally { if (saved.key === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = saved.key; if (saved.mock !== undefined) process.env.ENGINE_MOCK = saved.mock; }
}
async function stubbed<T>(reply: (url: string) => Response, run: () => Promise<T>) {
  const real = globalThis.fetch, sent: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input instanceof Request ? input.url : input); sent.push({ url, init }); return reply(url); }) as typeof fetch;
  try { return { value: await run(), sent }; } finally { globalThis.fetch = real; }
}

test("Grok Voice is xAI's, priced by the character; other audio stays ElevenLabs'", () => {
  expect(audioVendor("grok-tts")).toBe("xai");
  expect(audioVendor("eleven_multilingual_v2")).toBe("elevenlabs");
  expect(grokSpeechUsd("x".repeat(1_000_000))).toBeCloseTo(15, 6);
  for (const id of ["eve", "ara", "rex", "naksh", "custom_voice-01"]) expect(GROK_VOICE_ID.test(id), id).toBe(true);
  for (const id of ["!", "e", ""]) expect(GROK_VOICE_ID.test(id), id).toBe(false);
});

test("the voices, a spoken line and a transcript, as xAI is asked for them", async () => {
  await withKey(async () => {
    const voices = await stubbed(() => Response.json({ voices: [{ voice_id: "eve", name: "Eve", language: "en" }, { voice_id: "ara", name: "Ara", language: "en" }] }), () => listGrokVoices(true));
    expect(voices.sent[0].url).toBe("https://api.x.ai/v1/tts/voices");
    expect(voices.value).toEqual([{ id: "eve", name: "Eve", language: "en" }, { id: "ara", name: "Ara", language: "en" }]);

    const speech = await stubbed(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }), () => grokSpeech({ text: "Not tonight. [pause]", voiceId: "eve", language: "en", speed: 3 }));
    expect(speech.sent[0].url).toBe("https://api.x.ai/v1/tts");
    expect(new Headers(speech.sent[0].init?.headers).get("authorization")).toBe("Bearer xai-unit");
    expect(JSON.parse(String(speech.sent[0].init?.body))).toEqual({ text: "Not tonight. [pause]", voice_id: "eve", language: "en", speed: 1.5 });
    expect(speech.value).toMatchObject({ mime: "audio/mpeg", costUsd: 20 * 0.000015 });

    const stt = await stubbed(() => Response.json({ text: "Not tonight", language: "en", duration: 3.5, words: [{ text: "Not", start: 0, end: 0.3, speaker: 0 }, { text: "tonight", start: 0.3, end: 0.8, speaker: 0 }] }),
      () => grokTranscribe({ bytes: Buffer.from("audio"), mime: "audio/mpeg", filename: "take.mp3", language: "en", diarize: true }));
    expect(stt.sent[0].url).toBe("https://api.x.ai/v1/stt");
    const form = stt.sent[0].init?.body as FormData;
    expect([form.get("language"), form.get("format"), form.get("diarize")]).toEqual(["en", "true", "true"]);
    expect(form.get("file")).toBeTruthy();
    expect(stt.value).toMatchObject({ text: "Not tonight", seconds: 3.5, costUsd: 3.5 * 0.000028 });
  });
});

test("subtitles: timed cues, a new cue for a new speaker or a long line", () => {
  const words = [
    { text: "Not", start: 0, end: 0.3, speaker: 0 }, { text: "tonight.", start: 0.3, end: 0.9, speaker: 0 },
    { text: "The", start: 1.2, end: 1.4, speaker: 1 }, { text: "ice", start: 1.4, end: 1.7, speaker: 1 }, { text: "holds.", start: 1.7, end: 62.25, speaker: 1 },
  ];
  expect(transcriptSrt(words)).toBe("1\n00:00:00,000 --> 00:00:00,900\nNot tonight.\n\n2\n00:00:01,200 --> 00:00:01,700\nThe ice\n\n3\n00:00:01,700 --> 00:01:02,250\nholds.\n");
});

/* A refused line costs nothing, so its reservation is released; a 5xx may have been spoken, so it is kept. */
test("a line xAI refuses is certain, one it fails on is not, and one never sent is certain", async () => {
  await withKey(async () => {
    for (const [status, certain] of [[400, true], [404, true], [422, true], [429, true], [500, false], [502, false]] as const) {
      const out = await stubbed(() => new Response("bad voice", { status }), () => grokSpeech({ text: "Not tonight.", voiceId: "21m00Tcm4TlvDq8ikWAM" }).catch((e: unknown) => e));
      expect(out.value, String(status)).toBeInstanceOf(XaiHttpError);
      expect(xaiSubmissionRejected(out.value), String(status)).toBe(certain);
    }
  });
  const saved = { key: process.env.XAI_API_KEY, mock: process.env.ENGINE_MOCK };
  delete process.env.XAI_API_KEY; delete process.env.ENGINE_MOCK;
  try {
    const out = await stubbed(() => new Response("never"), () => grokSpeech({ text: "Not tonight.", voiceId: "eve" }).catch((e: unknown) => e));
    expect(out.value).toBeInstanceOf(PreflightError);
    expect(out.sent).toEqual([]);
  } finally {
    if (saved.key !== undefined) process.env.XAI_API_KEY = saved.key;
    if (saved.mock !== undefined) process.env.ENGINE_MOCK = saved.mock;
  }
});

/* GET /api/audio draws every audio picker; it must not wait on a slow or down xAI for the listing's full twenty seconds. */
test("a screen waits seconds for xAI's voices, shares one listing, and does not wait again on a failed one", async () => {
  await withKey(async () => {
    let answer: (reply: Response) => void = () => {};
    const slow = await stubbed(() => new Promise<Response>((resolve) => { answer = resolve; }) as never, async () => {
      const started = Date.now();
      await expect(grokVoicesForScreen(40)).rejects.toThrow("did not answer in time");
      expect(Date.now() - started).toBeLessThan(2_000);
      await expect(grokVoicesForScreen(40)).rejects.toThrow("did not answer in time");
      const late = listGrokVoices();
      answer(Response.json({ voices: [{ voice_id: "eve", name: "Eve", language: "en" }] }));
      return late;
    });
    /* One listing for everyone who asked meanwhile; the late answer fills the cache for the next open. */
    expect(slow.sent).toHaveLength(1);
    expect(slow.value).toEqual([{ id: "eve", name: "Eve", language: "en" }]);
    const next = await stubbed(() => new Response("never", { status: 500 }), () => grokVoicesForScreen(40));
    expect(next).toEqual({ value: [{ id: "eve", name: "Eve", language: "en" }], sent: [] });
  }, "xai-unit-slow");

  await withKey(async () => {
    const down = await stubbed(() => new Response("down", { status: 503 }), async () => {
      await expect(grokVoicesForScreen(1_000)).rejects.toThrow("(503)");
      /* The failure is remembered: the next open answers at once, without asking xAI. */
      await expect(grokVoicesForScreen(1_000)).rejects.toThrow("(503)");
    });
    expect(down.sent).toHaveLength(1);
    /* Refresh (and admission) always ask; a listing that works clears the failure. */
    const back = await stubbed(() => Response.json({ voices: [{ voice_id: "ara", name: "Ara" }] }), async () => [await listGrokVoices(true), await grokVoicesForScreen(40)]);
    expect(back.sent).toHaveLength(1);
    expect(back.value).toEqual([[{ id: "ara", name: "Ara", language: null }], [{ id: "ara", name: "Ara", language: null }]]);
  }, "xai-unit-down");
});
