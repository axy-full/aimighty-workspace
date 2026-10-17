import { db, ready, now, id as newId } from "./db";
import { creditsApply, quotedCredits } from "./credits";
import { requireTenant } from "./tenant";
import { engineEnabled } from "./engineGate";
import { isPersonApprover } from "./workbench/plan-approval";
import { isAgentId } from "./security/people-only";
import { actingViewer, NO_ACTING_PERSON } from "./actingViewer";
import { mayReachProject } from "./draftProject";
import { castNameClash, nameProblem } from "./cast";
import { mediaMutation } from "./mediaMutation";
import { checkQuota } from "./limits";
import { identifyImage } from "./imagemeta";
import { readOriginalBytesLimited, storeUpload } from "./storage";
import { BFL_SWITCH, bflConfigured } from "./bfl";
import { bflEstimate, driveBfl, executeBflAdmission } from "./bflImage";
import { NANO_BANANA_PRO_ID } from "./models";
import { estimateImageCostUsd } from "./vendorPricing";
import { generationFingerprint, generationRequestsReady, withGenerationRequestData } from "./generationRequests";
import { platformDb, platformReady } from "./platform";
import type { AdmissionActor, AdmissionExecution, AdmissionReply, PrepareAdmissionResult, PreparedAdmission } from "./admissionTypes";
import { admissionReply, admissionResponse, assertAdmissionActor } from "./admissionSupport";

/**
 * `cast_character`: an AI-made character, in one go. Their portrait, their character sheet, their place in the cast (@Name, with the portrait as the still to hold onto)
 * and their identity (the portrait and the sheet as its photos), made on one engine and priced and approved once. Nobody's face or voice is involved (AI-made only), so there
 * is no consent record and none is read.
 *
 * It is a plan over the existing tools, like the Hindi version (lib/hindiVersion.ts): each still is the engine's own admission, so each keeps its own price path, gates, caps,
 * reservation and ledger line; this file adds no price, vendor call or reservation. Two engines: "flux2" (FLUX.2 direct, lib/bflImage.ts) and "nanobanana" (Nano Banana Pro
 * through the generation admission, as the Rig renders a still). `engine: "auto"` is FLUX.2 where it is on for the workspace, else Nano Banana. The price the person is told
 * is ONE figure for everything, "up to N cr": the portrait is quoted by its engine, and the sheet, whose reference does not exist yet, is estimated with the same arithmetic (the
 * portrait as its one reference); each is then quoted exactly just before it runs and asked at that figure, and a step that would pass the approved total is not run.
 *
 * The steps: portrait (a still from words) -> its upload in the Library (the person's own) -> sheet (an edit of the portrait: front, three-quarter, side and back) -> its upload ->
 * the cast member and the identity, written together in one transaction, so there is never one without the other. Nothing is stored beside the takes: each is tagged
 * `params.cast = { version, role }`, and a retry under the same `versionId` skips what is made, buys nothing twice, and finishes what is missing.
 */
export const CAST_ENGINES = ["auto", "flux2", "nanobanana"] as const;
export type CastEngine = (typeof CAST_ENGINES)[number];
type Engine = "flux2" | "nanobanana";
const FLUX2_MODEL = "flux-2-pro" as const;
/** Sizes in whole sixteens, each under one megapixel so each is priced at the first tier: a portrait (exactly 3:4, as Nano Banana is asked and a board draws a character) and a sheet (4:3). */
export const PORTRAIT_SIZE = { width: 768, height: 1024 } as const;
export const SHEET_SIZE = { width: 1152, height: 864 } as const;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const VERSION_ID = /^[A-Za-z0-9_.:-]{6,64}$/;
const PEOPLE_ONLY = "Only a person approves spending. Atomik, outside agents and tokens can prepare this, never approve it.";
const WAIT_MS = 180_000;
const chars = (text: string) => [...text].length;

export const portraitPrompt = (description: string) =>
  `A portrait of a character for a film: ${description.trim()}. Head and shoulders, neutral expression, plain light background, soft even light, sharp focus on the face.`;
