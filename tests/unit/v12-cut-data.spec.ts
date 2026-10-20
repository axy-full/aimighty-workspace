import { test, expect } from "@playwright/test";
import { CUT_DATA_LIMITS, TAKE_ID, cleanCutShots, cleanLanguageVoice, cleanTrim, voiceOf, withLanguageVoice, type BoardVoice } from "../../lib/v12/board/cut-data";
import { MAX_LANGUAGES } from "../../lib/v12/deliver";
import { newProject } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";

/**
 * What the Edit step keeps in the draft (lib/v12/board/cut-data.ts): the cut's dressing and each language's voice. The draft's
 * schema takes exactly this shape, and the Hindi tool, the Edit screen and an outside agent all write it.
 */
const GOOD = {
  boardCut: {
    music: { upload: "upload_music1", volume: 0.25 },
    title: { title: "Monsoon", durationSeconds: 2 },
    end: { headline: "Coming soon", callToAction: "Watch the trailer" },
    captions: "bold",
    duck: 0.3,
  },
  boardVoice: {
    en: { lines: [{ take: "gen_voice_en1", startSeconds: 2.5, text: "Every great film" }, { take: "gen_voice_en2", startSeconds: 6, text: "starts small", volume: 0.9 }] },
    hi: {
      lines: [{ take: "gen_voice_hi1", startSeconds: 2.5, text: "हर अच्छी फ़िल्म" }],
      swap: { gen_shot3: "gen_shot3_lipsync_hi" },
    },
  },
};

test("the draft's schema takes the cut and the voices exactly as the Edit step writes them", () => {
  const project = newProject("Board");
  expect(projectSchema.safeParse({ ...project, ...GOOD }).success).toBe(true);
  expect(projectSchema.safeParse({ ...project, boardCut: { shots: [{ take: "gen_a" }, { take: "gen_b", trim: { startSeconds: 1, endSeconds: 4 }, hasAudio: true }] } }).success).toBe(true);
  expect(projectSchema.safeParse({ ...project }).success).toBe(true);
});

test("it refuses URLs and paths, unknown fields, bad language codes, overlong text and too many of anything", () => {
  const project = newProject("Board");
  const bad = (extra: Record<string, unknown>) => projectSchema.safeParse({ ...project, ...extra }).success;
  expect(bad({ boardCut: { shots: [{ take: "https://example.test/a.mp4" }] } })).toBe(false);
  expect(bad({ boardCut: { shots: [{ take: "../a" }] } })).toBe(false);
  expect(bad({ boardCut: { shots: [{ url: "x" }] } })).toBe(false);
  expect(bad({ boardCut: { shots: Array.from({ length: CUT_DATA_LIMITS.shots + 1 }, (_, i) => ({ take: `g${i}` })) } })).toBe(false);
  expect(bad({ boardCut: { music: { take: "a", upload: "b" } } })).toBe(false);
  expect(bad({ boardCut: { music: {} } })).toBe(false);
  expect(bad({ boardCut: { music: { url: "https://example.test/m.mp3" } } })).toBe(false);
  expect(bad({ boardCut: { captions: "sparkly" } })).toBe(false);
  expect(bad({ boardCut: { duck: 2 } })).toBe(false);
  expect(bad({ boardCut: { title: { title: "x".repeat(CUT_DATA_LIMITS.text + 1) } } })).toBe(false);
  expect(bad({ boardCut: { title: { title: "ok", durationSeconds: 30 } } })).toBe(false);
  expect(bad({ boardCut: { surprise: true } })).toBe(false);
  expect(bad({ boardVoice: { English: { lines: [] } } })).toBe(false);
  expect(bad({ boardVoice: { en: { lines: [{ take: "a", startSeconds: -1, text: "x" }] } } })).toBe(false);
  expect(bad({ boardVoice: { en: { lines: [{ take: "a", startSeconds: 1, text: "x", url: "https://x.test" }] } } })).toBe(false);
  expect(bad({ boardVoice: { en: { lines: Array.from({ length: CUT_DATA_LIMITS.lines + 1 }, (_, i) => ({ take: `v${i}`, startSeconds: i, text: "x" })) } } })).toBe(false);
  expect(bad({ boardVoice: { en: { lines: [], swap: { a: "https://x.test/b.mp4" } } } })).toBe(false);
  expect(bad({ boardVoice: Object.fromEntries(Array.from({ length: CUT_DATA_LIMITS.languages + 1 }, (_, i) => [`a${String.fromCharCode(97 + i)}`, { lines: [] }])) })).toBe(false);
});

