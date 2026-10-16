import type { Project } from "../workbench/studio";
import { dubbingLanguageLabel } from "../workbench/dubbing-options";
import { BASE_LANGUAGE, LANGUAGE_CODE, voiceOf, type CutShot } from "../v12/board/cut-data";
import { FPS_CHOICES } from "../../remotion/src/lib/types";
import { ASSEMBLE_LIMITS, assembleSchema, type AssembleRequest } from "./assemble";

/**
 * A board's film in one language, as an assembly request (lib/exports/assemble.ts). The Edit step's "Export MP4", Make, Atomik, a
 * saved skill and an outside agent over MCP (`export_film`) all start here: it reads the board's draft, never a client's say-so.
 *
 *  - The shots are the cut's own list (`boardCut.shots`) or, absent, the edit's sequence (`project.shots`): each clip's take (or
 *    upload), in order, trimmed as the sequence trims it.
 *  - A language other than the film's own (`en`) swaps the shots that language replaces (a lip-synced take) and places that
 *    language's voice lines (`boardVoice[language]`, lib/v12/board/cut-data.ts); the words become captions and subtitle files.
 *  - The title, end card, music, caption style and ducking are the cut's (`boardCut`).
 *
 * Pure: no database, no worker. Anything that cannot be made says why in plain words, before anything is queued.
 */

export type FilmResult = { ok: true; request: AssembleRequest; shots: number; voiceLines: number } | { ok: false; error: string };

const fail = (error: string): FilmResult => ({ ok: false, error });
const ASPECTS = ["16:9", "9:16"];

export function filmRequest(project: Project, language: string, requestId: string): FilmResult {
  if (!LANGUAGE_CODE.test(language)) return fail("That language isn't one the film can be made in.");
  const label = dubbingLanguageLabel(language);
  const cut = project.boardCut ?? {};
  const voice = voiceOf(project.boardVoice, language);
  if (!ASPECTS.includes(project.aspect)) return fail(`The film export makes 16:9 and 9:16 films; this board is ${project.aspect}.`);

  /* The shots: the cut's own list, else the edit's sequence. */
  const assets = new Map([...project.assets, ...(project.sharedAssets ?? [])].map((asset) => [asset.id, asset] as const));
  const fps = Math.max(1, project.fps);
  const planned: CutShot[] = [];
  let upload: Map<number, string> | null = null;
  if (cut.shots?.length) planned.push(...cut.shots);
  else {
    upload = new Map();
    for (const shot of project.shots) {
      const asset = assets.get(shot.assetId);
      if (!asset?.generationId && !asset?.uploadId) return fail(`${shot.name || "A clip"} isn't a take or an upload yet, so it can't be exported.`);
      const start = shot.sourceIn / fps;
      const end = Math.min((shot.sourceIn + shot.duration) / fps, asset.seconds ?? Number.POSITIVE_INFINITY);
      const whole = start < 0.01 && (asset.seconds == null || end >= asset.seconds - 0.05);
      if (asset.generationId) planned.push({ take: asset.generationId, ...(whole || end <= start ? {} : { trim: { startSeconds: start, endSeconds: end } }) });
      else { upload.set(planned.length, asset.uploadId!); planned.push({ take: "", ...(whole || end <= start ? {} : { trim: { startSeconds: start, endSeconds: end } }) }); }
    }
  }
  if (!planned.length) return fail("Nothing to export yet: the cut has no shots.");
  if (planned.length > ASSEMBLE_LIMITS.shots) return fail(`A film is at most ${ASSEMBLE_LIMITS.shots} shots; this cut has ${planned.length}.`);

  const swapped = language === BASE_LANGUAGE ? {} : voice.swap ?? {};
  const shots = planned.map((shot, index) => {
    const media = upload?.has(index) ? { upload: upload.get(index)! } : { take: swapped[shot.take] ?? shot.take };
    return { ...media, ...(shot.trim ? { trim: shot.trim } : {}), ...(shot.hasAudio ? { hasAudio: true } : {}) };
  });

  const lines = language === BASE_LANGUAGE || voice.lines.length ? voice.lines : [];
  if (language !== BASE_LANGUAGE && !lines.length && !Object.keys(swapped).length) return fail(`There is no ${label} version yet: it needs ${label} voice lines.`);
  const spoken = lines.some((line) => line.text);

  const candidate = {
    requestId,
    timeline: {
      aspect: project.aspect,
      ...((FPS_CHOICES as readonly number[]).includes(project.fps) ? { fps: project.fps } : {}),
      ...(cut.title ? { title: cut.title } : {}),
      shots,
      ...(lines.length ? { voice: lines.map((line) => ({ take: line.take, startSeconds: line.startSeconds, ...(line.text ? { text: line.text } : {}), ...(line.volume !== undefined ? { volume: line.volume } : {}) })) } : {}),
      ...(cut.music ? { music: cut.music } : {}),
      ...(cut.captions !== undefined ? { captions: cut.captions } : {}),
      ...(cut.end ? { end: cut.end } : {}),
      ...(cut.duck !== undefined ? { duck: cut.duck } : {}),
    },
    ...(spoken ? { output: { subtitles: ["srt", "vtt"] } } : {}),
  };
  const parsed = assembleSchema.safeParse(candidate);
  if (!parsed.success) return fail("The cut's settings can't be exported as they are. Check the shots, the voice lines and the cards.");
  return { ok: true, request: parsed.data, shots: shots.length, voiceLines: lines.length };
}