export const sheetPrompt = (description: string) =>
  `A character reference sheet of this same character: ${description.trim()}. Four full-body views side by side on a plain light background: front, three-quarter, side and back. The same face, hair, build and clothes in every view, a neutral standing pose, evenly lit.`;

/** The seams a test may hand the steps. The public admission passes none. */
export type CastSeams = {
  /** Nano Banana's prepare and admit (the generation admission, as the Rig calls them). */
  nanobanana?: {
    prepare: (body: Record<string, unknown>, actor: AdmissionActor) => Promise<PrepareAdmissionResult>;
    admit: (prepared: PreparedAdmission, actor: AdmissionActor, options: { requestKey: string; defer: AdmissionExecution["defer"]; run?: AdmissionExecution["run"] }) => Promise<AdmissionReply>;
  };
  /** How long a still may take to arrive, in milliseconds. */
  waitMs?: number;
};

const ok = (r: AdmissionReply) => r.status === 200 || r.status === 202;
const errorOf = (r: AdmissionReply, fallback: string) => (typeof r.body.error === "string" && r.body.error ? r.body.error : fallback);

async function nanoBanana(seams: CastSeams) {
  if (seams.nanobanana) return seams.nanobanana;
  const g = await import("./generationAdmission");
  return { prepare: g.prepareGeneration, admit: g.admitGeneration };
}

/** Which engine this workspace makes the character on, or null when neither is available. */
export async function castEngineFor(want: CastEngine): Promise<Engine | null> {
  const flux = (await engineEnabled(BFL_SWITCH)) && bflConfigured();
  if (want === "flux2") return flux ? "flux2" : null;
  if (want === "nanobanana") return "nanobanana";
  return flux ? "flux2" : "nanobanana";
}

/** Is the tool here: FLUX.2 is on for this workspace (engine switch and list), set up. Nano Banana is the alternative engine inside it. */
export async function castCharacterOn(): Promise<boolean> { return (await engineEnabled(BFL_SWITCH)) && bflConfigured(); }

type StillStep = { role: "portrait" | "sheet"; prompt: string; width: number; height: number; reference?: string };
type Price = { credits: number; price: number };

/** The body Nano Banana is asked with: a still, a shape, and (for the sheet) the portrait as its one reference. */
const nanoBody = (s: StillStep, projectId: string | null, extra: Record<string, unknown> = {}) => ({
  prompt: s.prompt, model: NANO_BANANA_PRO_ID, projectId: projectId ?? "", shotId: "", ratio: s.role === "portrait" ? "3:4" : "4:3", resolution: "1K", duration: 5, refine: false,
  references: s.reference ? [{ uploadId: s.reference, role: "reference_image" }] : [], ...extra,
});

/** The take this person's version already made for a role (made or under way), if any. Another member's takes under the same versionId are never theirs. */
async function existing(versionId: string, role: string, owner: string, statuses: readonly string[] = ["queued", "running", "succeeded"]): Promise<{ id: string; status: string } | null> {
  const row = (await db().execute({
    sql: `SELECT id, status FROM generations WHERE deleted=0 AND created_by=? AND status IN (${statuses.map(() => "?").join(",")}) AND json_extract(params,'$.cast.version')=? AND json_extract(params,'$.cast.role')=? ORDER BY created_at DESC LIMIT 1`,
    args: [owner, ...statuses, versionId, role],
  })).rows[0];
  return row ? { id: String(row.id), status: String(row.status) } : null;
}
async function tag(genId: string, version: string, role: string) {
  await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.cast',json(?)) WHERE id=?", args: [JSON.stringify({ version, role }), genId] });
}
/** The file name the Library shows. A label only: nothing is ever found by it (anyone can upload a file of any name). */
const filenameFor = (versionId: string, role: string) => `cast-${versionId}-${role}.png`;
/** The Library copy of a take is derived from the take, never chosen by a client: its id is the take's own, so no upload of a person's can stand in for it. */
const uploadIdFor = (genId: string) => `up_cast_${genId}`;
async function uploadOfTake(genId: string, owner: string): Promise<string | null> {
  const row = (await db().execute({ sql: "SELECT id FROM uploads WHERE id=? AND uploader_id=? LIMIT 1", args: [uploadIdFor(genId), owner] })).rows[0];
  return row ? String(row.id) : null;
}
/** The Library copy of this person's finished take for a role, if both exist. */
async function keptOf(versionId: string, role: string, owner: string): Promise<{ take: string; upload: string } | null> {
  const take = await existing(versionId, role, owner, ["succeeded"]);
  const upload = take ? await uploadOfTake(take.id, owner) : null;
  return take && upload ? { take: take.id, upload } : null;
}

