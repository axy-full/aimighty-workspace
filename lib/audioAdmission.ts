import { allowanceCheck } from "@/lib/allowance";
import { db, ready, now, id as newId } from "@/lib/db";

import { invalidate, PROJECTS_KEY } from "@/lib/cache";
import { enqueueRender } from "@/lib/inngest";
import { runInline } from "@/lib/renderWork";
import {
  elevenConfigured,
  usdForCredits,
  SPEECH_MODELS,
  DEFAULT_SPEECH_MODEL,
  SFX_MODEL,
  MUSIC_MODEL,
  DIALOGUE_MODEL,
  DIALOGUE_MAX_CHARS,
  DIALOGUE_MAX_VOICES,
  speechCredits,
  sfxCredits,
  musicCredits,
  dialogueCredits,
  type DialogueLine,
} from "@/lib/elevenlabs";
import { getShot } from "@/lib/shots";
import {
  bindGenerationRequest,
  reserveGenerationSpend,
  SpendReservationError,
} from "@/lib/generationRequests";
import { billCredits } from "@/lib/creditTerms";
import {
  heldInfo,
  heldMessage,
  heldCount,
  notifyHeld,
  HELD_LIMIT,
} from "@/lib/held";
import { creditState, creditsApply } from "@/lib/credits";
import { requireTenant } from "@/lib/tenant";
import { checkCap } from "@/lib/caps";
import { checkLimits, checkQuota, slotsMessage } from "@/lib/limits";

import type {
  AdmissionActor,
  AdmissionExecution,
  AdmissionReply,
  PreparedAdmission,
  PrepareAdmissionResult,
} from "./admissionTypes";
import {
  admissionReply,
  admissionCheckpoint,
  prepareAdmission,
  admitPrepared,
  assertAdmissionActor,
} from "./admissionSupport";

const MAX_TEXT = 5000;
export type AudioTask = "speech" | "sound" | "music" | "dialogue";
const AUDIO_TASKS: AudioTask[] = ["speech", "sound", "music", "dialogue"];
const VOICE_ID = /^[A-Za-z0-9]{6,64}$/;

/** Dialogue lines as the vendor takes them: text per voice, within its caps.
 *  Returns a sentence when the request cannot be priced. */
export function normalizeDialogueLines(
  raw: unknown,
): { lines: DialogueLine[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length)
    return { error: "Write the lines first." };
  if (raw.length > 200) return { error: "A dialogue takes up to 200 lines." };
  const lines: DialogueLine[] = [];
  for (const item of raw) {
    const line = (item ?? {}) as { text?: unknown; voiceId?: unknown };
    const text = String(line.text ?? "").trim();
    const voiceId = String(line.voiceId ?? "").trim();
    if (!text) return { error: "Every line needs its text." };
    if (!VOICE_ID.test(voiceId)) return { error: "Pick a voice for every line." };
    lines.push({ text, voiceId });
  }
  const chars = lines.reduce((n, line) => n + line.text.length, 0);
  if (chars > DIALOGUE_MAX_CHARS)
    return {
      error: `A dialogue takes up to ${DIALOGUE_MAX_CHARS.toLocaleString("en-US")} characters per request; this one has ${chars.toLocaleString("en-US")}.`,
    };
  const voices = new Set(lines.map((line) => line.voiceId));
  if (voices.size > DIALOGUE_MAX_VOICES)
    return {
      error: `A dialogue takes up to ${DIALOGUE_MAX_VOICES} voices per request.`,
    };
  return { lines };
}