test("a language's voice is cleaned to what the draft keeps: well-formed lines in time order, bounded text, swaps by take id", () => {
  const voice = cleanLanguageVoice({
    lines: [
      { take: "late", startSeconds: 9, text: "  two   spaces " },
      { take: "early", startSeconds: 1, text: "x".repeat(500), volume: 4 },
      { take: "bad id", startSeconds: 2, text: "no" },
      { take: "neg", startSeconds: -3, text: "no" },
      { take: "nan", startSeconds: Number.NaN, text: "no" },
      null,
    ],
    swap: { a: "b", "bad id": "c", d: "https://x.test", e: 4 },
  });
  expect(voice.lines.map((l) => [l.take, l.startSeconds])).toEqual([["early", 1], ["late", 9]]);
  expect(voice.lines[0].text).toHaveLength(CUT_DATA_LIMITS.text);
  expect(voice.lines[0].volume).toBe(1);
  expect(voice.lines[1].text).toBe("two spaces");
  expect(voice.swap).toEqual({ a: "b" });
  expect(cleanLanguageVoice("nonsense")).toEqual({ lines: [] });
});

test("a language is written whole, read back as a copy, and removed when it has nothing; refusals leave the voices as they were", () => {
  const hindi = { lines: [{ take: "gen_voice_hi1", startSeconds: 2.5, text: "namaste" }], swap: { s: "t" } };
  let voice: BoardVoice = withLanguageVoice(undefined, "hi", hindi);
  expect(voiceOf(voice, "hi")).toEqual(hindi);
  expect(voiceOf(voice, "en")).toEqual({ lines: [] });
  expect(voiceOf(voice, "constructor")).toEqual({ lines: [] });
  voiceOf(voice, "hi").lines.length = 0;
  expect(voiceOf(voice, "hi").lines).toHaveLength(1);
  voice = withLanguageVoice(voice, "en", { lines: [{ take: "v", startSeconds: 0, text: "hello" }] });
  voice = withLanguageVoice(voice, "hi", { lines: [{ take: "w", startSeconds: 1, text: "again" }] });
  expect(voice.hi).toEqual({ lines: [{ take: "w", startSeconds: 1, text: "again" }] });
  expect(Object.keys(voice).sort()).toEqual(["en", "hi"]);
  expect(withLanguageVoice(voice, "Hindi", hindi)).toBe(voice);
  expect(withLanguageVoice(voice, "hi", { lines: [] })).toEqual({ en: voice.en });
  let many: BoardVoice = {};
  for (let i = 0; i < CUT_DATA_LIMITS.languages; i += 1) many = withLanguageVoice(many, `a${String.fromCharCode(97 + i)}`, hindi);
  expect(withLanguageVoice(many, "zz", hindi)).toBe(many);
  expect(projectSchema.safeParse({ ...newProject("Board"), boardVoice: many }).success).toBe(true);
});

/* A take id also keys `swap`, so a name every object inherits (`constructor`, `__proto__`, …) would find the inherited value, not
   a saved one. Tied to Object.prototype itself, so a name the runtime adds is covered or this fails. */
test("names every object inherits are never a take id: the schema refuses them, the cleaners drop them, swaps keyed by them go", () => {
  const project = newProject("Board");
  const parse = (extra: Record<string, unknown>) => projectSchema.safeParse({ ...project, ...extra });
  for (const name of [...Object.getOwnPropertyNames(Object.prototype), "prototype"]) {
    expect(TAKE_ID.test(name), name).toBe(false);
    expect(parse({ boardCut: { shots: [{ take: name }] } }).success, name).toBe(false);
    expect(parse({ boardCut: { music: { take: name } } }).success, name).toBe(false);
    expect(parse({ boardVoice: { hi: { lines: [{ take: name, startSeconds: 1, text: "x" }] } } }).success, name).toBe(false);
    expect(parse({ boardVoice: { hi: { lines: [], swap: { ok: name } } } }).success, name).toBe(false);
    /* As a swap's key: refused, or (zod skips `__proto__`) dropped, never kept. */
    const keyed = parse({ boardVoice: { hi: { lines: [], swap: Object.fromEntries([[name, "ok"]]) } } });
    if (keyed.success) expect(Object.hasOwn(keyed.data.boardVoice?.hi?.swap ?? {}, name), name).toBe(false);
    expect(cleanCutShots([{ take: name }, { take: "ok" }]), name).toEqual([{ take: "ok" }]);
    const voice = cleanLanguageVoice({ lines: [{ take: name, startSeconds: 1, text: "x" }], swap: Object.fromEntries([[name, "ok"], ["a", name], ["s", "t"]]) });
    expect(voice.lines, name).toEqual([]);
    expect(Object.getOwnPropertyNames(voice.swap), name).toEqual(["s"]);
    expect(Object.getPrototypeOf(voice.swap), name).toBe(Object.prototype);
  }
  for (const ok of ["constructors", "my-prototype", "toStringify", "gen_valueOf"]) expect(TAKE_ID.test(ok), ok).toBe(true);
});