/** A finished still, kept in the Library as the person's own upload (so the cast and the identity can hold it). Idempotent by the take: one upload per take. */
async function keepStill(versionId: string, role: string, genId: string, owner: string): Promise<{ id: string } | { error: string; status: number }> {
  const had = await uploadOfTake(genId, owner);
  if (had) return { id: had };
  const bytes = await readOriginalBytesLimited("image", genId, 64 * 1024 * 1024);
  if (!bytes?.length) return { error: "The still was made but could not be read back. Nothing more was billed.", status: 502 };
  const meta = identifyImage(bytes);
  if (!meta || meta.kind !== "image" || !meta.width || !meta.height) return { error: "The still was made but is not an image Particl can keep.", status: 502 };
  const quota = await checkQuota(bytes.length);
  if (!quota.allow) return { error: quota.error ?? "There is no room left in this workspace's storage.", status: 507 };
  const upId = uploadIdFor(genId);
  const stored = await storeUpload(upId, meta.ext, bytes, meta.mime);
  await db().execute({
    sql: "INSERT OR IGNORE INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at,uploader_id) VALUES(?,?,?,?,?,?,?,?,?,'image',NULL,?,?)",
    args: [upId, filenameFor(versionId, role), meta.mime, meta.ext, bytes.length, stored.sha256, meta.width, meta.height, stored.url, now(), owner],
  });
  return (await uploadOfTake(genId, owner)) ? { id: upId } : { error: "The still was made but could not be kept. Nothing more was billed.", status: 409 };
}

/** Our own words for a step's refusal: an engine's or a vendor's name never reaches a customer (Agent mode names no engine). */
const ENGINE_WORDS = /\b(flux|bfl|black forest|nano ?banana|gemini|google|fal|klein)\b/i;
function ours(text: string, status: number): string {
  if (!ENGINE_WORDS.test(text)) return text;
  if (status === 402) return "There are not enough credits for this. Nothing was billed.";
  if (status === 429) return "This workspace has reached its spending limit for now. Nothing was billed.";
  if (status === 422 || status === 400) return "The picture was refused. Nothing was billed.";
  return "The picture could not be made. Nothing was billed.";
}

/** What a take was billed, from the meter, once it has settled: null while it is still running or has no meter row. */
async function settledCredits(genId: string): Promise<number | null> {
  await platformReady();
  const row = (await platformDb().execute({ sql: "SELECT status, paid_by_platform, billed_credits FROM meter_events WHERE id=? AND workspace_id=?", args: [genId, requireTenant().id] })).rows[0];
  if (!row || String(row.status) === "running") return null;
  return Number(row.paid_by_platform) === 1 ? Number(row.billed_credits ?? 0) : 0;
}

/**
 * The attempt a step is asked under (its claim key `cast:<version>:<role>:<attempt>`). The same attempt while its claim is in flight or made a live take, so a
 * double press or a retry is answered by that claim and buys nothing twice; the next attempt once the last one was refused or its take failed, so a refusal
 * (no credits, the cap) is never replayed for ever.
 */
