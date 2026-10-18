import { db, ready, now, id as newId } from "./db";
import { creditsApply, quotedCredits } from "./credits";
import { requireTenant } from "./tenant";
import { engineEnabled } from "./engineGate";
import { isPersonApprover } from "./workbench/plan-approval";
import { isAgentId } from "./security/people-only";
import { actingViewer, NO_ACTING_PERSON } from "./actingViewer";
import { mayReachProject } from "./draftProject";
import { executeBflAdmission, bflQuote, megapixels } from "./bflImage";
import { BFL_IDENTITY_SWITCH, BFL_SWITCH, bflConfigured } from "./bfl";
import { BFL_RATES, type Flux2Model } from "./vendorRates";
import { executeGenerationAdmission, prepareGeneration } from "./generationAdmission";
import { NANO_BANANA_PRO_ID } from "./models";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, assertAdmissionActor } from "./admissionSupport";
import { createIdentity } from "./identities";
import { nameProblem } from "./cast";
import { checkQuota } from "./limits";
import { identifyImage } from "./imagemeta";
import { readOriginalBytesLimited, storeUpload } from "./storage";
import { newEntry, type Cast, type CastEntry } from "./production/cast";
import { stableId } from "./workbench/stable-id";
import { DraftConflictError, readDraft, saveDraft } from "./workbench/records";

/**
 * The Cast tool: ONE tool that makes an AI-made character, its identity and its character sheet. From a name and a few words it makes the character's front view
 * from words, keeps that still as the character's identity (a record of this workspace, free), and makes the seven other views of the SAME person from it: the sheet
 * is eight stills. One price, one approval.
 *
 * It is a plan, not an engine: every still is an existing tool called through its own public admission (FLUX.2 through `executeBflAdmission`, or Nano Banana Pro
 * through the generation admission), so each keeps its own price path, gates, caps, reservation and ledger line. This file adds no price, no vendor call and no
 * reservation of its own; it quotes by asking the steps to quote, and the identity it keeps is a row, not a purchase.
 *
 * ENGINES. `flux2` (default where it is on and its identity tool is): FLUX.2, the views made from the identity's own photo. `nano-banana-pro`: the views made from the
 * front still as a reference. `engine: "auto"` (the default) is flux2 when it can be, else nano-banana-pro. A reply for an agent's or a person's Agent mode carries ONE all-in
 * price and names no engine; the engine and each still's price are named only to a caller that asks for `detail`.
 *
 * AI-MADE ONLY. There is no face check and no consent record here (owner, 16 Oct 2026): this makes a character from words. A real person's likeness is not made here; it
 * goes through a person's own upload and the consent it needs elsewhere, and this tool takes no photo of anyone.
 *
 * MONEY (CLAUDE.md rule 14). A quote is "up to N cr": the front still is priced exactly, and each of the other seven at the price of a view made from one reference of the
 * front's size, which is what it will be. A person approves that total (`maxCredits`). Each step is then quoted exactly by its own tool just before it runs and asked at
 * that figure; a step that would take the plan past the approved total is not run ("asks again"), and a step that fails costs nothing ("Nothing billed" from its own
 * tool). Only a person approves: an agent's, an MCP caller's or Auto's approval is refused.
 *
 * RETRY. A sheet that stops is finished by asking again with the same `characterId`: one more approval, for the REST of the plan. What is made is skipped, and the identity
 * is kept once. Each still the plan makes is tagged `params.cast = { character, angle }` (the take is the record; nothing new is stored).
 *
 * THE BOARD. With a `draftId` the character is written into that board's Cast (`production.cast`) with its identity and its stills as takes, front first. Writing the board
 * spends nothing.
 */