test("a trim ends after it starts: the schema refuses one that does not, and the cleaner drops it so the shot plays whole", () => {
  const project = newProject("Board");
  const withTrim = (trim: unknown) => projectSchema.safeParse({ ...project, boardCut: { shots: [{ take: "gen_a", trim }] } }).success;
  expect(withTrim({ startSeconds: 1, endSeconds: 4 })).toBe(true);
  expect(withTrim({ startSeconds: 4, endSeconds: 4 })).toBe(false);
  expect(withTrim({ startSeconds: 4, endSeconds: 1 })).toBe(false);
  expect(cleanTrim({ startSeconds: 1, endSeconds: 4 })).toEqual({ startSeconds: 1, endSeconds: 4 });
  for (const bad of [{ startSeconds: 4, endSeconds: 4 }, { startSeconds: 4, endSeconds: 1 }, { startSeconds: -1, endSeconds: 2 }, { startSeconds: 0, endSeconds: Number.NaN }, { startSeconds: 0 }, "0-4", null]) {
    expect(cleanTrim(bad), JSON.stringify(bad)).toBeUndefined();
  }
  const shots = cleanCutShots([
    { take: "gen_a", trim: { startSeconds: 4, endSeconds: 1 }, hasAudio: true },
    { take: "gen_b", trim: { startSeconds: 1, endSeconds: 4 } },
    { take: "https://x.test/c.mp4" },
    ...Array.from({ length: CUT_DATA_LIMITS.shots }, (_, i) => ({ take: `g${i}` })),
  ]);
  expect(shots.slice(0, 2)).toEqual([{ take: "gen_a", hasAudio: true }, { take: "gen_b", trim: { startSeconds: 1, endSeconds: 4 } }]);
  expect(shots).toHaveLength(CUT_DATA_LIMITS.shots);
  /* Whatever the cleaner keeps, the schema takes. */
  expect(projectSchema.safeParse({ ...project, boardCut: { shots } }).success).toBe(true);
});

/* Deliver allows MAX_LANGUAGES target languages; the film as made (`en`) may carry a voice of its own on top of them. */
test("the voices hold every language Deliver allows plus the film as made, and no more", () => {
  expect(CUT_DATA_LIMITS.languages).toBe(MAX_LANGUAGES + 1);
  const line = { lines: [{ take: "gen_v", startSeconds: 0, text: "x" }] };
  const targets = Array.from({ length: MAX_LANGUAGES }, (_, i) => `b${String.fromCharCode(97 + i)}`);
  let voice: BoardVoice = withLanguageVoice(undefined, "en", line);
  for (const code of targets) voice = withLanguageVoice(voice, code, line);
  expect(Object.keys(voice)).toHaveLength(MAX_LANGUAGES + 1);
  expect(projectSchema.safeParse({ ...newProject("Board"), boardVoice: voice }).success).toBe(true);
  expect(withLanguageVoice(voice, "zz", line)).toBe(voice);
  expect(withLanguageVoice(voice, "hi", line)).toBe(voice);
  /* Rewriting a language already there is not one more. */
  expect(withLanguageVoice(voice, "en", { lines: [{ take: "gen_w", startSeconds: 1, text: "y" }] }).en.lines[0].take).toBe("gen_w");
  expect(projectSchema.safeParse({ ...newProject("Board"), boardVoice: { ...voice, zz: line } }).success).toBe(false);
});