async function attemptFor(userId: string, versionId: string, role: string): Promise<number> {
  await generationRequestsReady();
  const prefix = `cast:${versionId}:${role}:`;
  const rows = (await db().execute({
    sql: "SELECT request_key, response_status, generation_id FROM generation_requests WHERE user_id=? AND substr(request_key,1,?)=?",
    args: [userId, prefix.length, prefix],
  })).rows;
  let last: { n: number; status: number | null; gen: string | null } | null = null;
  for (const r of rows) {
    const n = Number(String(r.request_key).slice(prefix.length));
    if (Number.isInteger(n) && n > 0 && (!last || n > last.n)) last = { n, status: r.response_status == null ? null : Number(r.response_status), gen: r.generation_id == null ? null : String(r.generation_id) };
  }
  if (!last) return 1;
  if (last.gen) {
    const gen = (await db().execute({ sql: "SELECT status FROM generations WHERE id=?", args: [last.gen] })).rows[0];
    return !gen || ["failed", "cancelled"].includes(String(gen.status)) ? last.n + 1 : last.n;
  }
  /* No take: in flight (no reply yet) is the same attempt; a refusal is done with. */
  return last.status == null || (last.status >= 200 && last.status < 300) ? last.n : last.n + 1;
}

/** Waits for a take to arrive: BFL's own driver for a FLUX.2 take, then the row, until it ends or the time is up. */
async function arrived(genId: string, engine: Engine, ms: number): Promise<{ ok: true } | { ok: false; reason: string; failed: boolean }> {
  const until = Date.now() + ms;
  if (engine === "flux2") await driveBfl(genId, { budgetMs: ms, pauseMs: 250 }).catch(() => undefined);
  for (;;) {
    const row = (await db().execute({ sql: "SELECT status, stored_url, error FROM generations WHERE id=?", args: [genId] })).rows[0];
    if (!row) return { ok: false, reason: "The still is gone.", failed: true };
    if (String(row.status) === "succeeded" && row.stored_url) return { ok: true };
    if (String(row.status) === "failed" || String(row.status) === "cancelled") return { ok: false, reason: String(row.error ?? "The still could not be made. Nothing was billed.").slice(0, 300), failed: true };
    if (Date.now() >= until) return { ok: false, reason: "The still is taking longer than expected. Ask again with the same versionId to pick it up, or follow it with GET /api/cast-character?versionId=; nothing is bought twice.", failed: false };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function admitCastCharacter(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution, seams: CastSeams = {}): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  const body = structuredClone(input) as Record<string, unknown>;
  const quoteOnly = body.quoteOnly === true;
  if (options.checkpoint) return admissionReply({ error: "A character is several jobs under one approval: it is quoted here and approved by a person." }, { status: 400 });
  await ready();
  const viewer = await actingViewer();
  if (!viewer) return admissionReply({ error: NO_ACTING_PERSON }, { status: 403 });

  /* ── What was asked ── */
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const problem = nameProblem(name);
  if (problem) return admissionReply({ error: problem }, { status: 400 });
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (chars(description) < 3 || chars(description) > 600) return admissionReply({ error: "Describe them in a few words, up to 600 characters." }, { status: 400 });
  if (body.engine != null && !CAST_ENGINES.includes(body.engine as CastEngine)) return admissionReply({ error: "That engine is not one this tool offers." }, { status: 400 });
  /* The tool is here only where FLUX.2 is on for the workspace (the engine gate, lib/engineGate.ts); Nano Banana is its alternative, not a door of its own. */
  if (!(await castCharacterOn())) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const engine = await castEngineFor((body.engine as CastEngine | undefined) ?? "auto");
  if (!engine) return admissionReply({ error: "That engine is not on here." }, { status: 404 });
  if (body.sheet != null && typeof body.sheet !== "boolean") return admissionReply({ error: "Sheet is true or false." }, { status: 400 });
  const withSheet = body.sheet !== false;
  const projectId = body.projectId == null ? null : typeof body.projectId === "string" && ID.test(body.projectId) ? body.projectId : undefined;
  if (projectId === undefined) return admissionReply({ error: "That production is not valid." }, { status: 400 });
  if (projectId && (!(await db().execute({ sql: "SELECT 1 FROM projects WHERE id=?", args: [projectId] })).rows.length || !(await mayReachProject(viewer, projectId, "admit"))))
    return admissionReply({ error: "That production is not in this workspace." }, { status: 404 });
  /* A character this version already finished is answered as it was: nothing is asked, bought or written again. */
  if (!quoteOnly && typeof body.versionId === "string" && VERSION_ID.test(body.versionId)) {
    const portraitKept = await keptOf(body.versionId, "portrait", viewer.id);
    const done = portraitKept ? (await db().execute({ sql: "SELECT id, cast_id, photos FROM identities WHERE cover_upload_id=? AND created_by=? LIMIT 1", args: [portraitKept.upload, viewer.id] })).rows[0] : undefined;
    if (portraitKept && done) {
      const sheetKept = await keptOf(body.versionId, "sheet", viewer.id);
      return admissionReply({
        id: body.versionId, versionId: body.versionId, status: "done", spent: 0, castId: done.cast_id == null ? null : String(done.cast_id), identityId: String(done.id), name,
        portraitUploadId: portraitKept.upload, portraitTakeId: portraitKept.take, ...(sheetKept ? { sheetUploadId: sheetKept.upload, sheetTakeId: sheetKept.take } : {}),
      });
    }
  }
  /* Asked now, so a name taken is said before anything is bought. */
  if (await castNameClash(db(), name, projectId)) return admissionReply({ error: `@${name} is already cast here.` }, { status: 409 });
  /* An identity's name is one per workspace; whose it is is not said (another member's may be private). */
  if ((await db().execute({ sql: "SELECT 1 FROM identities WHERE LOWER(name)=LOWER(?) LIMIT 1", args: [name] })).rows.length) return admissionReply({ error: `The name ${name} is taken in this workspace. Pick another.` }, { status: 409 });

  /* ── The quote: one price, the two stills added ── */
  const steps: StillStep[] = [{ role: "portrait", prompt: portraitPrompt(description), ...PORTRAIT_SIZE }];
  if (withSheet) steps.push({ role: "sheet", prompt: sheetPrompt(description), ...SHEET_SIZE, reference: "(the portrait)" });
  const prices: Price[] = [];
  const unit = creditsApply(requireTenant()) ? "cr" : "usd";
  for (const s of steps) {
    if (engine === "flux2") {
      if (s.role === "portrait") {
        const q = await executeBflAdmission({ tool: "image", model: FLUX2_MODEL, prompt: s.prompt, width: s.width, height: s.height, projectId, quoteOnly: true }, got, options);
        if (!ok(q)) return admissionReply({ error: `The portrait: ${ours(errorOf(q, "It can't be priced."), q.status)}` }, { status: q.status });
        prices.push({ credits: Number(q.body.estimatedCredits), price: Number(q.body.price) });
      } else {
        const e = bflEstimate(FLUX2_MODEL, s.width, s.height, [Math.max(1, Math.ceil((PORTRAIT_SIZE.width * PORTRAIT_SIZE.height) / 1_000_000))]);
        if ("error" in e) return admissionReply({ error: `The sheet: ${ours(e.error, 400)}` }, { status: 400 });
        prices.push({ credits: e.estimatedCredits, price: unit === "cr" ? e.estimatedCredits : e.usd });
      }
    } else {
      /* The sheet's reference (the portrait) does not exist yet, so it is asked without one and its one reference is added with the generation admission's own
         arithmetic (estimateImageCostUsd with one reference, then the margin table): the difference one reference makes. The exact quote is asked again before it runs. */
      const nb = await nanoBanana(seams);
      const prepared = await nb.prepare(nanoBody({ ...s, reference: undefined }, projectId), got);
      if (!prepared.ok) return admissionReply({ error: `The ${s.role}: ${ours(typeof prepared.body.error === "string" ? prepared.body.error : "It can't be priced.", prepared.status)}` }, { status: prepared.status });
      let refCredits = 0, refUsd = 0;
      if (s.reference) {
        const none = estimateImageCostUsd(NANO_BANANA_PRO_ID, "1K", 0), one = estimateImageCostUsd(NANO_BANANA_PRO_ID, "1K", 1);
        if (none && one) { refUsd = one.net - none.net; refCredits = quotedCredits(one.net, NANO_BANANA_PRO_ID) - quotedCredits(none.net, NANO_BANANA_PRO_ID); }
      }
      prices.push({ credits: prepared.value.quote.estimatedCredits + refCredits, price: prepared.value.quote.price + (unit === "cr" ? refCredits : refUsd) });
    }
  }
  const credits = prices.reduce((n, p) => n + p.credits, 0);
  const price = prices.reduce((n, p) => n + p.price, 0);
  /* One price, all in: no per-step figure, no engine's name. */
  const summary = { upTo: true as const, stills: steps.length, sheet: withSheet };
  if (quoteOnly) return admissionReply({ estimatedCredits: credits, price: unit === "cr" ? credits : Math.round(price * 1e6) / 1e6, unit, ...summary });

  /* ── The approval: one person, once, for the whole character ── */
  if (!isPersonApprover(got.user.id) || isAgentId(got.user.id) || got.token != null || options.run?.auto === true) return admissionReply({ error: PEOPLE_ONLY }, { status: 403 });
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || credits > (body.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });
  if (typeof body.versionId !== "string" || !VERSION_ID.test(body.versionId)) return admissionReply({ error: "Name this character's version (versionId, 6 to 64 letters, digits, dots, colons, dashes or underscores) so a retry finds what is already made." }, { status: 400 });
  const versionId = body.versionId;
  const budget = { spent: 0, max: body.maxCredits as number };
  const waitMs = seams.waitMs ?? WAIT_MS;
  const sub: AdmissionExecution = { defer: async () => {}, ...(options.run ? { run: options.run } : {}) };
  /* `spent` is what was billed: a step that failed or was refused takes its figure back, and a step that settled counts what the meter settled. */
  const stopped = (reason: string, status = 502, extra: Record<string, unknown> = {}) =>
    admissionReply({ error: budget.spent === 0 && !/nothing (was |more was )?billed/i.test(reason) ? `${reason} Nothing was billed.` : reason, versionId, spent: budget.spent, retry: RETRY_NOTE, ...extra }, { status });

  /* One still: made on the engine at its exact quote, held to the approved total, awaited, kept as an upload. Each is asked under its own claim
     (`cast:<version>:<role>:<attempt>`, the person's own), so two presses, or a retry while one is still going, are answered by the one claim and buy it once. */
  const still = async (s: StillStep, reference: string | null): Promise<{ upload: string; take: string } | { stop: string; status: number }> => {
    const have = await existing(versionId, s.role, viewer.id);
    let genId = have?.id ?? null;
    /* What this request holds for the step against the approved total: its quote while it runs, what was billed once it settles, nothing for a replay. */
    let held = 0;
    if (!genId) {
      const real = { ...s, reference: reference ?? undefined };
      const key = `cast:${versionId}:${s.role}:${await attemptFor(got.user.id, versionId, s.role)}`;
      let credits: number;
      let run: (maxCredits: number) => Promise<AdmissionReply>;
      const defers: (() => Promise<unknown>)[] = [];
      const collect: AdmissionExecution = { ...sub, defer: async (work) => { defers.push(work); } };
      if (engine === "flux2") {
        const tool = reference ? "edit" : "image";
        const args = { tool, model: FLUX2_MODEL, prompt: s.prompt, width: s.width, height: s.height, projectId, ...(reference ? { references: [{ uploadId: reference }] } : {}) };
        const q = await executeBflAdmission({ ...args, quoteOnly: true }, got, collect);
        if (!ok(q)) return { stop: `The ${s.role}: ${ours(errorOf(q, "It can't be priced."), q.status)}`, status: q.status };
        credits = Number(q.body.estimatedCredits);
        run = async (max) => {
          /* The claim binds in the same write as the take (lib/bflImage.ts claimBinding), as the generation admission's does. */
          const response = await withGenerationRequestData(
            { userId: got.user.id, key, fingerprint: generationFingerprint({ namespace: "cast-flux2-v1", args }) },
            async (requestClaim) => admissionResponse(await executeBflAdmission({ ...args, maxCredits: max }, got, { ...collect, requestClaim })),
            { atomicBinding: true },
          );
          return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
        };
      } else {
        const nb = await nanoBanana(seams);
        const prepared = await nb.prepare(nanoBody(real, projectId), got);
        if (!prepared.ok) return { stop: `The ${s.role}: ${ours(typeof prepared.body.error === "string" ? prepared.body.error : "It can't be priced.", prepared.status)}`, status: prepared.status };
        credits = prepared.value.quote.estimatedCredits;
        run = () => nb.admit(prepared.value, got, { requestKey: key, defer: collect.defer, ...(options.run ? { run: options.run } : {}) });
      }
      if (!Number.isInteger(credits) || credits < 0) return { stop: `The ${s.role}: it could not be priced.`, status: 503 };
      if (budget.spent + credits > budget.max) return { stop: `The ${s.role}: this is past the approved amount, so it asks again.`, status: 409 };
      budget.spent += credits;
      const r = await run(credits);
      const replayed = String(r.headers?.["idempotency-replayed"] ?? r.headers?.["Idempotency-Replayed"] ?? "") === "true";
      /* A replay was bought (or refused) by the request that made its claim: this one holds nothing for it. */
      if (replayed) budget.spent -= credits; else held = credits;
      if (r.body?.pending === true) return { stop: `The ${s.role} is still being started by another press. Ask again with the same versionId; nothing is bought twice.`, status: 409 };
      if (!ok(r) || typeof r.body?.id !== "string") {
        budget.spent -= held;
        return { stop: `The ${s.role}: ${ours(errorOf(r, "It did not start."), r.status)}`, status: r.status === 200 || r.status === 202 ? 502 : r.status };
      }
      genId = String(r.body.id);
      await tag(genId, versionId, s.role);
      /* Nano Banana's still is made by the work its admission hands back: run here, inside this request. FLUX.2's is driven by `arrived`. */
      if (engine === "nanobanana") await Promise.all(defers.map((work) => work().catch(() => undefined)));
    }
    const here = await arrived(genId, engine, waitMs);
    /* Settled: what the meter billed replaces the quote this request held (a failed take is billed nothing unless the vendor billed it). */
    if (held) {
      const settled = await settledCredits(genId);
      if (settled != null) { budget.spent += settled - held; held = settled; }
      else if (!here.ok && here.failed) { budget.spent -= held; held = 0; }
    }
    if (!here.ok) return { stop: `The ${s.role}: ${ours(here.reason, 502)}`, status: 502 };
    const kept = await keepStill(versionId, s.role, genId, viewer.id);
    if ("error" in kept) return { stop: kept.error, status: kept.status };
    return { upload: kept.id, take: genId };
  };

  const portrait = await still(steps[0], null);
  if ("stop" in portrait) return stopped(portrait.stop, portrait.status);
  let sheetUpload: string | null = null, sheetTake: string | null = null;
  if (withSheet) {
    const sheet = await still(steps[1], portrait.upload);
    if ("stop" in sheet) return stopped(sheet.stop, sheet.status, { portraitUploadId: portrait.upload, portraitTakeId: portrait.take });
    sheetUpload = sheet.upload;
    sheetTake = sheet.take;
  }

  /* The cast member and the identity together, or neither. Retried under the same version, the one already made is returned. */
  const made = await mediaMutation(async (tx) => {
    const had = (await tx.execute({ sql: "SELECT id, cast_id FROM identities WHERE cover_upload_id=? AND created_by=? LIMIT 1", args: [portrait.upload, viewer.id] })).rows[0];
    if (had) return { identityId: String(had.id), castId: had.cast_id == null ? null : String(had.cast_id) };
    if (await castNameClash(tx, name, projectId)) return { error: `@${name} is already cast here.` };
    const ts = now();
    const castId = newId("cast"), identityId = newId("idn");
    await tx.execute({
      sql: "INSERT INTO cast_members (id, project_id, name, kind, description, upload_id, created_by, created_at) VALUES (?,?,?,'character',?,?,?,?)",
      args: [castId, projectId, name, description.slice(0, 600), portrait.upload, viewer.id, ts],
    });
    await tx.execute({
      sql: `INSERT INTO identities (id, project_id, name, description, photos, status, provider, cover_upload_id, cast_id, created_by, created_at, updated_at)
            VALUES (?,?,?,?,?,'draft','fal',?,?,?,?,?)`,
      args: [identityId, projectId, name, description.slice(0, 400), JSON.stringify([portrait.upload, ...(sheetUpload ? [sheetUpload] : [])]), portrait.upload, castId, viewer.id, ts, ts],
    });
    return { identityId, castId };
  });
  if ("error" in made) return stopped(String(made.error), 409, { portraitUploadId: portrait.upload, portraitTakeId: portrait.take, ...(sheetUpload ? { sheetUploadId: sheetUpload, sheetTakeId: sheetTake } : {}) });
  /* The takes (generation ids, `/api/media/<id>`) are what a board's Cast entry holds; the uploads are the Library's copies the cast member and the identity hold. */
  return admissionReply({
    id: versionId, versionId, status: "done", estimatedCredits: credits, spent: budget.spent,
    castId: made.castId, identityId: made.identityId, name, portraitUploadId: portrait.upload, portraitTakeId: portrait.take,
    ...(sheetUpload ? { sheetUploadId: sheetUpload, sheetTakeId: sheetTake } : {}),
  });
}