export const CAST_ANGLES = [
  { id: "front", label: "Front", words: "full body, standing, facing the camera straight on, arms relaxed" },
  { id: "three-quarter-left", label: "Three-quarter left", words: "full body, standing, turned a three-quarter way to the left" },
  { id: "profile-left", label: "Left profile", words: "full body, standing, in profile, facing left" },
  { id: "back", label: "Back", words: "full body, standing, seen from behind" },
  { id: "three-quarter-right", label: "Three-quarter right", words: "full body, standing, turned a three-quarter way to the right" },
  { id: "profile-right", label: "Right profile", words: "full body, standing, in profile, facing right" },
  { id: "face", label: "Face", words: "head and shoulders close-up, facing the camera, a calm neutral expression" },
  { id: "walking", label: "In motion", words: "full body, mid-stride, walking toward the camera" },
] as const;
export type CastAngleId = (typeof CAST_ANGLES)[number]["id"];
export const CAST_STILLS = CAST_ANGLES.length;
/** Every still is 3:4 (CAST_RENDER_RATIO in lib/production/cast.ts), a multiple of 16 on both sides. */
export const CAST_SIZE = { width: 768, height: 1024 } as const;
export const CAST_ENGINES = ["auto", "flux2", "nano-banana-pro"] as const;
export type CastEngine = (typeof CAST_ENGINES)[number];
/** FLUX.2 models the sheet may use (an identity is a FLUX.2 edit; FLUX 3 makes stills from words only). */
const FLUX2_MODELS = Object.keys(BFL_RATES.models) as Flux2Model[];
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const CHARACTER_ID = /^[A-Za-z0-9_.:-]{6,64}$/;
const DESCRIPTION_MAX = 800;
const LOOK_MAX = 300;
const PEOPLE_ONLY = "Only a person approves spending. Atomik, outside agents and tokens can prepare this, never approve it.";
export const CAST_RETRY_NOTE = "To go on, ask again with the same characterId. What is already made is not bought again; your approval covers the rest of the plan, up to the amount you give that time.";
/** How long a still may take to finish before the plan says it is still working. */
const STILL_WAIT_MS = 4 * 60_000;
const POLL_MS = 1_500;

type Reply = AdmissionReply;
const ok = (r: Reply) => r.status === 200;
const errorOf = (r: Reply, fallback: string) => (typeof r.body.error === "string" && r.body.error ? r.body.error : fallback);
type StepPrice = { credits: number; price: number };

/** Where the finished character is written: the board's Cast. A test hands its own. */
export type CastWriter = (owner: string, draftId: string, entry: CastEntry) => Promise<{ written: boolean; note?: string }>;
/** The seams a test uses to stand in for the engines; the route and the MCP tool pass none. */
export type CastSeams = {
  flux2?: (input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution) => Promise<Reply>;
  generate?: (input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution) => Promise<Reply>;
  quoteGenerate?: (input: Record<string, unknown>, got: AdmissionActor) => Promise<Reply>;
  draft?: CastWriter;
  /** Waits for takes to finish (polls the database); a test may make it instant. */
  wait?: (genIds: string[]) => Promise<void>;
};

/* ── What can run here ─────────────────────────────────────────────────────────────────────────────────────── */

async function fluxReady(): Promise<boolean> {
  return bflConfigured() && (await engineEnabled(BFL_SWITCH)) && (await engineEnabled(BFL_IDENTITY_SWITCH));
}
/** Is the Cast tool here: where FLUX.2 is on for this workspace (the house, or a listed one). Nano Banana Pro is the other engine it can use, never the reason it is offered. */
export async function castCharacterOn(): Promise<boolean> {
  return engineEnabled(BFL_SWITCH);
}

/* ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────── */

const clean = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
function characterWords(name: string, description: string, look: string): string {
  return [`${name}: ${description}`, look].filter(Boolean).join(". ").replace(/\.\./g, ".");
}
/** A view's prompt: the same person, the angle, and a plain sheet. Nothing a person typed beyond the description and the look is added. */
export function anglePrompt(words: string, angle: (typeof CAST_ANGLES)[number], fromFront: boolean): string {
  const same = fromFront ? "The same character as the reference, with exactly the same face, hair, clothes and proportions. " : "";
  return `${same}Character reference sheet. ${words}. ${angle.words}. Plain neutral grey background, even soft studio light, one character only. No text, no captions, no borders.`;
}

