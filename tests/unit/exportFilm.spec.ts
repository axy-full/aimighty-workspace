import { test, expect } from "@playwright/test";
import { filmRequest } from "../../lib/exports/film";
import { newProject, type Asset, type Project } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";

/**
 * A board's film in one language (lib/exports/film.ts): read from the board's own draft, never from a client's say-so, and
 * handed to the assembly tool. Pure: the draft in, an assembly request or the plain reason out.
 */
const asset = (id: string, extra: Partial<Asset> = {}): Asset => ({ id, name: id, kind: "video", category: "", url: "/api/media/x", description: "", prompt: "", status: "Selected", locked: false, version: 1, refs: [], ...extra } as Asset);
const HINDI = ["हर अच्छी फ़िल्म", "एक छोटी कहानी"];

function board(extra: Partial<Project> = {}): Project {
  return {
    ...newProject("Monsoon"), aspect: "16:9", fps: 30,
    assets: [asset("a1", { generationId: "take_1", seconds: 5 }), asset("a2", { generationId: "take_2", seconds: 6 }), asset("a3", { uploadId: "upload_3" })],
    shots: [
      { id: "s1", name: "Shot 1", assetId: "a1", duration: 150, sourceIn: 0, note: "" },
      { id: "s2", name: "Shot 2", assetId: "a2", duration: 90, sourceIn: 30, note: "" },
      { id: "s3", name: "Shot 3", assetId: "a3", duration: 60, sourceIn: 0, note: "" },
    ],
    boardCut: { title: { title: "Monsoon", durationSeconds: 2 }, end: { headline: "Coming soon" }, captions: "bold", duck: 0.3 },
    boardVoice: {
      en: { lines: [{ take: "voice_en1", startSeconds: 2.5, text: "Every great film" }] },
      hi: { lines: [{ take: "voice_hi1", startSeconds: 2.5, text: HINDI[0] }, { take: "voice_hi2", startSeconds: 7, text: HINDI[1] }], swap: { take_2: "take_2_hi" } },
    },
    ...extra,
  };
}
const ok = (result: ReturnType<typeof filmRequest>) => { if (!result.ok) throw new Error(result.error); return result; };

test("the film is the edit's sequence with its trims, a take or an upload each, and the board's cards", () => {
  const film = ok(filmRequest(board(), "en", "film-req-0001"));
  expect(film.shots).toBe(3);
  expect(film.request.timeline.shots).toEqual([
    { take: "take_1" },
    { take: "take_2", trim: { startSeconds: 1, endSeconds: 4 } },
    { upload: "upload_3" },
  ]);
  expect(film.request.timeline).toMatchObject({ aspect: "16:9", fps: 30, captions: "bold", duck: 0.3, title: { title: "Monsoon", durationSeconds: 2 }, end: { headline: "Coming soon" } });
  expect(film.request.timeline.voice).toEqual([{ take: "voice_en1", startSeconds: 2.5, text: "Every great film" }]);
  expect(film.request.output).toEqual({ subtitles: ["srt", "vtt"] });
  expect(film.request.requestId).toBe("film-req-0001");
});

test("Hindi swaps the shots that language replaces, places its own lines, and keeps their words whole for the captions and subtitles", () => {
  const film = ok(filmRequest(board(), "hi", "film-req-0002"));
  expect(film.request.timeline.shots.map((s) => ("take" in s ? s.take : s.upload))).toEqual(["take_1", "take_2_hi", "upload_3"]);
  expect(film.request.timeline.voice?.map((v) => [v.take, v.startSeconds, v.text])).toEqual([["voice_hi1", 2.5, HINDI[0]], ["voice_hi2", 7, HINDI[1]]]);
  expect(film.voiceLines).toBe(2);
  /* English never takes another language's swaps or lines. */
  expect(ok(filmRequest(board(), "en", "film-req-0003")).request.timeline.shots.map((s) => ("take" in s ? s.take : s.upload))).toContain("take_2");
});

test("the cut's own shot list wins over the sequence, and a shot's own sound is its choice", () => {
  const film = ok(filmRequest(board({ boardCut: { shots: [{ take: "take_9", hasAudio: true }, { take: "take_8", trim: { startSeconds: 0, endSeconds: 2 } }] } }), "en", "film-req-0004"));
  expect(film.request.timeline.shots).toEqual([{ take: "take_9", hasAudio: true }, { take: "take_8", trim: { startSeconds: 0, endSeconds: 2 } }]);
});

test("what cannot be made says why before anything is queued", () => {
  const why = (project: Project, language = "en") => { const r = filmRequest(project, language, "film-req-0005"); return r.ok ? "ok" : r.error; };
  expect(why(board({ shots: [] }))).toBe("Nothing to export yet: the cut has no shots.");
  expect(why(board({ aspect: "1:1" }))).toContain("16:9 and 9:16");
  expect(why(board({ boardVoice: undefined }), "hi")).toBe("There is no Hindi version yet: it needs Hindi voice lines.");
  expect(why(board(), "Hindi")).toContain("isn't one the film can be made in");
  expect(why(board({ assets: [asset("a1"), asset("a2"), asset("a3")] }))).toContain("isn't a take or an upload yet");
  expect(why(board({ boardCut: { shots: Array.from({ length: 25 }, (_, i) => ({ take: `t${i}` })) } }))).toContain("at most 24 shots");
  /* A language that only swaps shots (no voice) is still a version; English with no voice is the film as made. */
  expect(why(board({ boardVoice: { hi: { lines: [], swap: { take_2: "take_2_hi" } } } as never }), "hi")).toBe("ok");
  expect(why(board({ boardVoice: undefined }))).toBe("ok");
});

test("lines without words ask for no subtitle files (there would be nothing to write); one with words does", () => {
  const silent = ok(filmRequest(board({ boardVoice: { en: { lines: [{ take: "voice_en1", startSeconds: 1, text: "" }] } } }), "en", "film-req-0006"));
  expect(silent.request.output).toBeUndefined();
  expect(ok(filmRequest(board(), "en", "film-req-0007")).request.output).toEqual({ subtitles: ["srt", "vtt"] });
});

test("the draft's own fields are what it reads: the schema takes the board used here", () => {
  expect(projectSchema.safeParse(board()).success).toBe(true);
});
