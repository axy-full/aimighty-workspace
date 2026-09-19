import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";

/**
 * Text to Dialogue (PR C, part 2): a new audio task on the existing
 * admission, priced per character from lib/vendorRates.ts, calling
 * POST /v1/text-to-dialogue on the v3 model within the vendor's caps.
 * Nothing here reaches the network: fetch is faked or forbidden.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-eleven-dialogue-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const originalFetch = globalThis.fetch;
const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const lines = [
  { text: "Did you hear that?", voiceId: "voiceAAA01" },
  { text: "[whispers] Only the rain.", voiceId: "voiceBBB02" },
];
const chars = lines.reduce((n, line) => n + line.text.length, 0);

test.beforeEach(() => {
  globalThis.fetch = async () => {
    throw new Error("Unexpected external request in test");
  };
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("dialogue is priced per character from the vendor rate and capped at 2,000 characters and 10 voices", async () => {
  const { ELEVENLABS_RATES } = await import("../../lib/vendorRates");
  const { dialogueCredits, DIALOGUE_MODEL, DIALOGUE_MAX_CHARS, DIALOGUE_MAX_VOICES } = await import("../../lib/elevenlabs");
  const { normalizeDialogueLines } = await import("../../lib/audioAdmission");
  expect(ELEVENLABS_RATES.dialogue).toEqual({ modelId: "eleven_v3", creditsPerChar: 1, maxChars: 2000, maxVoices: 10 });
  expect(ELEVENLABS_RATES.voiceChange).toEqual({ modelId: "eleven_multilingual_sts_v2", usdPerMinute: 0.12 });
  expect(DIALOGUE_MODEL).toBe("eleven_v3");
  expect(dialogueCredits(lines)).toBe(chars * ELEVENLABS_RATES.dialogue.creditsPerChar);
  expect(normalizeDialogueLines(lines)).toEqual({ lines });
  expect(normalizeDialogueLines([])).toEqual({ error: "Write the lines first." });
  expect(normalizeDialogueLines([{ text: "Hi", voiceId: "no" }])).toEqual({ error: "Pick a voice for every line." });
  expect(normalizeDialogueLines([{ text: "  ", voiceId: "voiceAAA01" }])).toEqual({ error: "Every line needs its text." });
  const long = normalizeDialogueLines([{ text: "a".repeat(DIALOGUE_MAX_CHARS + 1), voiceId: "voiceAAA01" }]);
  expect("error" in long && long.error).toMatch(/up to 2,000 characters/);
  expect("error" in normalizeDialogueLines([{ text: "a".repeat(DIALOGUE_MAX_CHARS), voiceId: "voiceAAA01" }])).toBe(false);
  const crowd = normalizeDialogueLines(Array.from({ length: DIALOGUE_MAX_VOICES + 1 }, (_, i) => ({ text: "Hi", voiceId: `voice${String(i).padStart(5, "0")}` })));
  expect("error" in crowd && crowd.error).toMatch(/up to 10 voices/);
  expect("error" in normalizeDialogueLines(Array.from({ length: DIALOGUE_MAX_VOICES }, (_, i) => ({ text: "Hi", voiceId: `voice${String(i).padStart(5, "0")}` })))).toBe(false);
});

test("textToDialogue posts the lines to /v1/text-to-dialogue on the v3 model and prices the bytes it gets back", async () => {
  process.env.ENGINE_MOCK = "0";
  process.env.ELEVENLABS_API_KEY = "unit-eleven-key";
  process.env.ELEVENLABS_BASE_URL = "https://eleven.test";
  try {
    const { textToDialogue } = await import("../../lib/elevenlabs");
    const { elevenlabs } = await import("../../lib/engines/elevenlabs");
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(Buffer.from("ID3mock"), { status: 200, headers: { "content-type": "audio/mpeg", "request-id": "req-dialogue-1" } });
    };
    const out = await textToDialogue({ lines });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://eleven.test/v1/text-to-dialogue?output_format=mp3_44100_128");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("unit-eleven-key");
    expect(headers.Accept).toBe("audio/mpeg");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      inputs: [
        { text: "Did you hear that?", voice_id: "voiceAAA01" },
        { text: "[whispers] Only the rain.", voice_id: "voiceBBB02" },
      ],
      model_id: "eleven_v3",
    });
    expect(out.bytes.toString()).toBe("ID3mock");
    expect(out.mime).toBe("audio/mpeg");
    expect(out.credits).toBe(chars);
    expect(out.requestId).toBe("req-dialogue-1");

    // The engine adapter routes the task and estimates the same figure.
    const request = { kind: "audio" as const, genId: "gen_d", modelId: "eleven_v3", task: "dialogue" as const, text: "", params: { lines } };
    const { usdForCredits } = await import("../../lib/elevenlabs");
    expect(elevenlabs.estimate(request)).toBe(usdForCredits(chars, null));
    const rendered = await elevenlabs.render(request);
    expect(calls).toHaveLength(2);
    expect("produced" in rendered && rendered.produced.credits).toBe(chars);

    // A vendor refusal is a received rejection, never a silent retry.
    globalThis.fetch = async () => Response.json({ detail: { status: "invalid_request", message: "too many voices" } }, { status: 422 });
    await expect(textToDialogue({ lines })).rejects.toMatchObject({ status: 422, rejectedBeforeGeneration: true });
  } finally {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_BASE_URL;
  }
});

test("the audio admission quotes a dialogue like a line and refuses one over the caps", async () => {
  process.env.ENGINE_MOCK = "1";
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { executeAudioAdmission } = await import("../../lib/audioAdmission");
  const { usdForCredits } = await import("../../lib/elevenlabs");
  const { billCredits } = await import("../../lib/creditTerms");
  await platformReady();
  const id = "dialogue-quote";
  await platformDb().execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)`,
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  await grantCredits(id, 100, "Test funds", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  await runInTenant(
    ws,
    async () => {
      await ready();
      await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
      const options = { defer: async () => {} };
      const quote = await executeAudioAdmission({ task: "dialogue", lines, projectId: "project", quoteOnly: true }, actor, options);
      expect(quote.status).toBe(200);
      expect(quote.body).toMatchObject({ estimatedCredits: billCredits(usdForCredits(chars, null), "elevenlabs"), unit: "cr" });
      const over = await executeAudioAdmission({ task: "dialogue", lines: [{ text: "a".repeat(2001), voiceId: "voiceAAA01" }], quoteOnly: true }, actor, options);
      expect(over.status).toBe(400);
      expect(String(over.body.error)).toMatch(/2,000 characters/);
      const empty = await executeAudioAdmission({ task: "dialogue", lines: [], quoteOnly: true }, actor, options);
      expect(empty.status).toBe(400);
      // Nothing was filed: a quote is not a generation.
      expect((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n).toBe(0);
    },
    actor,
  );
});