/* ── The engines, each as the plan asks of it ─────────────────────────────────────────────────────────────── */

type Engine = {
  id: "flux2" | "nano-banana-pro";
  model: string;
  /** The front still, quoted exactly by its own tool. */
  quoteFront(prompt: string): Promise<Reply>;
  front(prompt: string, credits: number): Promise<Reply>;
  /** The estimate of any other view, before the front exists. */
  estimateView(prompt: string): Promise<{ ok: true; price: StepPrice } | { ok: false; reply: Reply }>;
  /** A view of the same character, quoted exactly by its own tool, once the front and the identity exist. */
  quoteView(prompt: string, from: { identityId: string; frontTakeId: string }): Promise<Reply>;
  view(prompt: string, from: { identityId: string; frontTakeId: string }, credits: number): Promise<Reply>;
};

function makeFlux2(got: AdmissionActor, sub: AdmissionExecution, ctx: { model: Flux2Model; projectId: string | null }, seams: CastSeams): Engine {
  const run = seams.flux2 ?? executeBflAdmission;
  const base = { model: ctx.model, width: CAST_SIZE.width, height: CAST_SIZE.height, ...(ctx.projectId ? { projectId: ctx.projectId } : {}) };
  return {
    id: "flux2", model: ctx.model,
    quoteFront: (prompt) => run({ tool: "image", prompt, ...base, quoteOnly: true }, got, sub),
    front: (prompt, credits) => run({ tool: "image", prompt, ...base, maxCredits: credits }, got, sub),
    async estimateView() {
      /* The view's own tool prices a FLUX.2 edit of the identity's one photo, which is the front still: one reference of the same size. The price path is the adapter's (bflQuote, quotedCredits). */
      const priced = bflQuote(ctx.model, megapixels(CAST_SIZE.width, CAST_SIZE.height), [megapixels(CAST_SIZE.width, CAST_SIZE.height)]);
      if ("error" in priced) return { ok: false, reply: admissionReply({ error: priced.error }, { status: 400 }) };
      const credits = quotedCredits(priced.usd, ctx.model);
      return { ok: true, price: { credits, price: creditsApply(requireTenant()) ? credits : priced.usd } };
    },
    quoteView: (prompt, from) => run({ tool: "identity", identityId: from.identityId, prompt, ...base, quoteOnly: true }, got, sub),
    view: (prompt, from, credits) => run({ tool: "identity", identityId: from.identityId, prompt, ...base, maxCredits: credits }, got, sub),
  };
}

function makeNano(got: AdmissionActor, sub: AdmissionExecution, ctx: { projectId: string | null }, seams: CastSeams): Engine {
  const quote = seams.quoteGenerate ?? (async (input, actor) => {
    const prepared = await prepareGeneration(input, actor);
    return prepared.ok ? admissionReply({ estimatedCredits: prepared.value.quote.ceilingCredits ?? prepared.value.quote.estimatedCredits, price: prepared.value.quote.price, unit: prepared.value.quote.unit }) : admissionReply(prepared.body, { status: prepared.status });
  });
  const run = seams.generate ?? executeGenerationAdmission;
  const body = (prompt: string, frontTakeId?: string) => ({ model: NANO_BANANA_PRO_ID, prompt, ratio: "3:4", ...(ctx.projectId ? { projectId: ctx.projectId } : {}), ...(frontTakeId ? { references: [{ genId: frontTakeId, role: "reference_image" }] } : {}) });
  const priceOf = (r: Reply): StepPrice => ({ credits: Number(r.body.estimatedCredits), price: Number(r.body.price) });
  return {
    id: "nano-banana-pro", model: NANO_BANANA_PRO_ID,
    quoteFront: (prompt) => quote(body(prompt), got),
    front: (prompt, credits) => run({ ...body(prompt), maxCredits: credits }, got, sub),
    async estimateView(prompt) {
      const r = await quote(body(prompt), got);
      return ok(r) ? { ok: true, price: priceOf(r) } : { ok: false, reply: r };
    },
    quoteView: (prompt, from) => quote(body(prompt, from.frontTakeId), got),
    view: (prompt, from, credits) => run({ ...body(prompt, from.frontTakeId), maxCredits: credits }, got, sub),
  };
}

