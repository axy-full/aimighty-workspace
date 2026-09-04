import { NextResponse, after } from "next/server";
import { db, ready, now, id as newId } from "@/lib/db";
import { requireRender } from "@/lib/auth";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";
import { enqueueRender } from "@/lib/inngest";
import { runInline } from "@/lib/renderWork";
import { elevenConfigured, subscription, SPEECH_MODELS, DEFAULT_SPEECH_MODEL, SFX_MODEL, MUSIC_MODEL, speechCredits, sfxCredits, musicCredits, listVoices, SFX_CREDITS, MUSIC_CREDITS_PER_MINUTE } from "@/lib/elevenlabs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_TEXT = 5000;

/**
 * A voice line, a sound, or a piece of music. Each is a render like any
 * other: a row on the wall and the ledger, made after the response goes
 * out, with what it cost written down when it lands.
 */
export async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  await ready();
  if (!elevenConfigured()) {
    return NextResponse.json({ error: "ElevenLabs isn't connected — set ELEVENLABS_API_KEY in Vercel › Settings › Environment Variables." }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const task = ["speech", "sound", "music"].includes(String(body.task)) ? String(body.task) as "speech" | "sound" | "music" : "speech";
  const text = String(body.text ?? "").trim().slice(0, MAX_TEXT);
  if (!text) return NextResponse.json({ error: task === "speech" ? "Write the line first." : "Describe it first." }, { status: 400 });
  const projectId = body.projectId ? String(body.projectId) : null;

  let modelId = SFX_MODEL;
  let estCredits = 0;
  const params: Record<string, unknown> = { task };
  if (task === "speech") {
    modelId = SPEECH_MODELS.some((m) => m.id === body.modelId) ? String(body.modelId) : DEFAULT_SPEECH_MODEL;
    const voiceId = String(body.voiceId ?? "").trim();
    if (!/^[A-Za-z0-9]{6,64}$/.test(voiceId)) return NextResponse.json({ error: "Pick a voice." }, { status: 400 });
    const num = (v: unknown, lo: number, hi: number) =>
      v == null || v === "" ? undefined : Math.max(lo, Math.min(hi, Number(v)));
    params.voiceId = voiceId;
    params.voiceName = body.voiceName ? String(body.voiceName).slice(0, 80) : undefined;
    params.settings = {
      stability: num(body.stability, 0, 1),
      similarity_boost: num(body.similarity, 0, 1),
      style: num(body.style, 0, 1),
      speed: num(body.speed, 0.7, 1.2),
      use_speaker_boost: body.speakerBoost === false ? false : undefined,
    };
    estCredits = speechCredits(text, modelId);
  } else if (task === "sound") {
    modelId = SFX_MODEL;
    const d = body.durationSeconds == null || body.durationSeconds === "" ? null : Math.max(0.5, Math.min(30, Number(body.durationSeconds)));
    params.durationSeconds = d;
    params.promptInfluence = body.promptInfluence == null ? undefined : Math.max(0, Math.min(1, Number(body.promptInfluence)));
    params.loop = Boolean(body.loop);
    estCredits = sfxCredits();
  } else {
    modelId = MUSIC_MODEL;
    const ms = Math.max(10_000, Math.min(300_000, Number(body.lengthMs ?? 30_000) || 30_000));
    params.lengthMs = ms;
    params.instrumental = Boolean(body.instrumental);
    estCredits = musicCredits(ms);
  }

  const genId = newId("gen");
  const ts = now();
  await db().execute({
    sql: `INSERT INTO generations
          (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by,
           created_at, updated_at, token_id, provider, task, title)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [genId, projectId, null, "audio", modelId, text, JSON.stringify({ ...params, estCredits }),
           "running", got.user.id, ts, ts, got.token?.id ?? null, "elevenlabs", "generate",
           body.title ? String(body.title).slice(0, 80) : null],
  });
  invalidate(PROJECTS_KEY);

  /* Handed to the worker so a reclaimed instance cannot lose a line the
     voice has already spoken and been paid for. No queue reachable means
     the old inline path, unchanged. See lib/renderWork.ts. */
  if (!(await enqueueRender(genId, "audio"))) {
    after(() => runInline(genId));
  }

  return NextResponse.json({ id: genId, status: "running", estCredits });
}

/** What the Audio screen needs to draw itself: engines, terms, and — when
 *  connected — the voices and the account's credit position. */
export async function GET() {
  const got = await requireRender();
  if (got.response) return got.response;
  const configured = elevenConfigured();
  const [voices, account] = configured
    ? await Promise.all([
        listVoices().catch((e: Error) => ({ error: e.message })),
        subscription().catch((e: Error) => ({ error: e.message })),
      ])
    : [[], null];
  return NextResponse.json({
    configured,
    envKey: "ELEVENLABS_API_KEY",
    speechModels: SPEECH_MODELS,
    defaultSpeechModel: DEFAULT_SPEECH_MODEL,
    voices: Array.isArray(voices) ? voices : [],
    voicesError: Array.isArray(voices) ? null : (voices as { error: string }).error,
    account: account && !("error" in account) ? account : null,
    accountError: account && "error" in account ? account.error : null,
    terms: { sfxCredits: SFX_CREDITS, musicCreditsPerMinute: MUSIC_CREDITS_PER_MINUTE },
  });
}