/** What a stopped character tells the person: a retry is one more approval, for the rest. */
export const RETRY_NOTE = "To go on, ask again with the same versionId. What is already made is not bought again; your approval covers the rest, up to the amount you approve this time.";

/**
 * `cast_character`, declared beside its handler. The button, a board card, Atomik, a saved skill and an outside agent over MCP all reach the one route (POST
 * /api/cast-character), at the same price, through the same approval. Anyone may PREPARE it (a quote); a person approves the price (`maxCredits`).
 */
export const CAST_CHARACTER_TOOL = {
  id: "cast_character",
  kind: "engine" as const,
  provider: "bfl|google",
  needs: ["BFL_API_KEY and BFL_ENABLED (FLUX.2), or Nano Banana's own key"],
  route: "/api/cast-character",
  inputs: {
    name: "the @name they are cited by (letters, digits, underscores)", description: "who they are, in a few words", engine: "auto (default), flux2 or nanobanana",
    sheet: "true (default): also make their character sheet", projectId: "the production (optional)", versionId: "names this character; a retry with it skips what is made",
    maxCredits: "the approved price",
  },
  price: { quote: "POST /api/cast-character { quoteOnly: true }: one price for the whole character" },
  who: "prepare: anyone; approve: a person" as const,
};

/** Where this person's character stands, from the takes it tagged (theirs only): the screen reads it while the stills are made, and after a reply that said "still being accepted". */
export async function castCharacterStatus(versionId: string, owner: string): Promise<{ versionId: string; portrait: string | null; sheet: string | null; done: boolean; castId: string | null; identityId: string | null } | null> {
  if (!VERSION_ID.test(versionId)) return null;
  await ready();
  const rows = (await db().execute({ sql: "SELECT status, json_extract(params,'$.cast.role') AS role FROM generations WHERE deleted=0 AND created_by=? AND json_extract(params,'$.cast.version')=? ORDER BY created_at", args: [owner, versionId] })).rows;
  if (!rows.length) return null;
  const of = (role: string) => { const mine = rows.filter((r) => r.role === role); return mine.length ? String(mine[mine.length - 1].status) : null; };
  const portrait = await keptOf(versionId, "portrait", owner);
  const made = portrait ? (await db().execute({ sql: "SELECT id, cast_id FROM identities WHERE cover_upload_id=? AND created_by=? LIMIT 1", args: [portrait.upload, owner] })).rows[0] : undefined;
  return { versionId, portrait: of("portrait"), sheet: of("sheet"), done: !!made, castId: made?.cast_id == null ? null : String(made.cast_id), identityId: made ? String(made.id) : null };
}