/* ── Names, before anything is bought ─────────────────────────────────────────────────────────────────────── */

async function nameTaken(name: string, projectId: string | null, characterId: string | null): Promise<string | null> {
  const identity = (await db().execute({
    sql: `SELECT id FROM identities WHERE LOWER(name) = LOWER(?) AND (project_id IS ? OR project_id IS NULL OR ? IS NULL) LIMIT 1`,
    args: [name, projectId, projectId],
  })).rows[0];
  if (identity) {
    /* A retry of this very character finds its own identity, and is not a clash. */
    const mine = characterId ? await identityOf(characterId) : null;
    if (mine !== String(identity.id)) return `There is already an identity called ${name}.`;
  }
  const cast = (await db().execute({ sql: `SELECT id FROM cast_members WHERE LOWER(name) = LOWER(?) LIMIT 1`, args: [name] })).rows[0];
  if (cast) return `@${name} is already in the cast: pick another name, or remove them first.`;
  return null;
}

/* ── The takes are the record ─────────────────────────────────────────────────────────────────────────────── */

type Tag = { character: string; angle: CastAngleId; identityId?: string };
async function existing(characterId: string, angle: CastAngleId): Promise<string | null> {
  const row = (await db().execute({
    sql: `SELECT id FROM generations WHERE deleted=0 AND status IN ('queued','running','succeeded') AND json_extract(params,'$.cast.character')=? AND json_extract(params,'$.cast.angle')=? ORDER BY created_at DESC LIMIT 1`,
    args: [characterId, angle],
  })).rows[0];
  return row ? String(row.id) : null;
}
async function tag(genId: string, value: Tag): Promise<void> {
  await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.cast',json(?)) WHERE id=?", args: [JSON.stringify(value), genId] });
}
/** The identity this character's retry already made (kept on its front still's tag). */
async function identityOf(characterId: string): Promise<string | null> {
  const row = (await db().execute({
    sql: `SELECT json_extract(params,'$.cast.identityId') AS identity FROM generations WHERE deleted=0 AND json_extract(params,'$.cast.character')=? AND json_extract(params,'$.cast.angle')='front' AND json_extract(params,'$.cast.identityId') IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    args: [characterId],
  })).rows[0];
  return row && row.identity ? String(row.identity) : null;
}
async function statusOf(genId: string): Promise<string> {
  const row = (await db().execute({ sql: "SELECT status FROM generations WHERE id=?", args: [genId] })).rows[0];
  return row ? String(row.status) : "failed";
}
/** Waits, bounded, for takes to leave "queued" and "running". */
async function waitFor(genIds: string[], seams: CastSeams): Promise<void> {
  if (seams.wait) return seams.wait(genIds);
  const until = Date.now() + STILL_WAIT_MS;
  for (;;) {
    const states = await Promise.all(genIds.map(statusOf));
    if (states.every((s) => s !== "queued" && s !== "running") || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The front still, kept as the character's identity photo: bytes copied under this workspace's own prefix as an upload of the person making the character. Free. */
async function keepIdentity(frontTakeId: string, name: string, description: string, projectId: string | null, userId: string): Promise<{ identityId: string } | { error: string }> {
  const bytes = await readOriginalBytesLimited("image", frontTakeId, 25 * 1024 * 1024);
  if (!bytes) return { error: "The front still's file is not there, so the identity cannot be kept." };
  const meta = identifyImage(bytes);
  if (!meta || meta.kind !== "image" || !meta.width || !meta.height) return { error: "The front still is not an image the identity can keep." };
  const room = await checkQuota(bytes.length);
  if (!room.allow) return { error: room.error ?? "This workspace has no room left." };
  const uploadId = newId("upl");
  const stored = await storeUpload(uploadId, meta.ext, bytes, meta.mime);
  await db().execute({
    sql: `INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at,uploader_id) VALUES(?,?,?,?,?,?,?,?,?,'image',NULL,?,?)`,
    args: [uploadId, `${name}.${meta.ext}`, meta.mime, meta.ext, bytes.length, stored.sha256, meta.width, meta.height, stored.url, now(), userId],
  });
  try {
    const identity = await createIdentity({ name, description, photos: [uploadId], projectId, userId });
    return { identityId: identity.id };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The identity could not be kept." };
  }
}

/* ── The plan ──────────────────────────────────────────────────────────────────────────────────────────────── */

export async function admitCastCharacter(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution, seams: CastSeams = {}): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  if (!(await castCharacterOn())) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const body = structuredClone(input) as Record<string, unknown>;
  const quoteOnly = body.quoteOnly === true;
  /* A sheet is several jobs under one approval: it is quoted here and approved by a person, never held as one prepared job. */
  if (options.checkpoint) return admissionReply({ error: "A character sheet is several jobs under one approval: it is quoted here and approved by a person." }, { status: 400 });
  await ready();
  const viewer = await actingViewer();
  if (!viewer) return admissionReply({ error: NO_ACTING_PERSON }, { status: 403 });

  /* ── What was asked ── */
  const name = clean(body.name, 32);
  const problem = nameProblem(name);
  if (problem) return admissionReply({ error: problem }, { status: 400 });
  const description = clean(body.description, DESCRIPTION_MAX + 1);
  if (!description) return admissionReply({ error: "Say who they are: how they look, in a few words." }, { status: 400 });
  if (description.length > DESCRIPTION_MAX) return admissionReply({ error: `Keep the description to ${DESCRIPTION_MAX} characters.` }, { status: 400 });
  const look = clean(body.look, LOOK_MAX + 1);
  if (look.length > LOOK_MAX) return admissionReply({ error: `Keep the look to ${LOOK_MAX} characters.` }, { status: 400 });
  const engineAsked = body.engine ?? "auto";
  if (typeof engineAsked !== "string" || !CAST_ENGINES.includes(engineAsked as CastEngine)) return admissionReply({ error: "Pick auto, flux2 or nano-banana-pro." }, { status: 400 });
  if (body.model != null && !FLUX2_MODELS.includes(body.model as Flux2Model)) return admissionReply({ error: `Pick ${FLUX2_MODELS.join(", ")}.` }, { status: 400 });
  const model = ((body.model as Flux2Model | undefined) ?? BFL_RATES.defaultModel) as Flux2Model;
  const projectId = typeof body.projectId === "string" && ID.test(body.projectId) ? body.projectId : null;
  if (body.projectId != null && !projectId) return admissionReply({ error: "That production is not valid." }, { status: 400 });
  const draftId = typeof body.draftId === "string" && ID.test(body.draftId) ? body.draftId : null;
  if (body.draftId != null && !draftId) return admissionReply({ error: "That board is not valid." }, { status: 400 });
  if (projectId) {
    if (!(await db().execute({ sql: "SELECT id FROM projects WHERE id=?", args: [projectId] })).rows.length) return admissionReply({ error: "That production is not in this workspace." }, { status: 404 });
    if (!(await mayReachProject(viewer, projectId, "admit"))) return admissionReply({ error: "That production is not in this workspace." }, { status: 404 });
  }
  const characterId = typeof body.characterId === "string" ? body.characterId : null;
  if (characterId != null && !CHARACTER_ID.test(characterId)) return admissionReply({ error: "A character id is 6 to 64 letters, digits, dots, colons, dashes or underscores." }, { status: 400 });

  /* The engine: FLUX.2 where it and its identity tool are on, else Nano Banana Pro. Asked for by name, it is that or a plain refusal. */
  const flux = await fluxReady();
  const engineId: "flux2" | "nano-banana-pro" = engineAsked === "nano-banana-pro" ? "nano-banana-pro" : engineAsked === "flux2" ? "flux2" : flux ? "flux2" : "nano-banana-pro";
  if (engineId === "flux2" && !flux) return admissionReply({ error: "FLUX.2 identity is not on here." }, { status: 400 });

  const taken = await nameTaken(name, projectId, characterId);
  if (taken) return admissionReply({ error: taken }, { status: 409 });

  const sub: AdmissionExecution = { defer: options.defer, ...(options.run ? { run: options.run } : {}) };
  /* Jobs the engines defer (FLUX.2 runs in the request's continuation) are awaited here, so a view that needs the front finds it done. */
  const pending: Promise<unknown>[] = [];
  const driven: AdmissionExecution = { ...sub, defer: async (work) => { pending.push(Promise.resolve().then(work).catch(() => undefined)); } };
  const engine = engineId === "flux2" ? makeFlux2(got, driven, { model, projectId }, seams) : makeNano(got, driven, { projectId }, seams);
  const words = characterWords(name, description, look);
  const frontAngle = CAST_ANGLES[0];
  const frontPrompt = anglePrompt(words, frontAngle, false);

  /* ── The quote ── */
  const frontQuote = await engine.quoteFront(frontPrompt);
  if (!ok(frontQuote)) return admissionReply({ error: errorOf(frontQuote, "It can't be priced.") }, { status: frontQuote.status });
  const front: StepPrice = { credits: Number(frontQuote.body.estimatedCredits), price: Number(frontQuote.body.price) };
  const estimate = await engine.estimateView(anglePrompt(words, CAST_ANGLES[1], true));
  if (!estimate.ok) return admissionReply({ error: errorOf(estimate.reply, "It can't be priced.") }, { status: estimate.reply.status });
  const others = CAST_ANGLES.slice(1);
  const credits = front.credits + others.length * estimate.price.credits;
  const price = front.price + others.length * estimate.price.price;
  const unit = creditsApply(requireTenant()) ? "cr" : "usd";
  /* An agent's and Agent mode's reply: one all-in price, no engine, no step. `detail` is Director's: the engine and each still. */
  const summary: Record<string, unknown> = { name, stills: CAST_STILLS, upTo: true };
  if (body.detail === true) Object.assign(summary, { engine: engine.id, model: engine.model, steps: CAST_ANGLES.map((a, i) => ({ angle: a.id, credits: i === 0 ? front.credits : estimate.price.credits })) });
  if (quoteOnly) return admissionReply({ estimatedCredits: credits, price: unit === "cr" ? credits : Math.round(price * 1e6) / 1e6, unit, ...summary });

  /* ── The approval: one person, once, for the whole plan ── */
  if (!isPersonApprover(got.user.id) || isAgentId(got.user.id) || got.token != null || options.run?.auto === true) return admissionReply({ error: PEOPLE_ONLY }, { status: 403 });
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || credits > (body.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });
  if (characterId == null) return admissionReply({ error: "Name this character's sheet (characterId) so a retry finds what is already made." }, { status: 400 });
  const budget = { spent: 0, max: body.maxCredits as number };

  /* One step: quoted exactly by its own tool, held to the approved total, asked at that figure. A step that fails costs nothing and is not counted. */
  const step = async (label: string, quote: () => Promise<Reply>, go: (credits: number) => Promise<Reply>): Promise<Reply | { stop: string; status: number }> => {
    const q = await quote();
    if (!ok(q)) return { stop: `${label}: ${errorOf(q, "It can't be priced.")}`, status: q.status };
    const exact = Number(q.body.estimatedCredits);
    if (!Number.isInteger(exact) || exact < 0) return { stop: `${label}: it could not be priced.`, status: 503 };
    if (budget.spent + exact > budget.max) return { stop: `${label}: this is past the approved amount, so it asks again.`, status: 409 };
    budget.spent += exact;
    const r = await go(exact);
    if (!ok(r)) { budget.spent -= exact; return { stop: `${label}: ${errorOf(r, "It did not start.")}`, status: r.status }; }
    return r;
  };
  const results: { angle: CastAngleId; takeId: string | null; status?: string; stopped?: string }[] = [];

  /* 1. The front still. */
  let frontId = await existing(characterId, "front");
  if (!frontId) {
    const r = await step(`${frontAngle.label}`, () => engine.quoteFront(frontPrompt), (c) => engine.front(frontPrompt, c));
    if ("stop" in r) return admissionReply({ error: r.stop, characterId, spent: budget.spent }, { status: r.status });
    frontId = String(r.body.id);
    await Promise.all(pending.splice(0));
    await tag(frontId, { character: characterId, angle: "front" });
  }
  await waitFor([frontId], seams);
  const frontStatus = await statusOf(frontId);
  results.push({ angle: "front", takeId: frontId, status: frontStatus });
  if (frontStatus !== "succeeded") {
    return admissionReply({ error: frontStatus === "failed" ? "The front still did not come out. Nothing billed." : "The front still is still being made.", characterId, spent: budget.spent, stills: results, ...(frontStatus === "failed" ? {} : { retry: CAST_RETRY_NOTE }) }, { status: frontStatus === "failed" ? 502 : 202 });
  }

  /* 2. The identity: the front still, kept. Free, and once. */
  let identityId = await identityOf(characterId);
  if (!identityId) {
    const kept = await keepIdentity(frontId, name, description, projectId, got.user.id);
    if ("error" in kept) return admissionReply({ error: kept.error, characterId, spent: budget.spent, stills: results }, { status: 502 });
    identityId = kept.identityId;
    await tag(frontId, { character: characterId, angle: "front", identityId });
  }
  const from = { identityId, frontTakeId: frontId };

  /* 3. The seven other views, three at a time. */
  let next = 0;
  const workerLoop = async () => {
    for (;;) {
      const at = next++;
      if (at >= others.length) return;
      const angle = others[at];
      const prompt = anglePrompt(words, angle, true);
      const found = await existing(characterId, angle.id);
      if (found) { results.push({ angle: angle.id, takeId: found }); continue; }
      const r = await step(angle.label, () => engine.quoteView(prompt, from), (c) => engine.view(prompt, from, c));
      if ("stop" in r) { results.push({ angle: angle.id, takeId: null, stopped: r.stop }); continue; }
      const takeId = String(r.body.id);
      await tag(takeId, { character: characterId, angle: angle.id });
      results.push({ angle: angle.id, takeId });
    }
  };
  await Promise.all([workerLoop(), workerLoop(), workerLoop()]);
  await Promise.all(pending.splice(0));
  const made = results.filter((r) => r.takeId).map((r) => r.takeId!) ;
  await waitFor(made, seams);
  for (const r of results) if (r.takeId) r.status = await statusOf(r.takeId);
  const order = new Map<string, number>(CAST_ANGLES.map((a, i) => [a.id, i]));
  results.sort((a, b) => (order.get(a.angle) ?? 0) - (order.get(b.angle) ?? 0));
  const done = results.filter((r) => r.status === "succeeded");
  const stopped = CAST_STILLS - done.length;

  /* 4. The board's Cast. */
  const entry = castEntry(characterId, name, description, words, identityId, done.map((r) => r.takeId!));
  const placed = draftId ? await (seams.draft ?? writeCastToDraft)(viewer.id, draftId, entry) : null;
  return admissionReply({
    id: characterId, characterId, status: stopped ? "partial" : "done", estimatedCredits: credits, spent: budget.spent, identityId, name, stills: results.map(publicStill), made: done.length, stopped,
    ...(placed ? { board: placed } : {}), ...(stopped ? { retry: CAST_RETRY_NOTE } : {}),
  });
}

const publicStill = (r: { angle: CastAngleId; takeId: string | null; status?: string; stopped?: string }) => ({ angle: r.angle, takeId: r.takeId, ...(r.status ? { status: r.status } : {}), ...(r.stopped ? { stopped: r.stopped } : {}) });

/* ── The board ─────────────────────────────────────────────────────────────────────────────────────────────── */

/** The cast entry: the character, its identity, and its stills as takes (front first, the selected one). */
export function castEntry(characterId: string, name: string, description: string, prompt: string, identityId: string, takes: string[]): CastEntry {
  const at = new Date().toISOString();
  return { ...newEntry("character", name, description, prompt, { category: "character" }, stableId("cast", "character", characterId)), identityId, takes: takes.slice(0, 20).map((genId) => ({ genId, at })), ...(takes[0] ? { selected: takes[0] } : {}) };
}

/** The default writer: the person's own draft, the character set into its Cast by id, retried against a save that landed first. */
export async function writeCastToDraft(owner: string, draftId: string, entry: CastEntry): Promise<{ written: boolean; note?: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const draft = await readDraft(owner, draftId);
    if (!draft) return { written: false, note: "That board is not here." };
    const production = draft.project.production ?? {};
    const cast: Cast = production.cast ?? { entries: [] };
    const entries = [...cast.entries.filter((e) => e.id !== entry.id), entry];
    const project = { ...draft.project, production: { ...production, cast: { ...cast, entries } } };
    try { await saveDraft(owner, project as typeof draft.project, draft.revision); return { written: true }; }
    catch (error) { if (!(error instanceof DraftConflictError)) throw error; }
  }
  return { written: false, note: "The board changed while this was saved: run it again to place the character." };
}

/* ── What a sheet reads ────────────────────────────────────────────────────────────────────────────────────── */

/** Where a sheet stands, still by still, read from the takes it tagged. Reads only. */
export async function castCharacterStatus(characterId: string): Promise<{ characterId: string; identityId: string | null; stills: { angle: string; takeId: string; status: string }[]; done: boolean } | null> {
  if (!CHARACTER_ID.test(characterId)) return null;
  await ready();
  const rows = (await db().execute({
    sql: `SELECT id, status, json_extract(params,'$.cast.angle') AS angle, json_extract(params,'$.cast.identityId') AS identity FROM generations WHERE deleted=0 AND json_extract(params,'$.cast.character')=? ORDER BY created_at`,
    args: [characterId],
  })).rows;
  if (!rows.length) return null;
  const stills = rows.filter((r) => r.angle).map((r) => ({ angle: String(r.angle), takeId: String(r.id), status: String(r.status) }));
  const identityId = rows.map((r) => (r.identity ? String(r.identity) : null)).find(Boolean) ?? null;
  const order = new Map<string, number>(CAST_ANGLES.map((a, i) => [a.id, i]));
  stills.sort((a, b) => (order.get(a.angle) ?? 0) - (order.get(b.angle) ?? 0));
  return { characterId, identityId, stills, done: stills.length === CAST_STILLS && stills.every((s) => s.status === "succeeded") };
}

/**
 * `cast_character`, declared beside its handler. The button, Make, a board card, Atomik, a saved skill and an outside agent over MCP all reach the one route
 * (POST /api/cast-character), at the same price, through the same approval. Anyone may PREPARE it (a quote); a person approves the price (`maxCredits`).
 */
export const CAST_CHARACTER_TOOL = {
  id: "cast_character",
  kind: "engine" as const,
  provider: "bfl+gemini",
  needs: ["BFL_API_KEY", "BFL_ENABLED", "BFL_IDENTITY_ENABLED (FLUX.2 views; without it Nano Banana Pro makes them)"],
  route: "/api/cast-character",
  inputs: {
    name: "the character's name (letters, digits, underscores; what @Name cites)", description: `how they look, up to ${DESCRIPTION_MAX} characters`, look: `the film's look, up to ${LOOK_MAX} characters (optional)`,
    engine: "auto (default), flux2 or nano-banana-pro", draftId: "the board to put the character on (optional)", projectId: "the production (optional)",
    characterId: "names this sheet; a retry with it skips what is made", detail: "true: name the engine and each still's price (Director)", maxCredits: "the approved price, for the whole plan",
  },
  price: { quote: "POST /api/cast-character { quoteOnly: true }" },
  who: "prepare: anyone; approve: a person" as const,
};

/** The tools present for a workspace: none unless FLUX.2 is on for it. */
export async function castCharacterTools(): Promise<(typeof CAST_CHARACTER_TOOL)[]> {
  return (await castCharacterOn()) ? [CAST_CHARACTER_TOOL] : [];
}