/** Audio preparation and admission share the exact normalizer and price calculation. */
export async function executeAudioAdmission(
  input: Record<string, unknown>,
  got: AdmissionActor,
  options: AdmissionExecution,
): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = structuredClone(input);
  const quoteOnly = body.quoteOnly === true;
  const requestClaim = options.requestClaim;
  await ready();
  const allowance = await allowanceCheck("elevenlabs");
  if (!allowance.ok && allowance.status !== 402)
    return admissionReply(
      { error: allowance.error },
      { status: allowance.status },
    );
  if (!allowance.ok && (await heldCount()) >= HELD_LIMIT) {
    return admissionReply(
      {
        error: `${HELD_LIMIT} takes are already held for credits. Top up to release them before adding more.`,
      },
      { status: 402 },
    );
  }
  if (!elevenConfigured()) {
    return admissionReply(
      {
        error:
          "Sound isn't connected for this workspace. Ask the platform to connect it.",
      },
      { status: 400 },
    );
  }

  const task = AUDIO_TASKS.includes(String(body.task) as AudioTask)
    ? (String(body.task) as AudioTask)
    : "speech";
  /* Dialogue arrives as lines; the prompt column keeps a readable transcript
     so Activity and the library show what was said, as they do for a line. */
  const dialogue =
    task === "dialogue" ? normalizeDialogueLines(body.lines) : null;
  if (dialogue && "error" in dialogue)
    return admissionReply({ error: dialogue.error }, { status: 400 });
  const text = (
    dialogue
      ? dialogue.lines.map((line) => line.text).join("\n")
      : String(body.text ?? "")
  )
    .trim()
    .slice(0, MAX_TEXT);
  if (!text)
    return admissionReply(
      {
        error:
          task === "speech" ? "Write the line first." : "Describe it first.",
      },
      { status: 400 },
    );
  let projectId = body.projectId ? String(body.projectId) : null;
  /* Filed against a shot at birth, the way a take is. A track has no
     version of its own — tracks read A1, A2… in the order they were made —
     but it belongs to the shot and lists under it. */
  const shotId = body.shotId ? String(body.shotId) : null;
  if (shotId) {
    const shot = await getShot(shotId);
    if (!shot)
      return admissionReply({ error: "That shot is gone." }, { status: 400 });
    if (projectId && shot.projectId && shot.projectId !== projectId) {
      return admissionReply(
        { error: "That shot belongs to another production." },
        { status: 400 },
      );
    }
    projectId ??= shot.projectId;
  }
  if (
    projectId &&
    !(
      await db().execute({
        sql: "SELECT id FROM projects WHERE id=?",
        args: [projectId],
      })
    ).rows.length
  ) {
    return admissionReply(
      { error: "That production is not in this workspace." },
      { status: 404 },
    );
  }

  let modelId = SFX_MODEL;
  let estCredits = 0;
  const params: Record<string, unknown> = { task };
  if (task === "speech") {
    modelId = SPEECH_MODELS.some((m) => m.id === body.modelId)
      ? String(body.modelId)
      : DEFAULT_SPEECH_MODEL;
    const voiceId = String(body.voiceId ?? "").trim();
    if (!VOICE_ID.test(voiceId))
      return admissionReply({ error: "Pick a voice." }, { status: 400 });
    const num = (v: unknown, lo: number, hi: number) =>
      v == null || v === "" || !Number.isFinite(Number(v))
        ? undefined
        : Math.max(lo, Math.min(hi, Number(v)));
    params.voiceId = voiceId;
    params.voiceName = body.voiceName
      ? String(body.voiceName).slice(0, 80)
      : undefined;
    params.settings = {
      stability: num(body.stability, 0, 1),
      similarity_boost: num(body.similarity, 0, 1),
      style: num(body.style, 0, 1),
      speed: num(body.speed, 0.7, 1.2),
      use_speaker_boost: body.speakerBoost === false ? false : undefined,
    };
    estCredits = speechCredits(text, modelId);
  } else if (task === "dialogue") {
    modelId = DIALOGUE_MODEL;
    params.lines = dialogue!.lines;
    estCredits = dialogueCredits(dialogue!.lines);
  } else if (task === "sound") {
    modelId = SFX_MODEL;
    const d =
      body.durationSeconds == null ||
      body.durationSeconds === "" ||
      !Number.isFinite(Number(body.durationSeconds))
        ? null
        : Math.max(0.5, Math.min(30, Number(body.durationSeconds)));
    params.durationSeconds = d;
    params.promptInfluence =
      body.promptInfluence == null ||
      !Number.isFinite(Number(body.promptInfluence))
        ? undefined
        : Math.max(0, Math.min(1, Number(body.promptInfluence)));
    params.loop = Boolean(body.loop);
    estCredits = sfxCredits();
  } else {
    modelId = MUSIC_MODEL;
    const ms = Math.max(
      10_000,
      Math.min(300_000, Number(body.lengthMs ?? 30_000) || 30_000),
    );
    params.lengthMs = ms;
    params.instrumental = Boolean(body.instrumental);
    estCredits = musicCredits(ms);
  }

  const genId = newId("gen");
  const estimatedCredits = billCredits(
    usdForCredits(estCredits, null),
    "elevenlabs",
  );
  if (quoteOnly)
    return admissionReply({
      estimatedCredits,
      price: creditsApply(requireTenant())
        ? estimatedCredits
        : usdForCredits(estCredits, null),
      unit: creditsApply(requireTenant()) ? "cr" : "usd",
    });
  if (
    body.maxCredits != null &&
    (!Number.isInteger(body.maxCredits) ||
      body.maxCredits < 0 ||
      estimatedCredits > body.maxCredits)
  ) {
    return admissionReply(
      {
        error:
          "The audio estimate exceeds the approved credit amount. Review the price before submitting.",
      },
      { status: 409 },
    );
  }
  const wall = await allowanceCheck(
    "elevenlabs",
    usdForCredits(estCredits, null),
    "elevenlabs",
  );
  if (!wall.ok && wall.status !== 402)
    return admissionReply({ error: wall.error }, { status: wall.status });
  let hold = !wall.ok
    ? heldInfo(usdForCredits(estCredits, null), "audio", modelId)
    : null;
  const capV = await checkCap(
    projectId,
    usdForCredits(estCredits, null),
    "elevenlabs",
  );
  if (!capV.allow)
    return admissionReply({ error: capV.error }, { status: 409 });
  const lim = await checkLimits();
  if (!lim.allow && lim.why === "rate")
    return admissionReply({ error: lim.error }, { status: 429 });
  if (!hold && !lim.allow)
    hold = heldInfo(usdForCredits(estCredits, null), "audio", modelId, "slots");
  const quota = await checkQuota(0);
  if (!quota.allow)
    return admissionReply({ error: quota.error }, { status: 507 });
  const stopped = admissionCheckpoint(
    options,
    body,
    got,
    "audio",
    usdForCredits(estCredits, null),
    "elevenlabs",
    {
      task,
      text,
      modelId,
      params,
      estCredits,
      projectId,
      shotId,
    },
  );
  if (stopped) return stopped;
  const ts = now();
  await db().execute({
    sql: `INSERT INTO generations
          (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by,
           created_at, updated_at, token_id, provider, task, title, billed_to, shot_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      genId,
      projectId,
      null,
      "audio",
      modelId,
      text,
      JSON.stringify({
        ...params,
        estCredits,
        ...(hold ? { held: hold } : {}),
      }),
      hold ? "held" : "running",
      got.user.id,
      ts,
      ts,
      got.token?.id ?? null,
      "elevenlabs",
      "generate",
      body.title ? String(body.title).slice(0, 80) : null,
      "elevenlabs",
      shotId,
    ],
  });
  await bindGenerationRequest(requestClaim!, genId);
  invalidate(PROJECTS_KEY);
  if (hold) {
    if (hold.why === "slots") {
      return admissionReply(
        {
          id: genId,
          status: "held",
          held: true,
          why: "slots",
          notices: [slotsMessage(lim.standing.running, lim.limits.concurrency)],
        },
        { status: 202 },
      );
    }
    const left = (await creditState())?.balance ?? 0;
    await notifyHeld({ id: genId, needs: hold.needs, left }).catch(() => {});
    return admissionReply(
      {
        id: genId,
        status: "held",
        held: true,
        needs: hold.needs,
        notices: [heldMessage(hold.needs, left)],
      },
      { status: 202 },
    );
  }
  try {
    await reserveGenerationSpend(
      {
        id: genId,
        kind: "audio",
        engine: "elevenlabs",
        model: modelId,
        status: "running",
        engineCostUsd: usdForCredits(estCredits, null),
        projectId,
        shotId,
        createdBy: got.user.id,
      },
      { token: got.token },
    );
  } catch (e) {
    if (
      e instanceof SpendReservationError &&
      (e.status === 402 || /Every job slot/.test(e.message))
    ) {
      const held = heldInfo(
        usdForCredits(estCredits, null),
        "audio",
        modelId,
        e.status === 402 ? "credits" : "slots",
      );
      await db().execute({
        sql: `UPDATE generations SET status='held',params=json_set(params,'$.held',json(?)),updated_at=? WHERE id=?`,
        args: [JSON.stringify(held), now(), genId],
      });
      return admissionReply(
        {
          id: genId,
          status: "held",
          held: true,
          why: held.why,
          needs: held.needs,
          notices: [e.message],
        },
        { status: 202 },
      );
    }
    await db().execute({
      sql: `UPDATE generations SET status='failed', error=?, updated_at=? WHERE id=?`,
      args: [(e as Error).message, now(), genId],
    });
    invalidate(PROJECTS_KEY);
    return admissionReply(
      { error: (e as Error).message },
      { status: e instanceof SpendReservationError ? e.status : 503 },
    );
  }

  /* Handed to the worker so a reclaimed instance cannot lose a line the
     voice has already spoken and been paid for. No queue reachable means
     the old inline path, unchanged. See lib/renderWork.ts. */
  if (!(await enqueueRender(genId, "audio"))) {
    await options.defer(() => runInline(genId));
  }

  return admissionReply({
    id: genId,
    status: "running",
    estCredits,
    estimatedCredits,
    notices: capV.notice ? [capV.notice] : undefined,
  });
}

export function prepareAudio(
  input: Record<string, unknown>,
  actor: AdmissionActor,
): Promise<PrepareAdmissionResult> {
  const request = { ...input };
  delete request.quoteOnly;
  return prepareAdmission(request, actor, executeAudioAdmission);
}
export function quoteAudio(prepared: PreparedAdmission) {
  return prepared.quote;
}
export function admitAudio(
  prepared: PreparedAdmission,
  actor: AdmissionActor,
  options: { requestKey: string; defer: AdmissionExecution["defer"] },
): Promise<AdmissionReply> {
  return admitPrepared(
    prepared,
    actor,
    options,
    "audio",
    executeAudioAdmission,
  );
}
