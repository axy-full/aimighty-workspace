import { db, ready } from "./db";
import { creditsApply } from "./credits";
import { requireTenant } from "./tenant";
import { engineEnabled } from "./engineGate";
import { isPersonApprover } from "./workbench/plan-approval";
import { isAgentId } from "./security/people-only";
import { actingViewer, NO_ACTING_PERSON } from "./actingViewer";
import { executeSarvamAdmission, sarvamTools, usdPerInr } from "./sarvamTools";
import { SARVAM_SWITCH } from "./sarvam";
import { executeLipSyncAdmission, lipSyncEstimate, lipSyncOnHere } from "./lipSync";
import { syncConfigured } from "./syncso";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, assertAdmissionActor } from "./admissionSupport";
import { findStoredSource, resolveStoredDuration } from "./mediaSource.server";
import { DraftConflictError, readDraft, saveDraft } from "./workbench/records";
import { CUT_DATA_LIMITS, withLanguageVoice, type LanguageVoice, type VoiceLine } from "./v12/board/cut-data";

/**
 * The Hindi version: ONE tool that turns an English cut into a Hindi one. Per line of the script it translates (Sarvam), speaks the Hindi (Sarvam Bulbul, a stock
 * voice), and lip-syncs the shot (sync.so) when the shot is to be synced; the shots that are not carry the Hindi voice-over alone. One price, one approval.
 *
 * It is a plan, not an engine: every step is the existing tool, called through its own public admission (`executeSarvamAdmission`, `executeLipSyncAdmission`; no adapter is injected here), so each keeps its own price path,
 * gates, caps, reservation and ledger line. This file adds no price, no vendor call and no reservation of its own; it quotes by asking the steps to quote.
 *
 * WHICH SHOTS ARE SYNCED. `lipSync`: "hero" (the default: the lines marked `hero`), "all", or "none" (a Hindi voice-over on every shot). The owner's call, 16 Oct
 * 2026: hero shots only, to be confirmed after the first Hindi test clip. Lip-sync is house-only (lib/lipSync.ts); a plan with no synced shot needs only Sarvam.
 *
 * RETRY. A version that stops (a step past the approved total, a failure, a cap) is finished by asking again with the same `versionId`: that is one more approval, for
 * the REST of the plan, up to the `maxCredits` the person gives that time. What is made is skipped. A translation is paid before it is spoken and is kept nowhere, so a stopped
 * line's reply carries its Hindi (`hindi`): the retry passes it back as the line's `hindi`, and it is never translated, or paid for, twice.
 *
 * MONEY (CLAUDE.md rule 14). A quote is "up to N cr": a line whose Hindi is not written yet is priced at HINDI_EXPANSION times its English, and a voice's length is not
 * known until it is spoken, so a lip-sync is priced at the longer of the clip and the voice's estimated length. A person approves that total (`maxCredits`). Each step is
 * then quoted exactly by its own tool just before it runs and asked at that figure; a step that would take the plan past the approved total is not run ("asks again"),
 * and a step that fails costs nothing ("Nothing billed" from its own tool). Only a person approves: an agent's, an MCP caller's or Auto's approval is refused.
 *
 * NOTHING NEW IS STORED. The takes are the record. Each take the plan makes is tagged `params.hindi = { version, order, role, shotId }` (role "voice" or "synced"),
 * which is what a retry under the same `versionId` reads to skip what is already made or under way (a retry never buys a line twice), and what the Hindi cut reads
 * (`hindiVersionStatus`). The Hindi text of a line is the voice take's own prompt, in this workspace's database like any take's; the idempotency claim does not keep it.
 */
export const HINDI_MAX_LINES = 24;
/** A line's Hindi, when it is not written, is priced as at most this many times its English characters (Devanagari runs longer). A price estimate only. */
export const HINDI_EXPANSION = 1.5;
/** A Hindi voice speaks about this many characters a second; the lip-sync of a line not yet spoken is priced at the voice's estimated length. An estimate only. */
export const HINDI_CHARS_PER_SECOND = 10;
export const HINDI_LANGUAGE = "hi-IN";
/** The Deliver stage's code for Hindi (boardLanguages; `en` is the film as made). */
export const HINDI_BOARD_LANGUAGE = "hi";
const SOURCE_LANGUAGE = "en-IN";
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const VERSION_ID = /^[A-Za-z0-9_.:-]{6,64}$/;
/** What a stopped version tells the person: a retry is one more approval, for the rest of the plan. */
export const RETRY_NOTE = "To go on, ask again with the same versionId and the Hindi of any stopped line that was translated (it is in its line). What is already made is not bought again; your approval covers the rest of the plan, up to the amount you approve this time.";
const PEOPLE_ONLY = "Only a person approves spending. Atomik, outside agents and tokens can prepare this, never approve it.";
const MODES = ["hero", "all", "none"] as const;
export type HindiLipSyncMode = (typeof MODES)[number];
const chars = (text: string) => [...text].length;

/** Where the finished lines are placed: the board's draft (`boardVoice.hi`, lib/v12/board/cut-data.ts). A test hands its own. */
export type DraftWriter = (owner: string, draftId: string, voice: LanguageVoice) => Promise<{ written: number; note?: string }>;
export type HindiSeams = { draft?: DraftWriter };

type Line = { shotId: string | null; text: string; hindi: string | null; clipGenId: string | null; clipUploadId: string | null; hero: boolean; startSeconds: number | null };

function parseLines(raw: unknown): Line[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: "Add the lines to put into Hindi." };
  if (raw.length > HINDI_MAX_LINES) return { error: `A Hindi version takes up to ${HINDI_MAX_LINES} lines at a time.` };
  const out: Line[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `Line ${i + 1} is not valid.` };
    const l = item as Record<string, unknown>;
    const text = typeof l.text === "string" ? l.text.trim() : "";
    const hindi = typeof l.hindi === "string" && l.hindi.trim() ? l.hindi.trim() : null;
    if (!text && !hindi) return { error: `Line ${i + 1} needs its words.` };
    if (!hindi && chars(text) > 1000) return { error: `Line ${i + 1} is too long to translate: up to 1,000 characters.` };
    for (const key of ["shotId", "clipTakeId", "clipUploadId"] as const) if (l[key] != null && (typeof l[key] !== "string" || !ID.test(l[key] as string))) return { error: `Line ${i + 1}: ${key} is not valid.` };
    if (l.clipTakeId != null && l.clipUploadId != null) return { error: `Line ${i + 1}: pick one video, a take or an upload.` };
    if (l.hero != null && typeof l.hero !== "boolean") return { error: `Line ${i + 1}: hero is true or false.` };
    if (l.startSeconds != null && !(typeof l.startSeconds === "number" && Number.isFinite(l.startSeconds) && l.startSeconds >= 0 && l.startSeconds <= CUT_DATA_LIMITS.seconds)) return { error: `Line ${i + 1}: startSeconds is a number of seconds from the start of the film.` };
    out.push({ shotId: (l.shotId as string) ?? null, text, hindi, clipGenId: (l.clipTakeId as string) ?? null, clipUploadId: (l.clipUploadId as string) ?? null, hero: l.hero === true, startSeconds: (l.startSeconds as number | undefined) ?? null });
  }
  return out;
}

/** Is a Hindi version available here: Sarvam is on, set up and priced for this workspace. (Lip-sync is checked only if a line is to be synced.) */
export async function hindiVersionOn(): Promise<boolean> {
  if (!(await engineEnabled(SARVAM_SWITCH))) return false;
  return (await sarvamTools()).some((t) => t.id === "sarvam_speech" && !("unavailable" in t && t.unavailable));
}

type Reply = AdmissionReply;
const ok = (r: Reply) => r.status === 200;
const errorOf = (r: Reply, fallback: string) => (typeof r.body.error === "string" && r.body.error ? r.body.error : fallback);
/** A placeholder as long as a Hindi line is expected to be, for a price only: never sent anywhere. */
const placeholder = (n: number) => "क".repeat(Math.max(1, n));

type StepPrice = { credits: number; price: number };
type LinePlan = { order: number; line: Line; synced: boolean; translate?: StepPrice; voice: StepPrice; lipsync?: StepPrice };


export async function admitHindiVersion(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution, seams: HindiSeams = {}): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  if (!(await hindiVersionOn())) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const body = structuredClone(input) as Record<string, unknown>;
  const quoteOnly = body.quoteOnly === true;
  /* A single job is what a prepared admission holds; this is several. A person asks for it here, or a person approves it in the Hindi version's own screen. */
  if (options.checkpoint) return admissionReply({ error: "A Hindi version is several jobs under one approval: it is quoted here and approved by a person." }, { status: 400 });
  await ready();
  if (usdPerInr() == null) return admissionReply({ error: "Sarvam can't be priced here: SARVAM_USD_PER_INR is not set." }, { status: 503 });
  const viewer = await actingViewer();
  if (!viewer) return admissionReply({ error: NO_ACTING_PERSON }, { status: 403 });

  /* ── What was asked ── */
  const lines = parseLines(body.lines);
  if (!Array.isArray(lines)) return admissionReply({ error: lines.error }, { status: 400 });
  if (body.lipSync != null && !MODES.includes(body.lipSync as HindiLipSyncMode)) return admissionReply({ error: "Pick hero, all or none for which shots are lip-synced." }, { status: 400 });
  const mode: HindiLipSyncMode = (body.lipSync as HindiLipSyncMode | undefined) ?? "hero";
  const projectId = typeof body.projectId === "string" && ID.test(body.projectId) ? body.projectId : null;
  if (body.projectId != null && !projectId) return admissionReply({ error: "That production is not valid." }, { status: 400 });
  const draftId = typeof body.draftId === "string" && ID.test(body.draftId) ? body.draftId : null;
  if (body.draftId != null && !draftId) return admissionReply({ error: "That board is not valid." }, { status: 400 });
  const voice = typeof body.voice === "string" ? body.voice : undefined;
  const pace = typeof body.pace === "number" ? body.pace : undefined;
  const speechModel = typeof body.speechModel === "string" ? body.speechModel : undefined;
  const translateModel = typeof body.translateModel === "string" ? body.translateModel : undefined;
  const lipSyncModel = typeof body.lipSyncModel === "string" ? body.lipSyncModel : undefined;
  const syncMode = typeof body.syncMode === "string" ? body.syncMode : undefined;
  const synced = (l: Line) => mode === "all" || (mode === "hero" && l.hero);
  const anySynced = lines.some(synced);
  if (anySynced) {
    if (!(await lipSyncOnHere())) return admissionReply({ error: "Lip-sync is not on here: ask for the voice only (lipSync: none)." }, { status: 400 });
    if (!syncConfigured()) return admissionReply({ error: "Lip-sync is not set up: SYNC_API_KEY is needed." }, { status: 400 });
  }
  for (const [i, l] of lines.entries()) if (synced(l) && !l.clipGenId && !l.clipUploadId) return admissionReply({ error: `Line ${i + 1} is lip-synced: name its video.` }, { status: 400 });

  /* Where each line starts on the film's clock, when the Hindi is to be placed on a board: given, or the running total of the shots' own lengths. */
  const starts: number[] = [];
  if (draftId) {
    let at = 0;
    for (const [i, l] of lines.entries()) {
      const start = l.startSeconds ?? at;
      if (l.startSeconds == null && i > 0 && !lines[i - 1].clipGenId && !lines[i - 1].clipUploadId && lines[i - 1].startSeconds == null) return admissionReply({ error: `Line ${i + 1}: say where it starts (startSeconds), or name the video before it.` }, { status: 400 });
      starts.push(Math.round(start * 1000) / 1000);
      const clip = l.clipGenId || l.clipUploadId ? await findStoredSource(l.clipGenId ? { genId: l.clipGenId } : { uploadId: l.clipUploadId! }) : null;
      const seconds = clip ? (await resolveStoredDuration(clip)).seconds : null;
      at = start + (seconds ?? 0);
    }
  }

  /* ── The quote: each step asked for its own price ── */
  const sub: AdmissionExecution = { defer: options.defer, ...(options.run ? { run: options.run } : {}) };
  const sarvam = (i: Record<string, unknown>) => executeSarvamAdmission(i, got, sub);
  const priceOf = (r: Reply): StepPrice => ({ credits: Number(r.body.estimatedCredits), price: Number(r.body.price) });
  const plans: LinePlan[] = [];
  for (const [order, line] of lines.entries()) {
    const plan: Partial<LinePlan> = { order, line, synced: synced(line) };
    const spoken = line.hindi ?? placeholder(Math.ceil(chars(line.text) * HINDI_EXPANSION));
    if (!line.hindi) {
      const t = await sarvam({ tool: "translate", text: line.text, source: SOURCE_LANGUAGE, target: HINDI_LANGUAGE, ...(translateModel ? { model: translateModel } : {}), quoteOnly: true });
      if (!ok(t)) return admissionReply({ error: `Line ${order + 1}: ${errorOf(t, "It can't be translated.")}` }, { status: t.status });
      plan.translate = priceOf(t);
    }
    const v = await sarvam({ tool: "speech", text: spoken, language: HINDI_LANGUAGE, ...(voice ? { voice } : {}), ...(pace != null ? { pace } : {}), ...(speechModel ? { model: speechModel } : {}), projectId, shotId: line.shotId, quoteOnly: true });
    if (!ok(v)) return admissionReply({ error: `Line ${order + 1}: ${errorOf(v, "It can't be spoken.")}` }, { status: v.status });
    plan.voice = priceOf(v);
    if (plan.synced) {
      const e = await lipSyncEstimate({ clipGenId: line.clipGenId, clipUploadId: line.clipUploadId, audioSeconds: Math.max(1, Math.ceil(chars(spoken) / HINDI_CHARS_PER_SECOND)), model: lipSyncModel, syncMode });
      if ("error" in e) return admissionReply({ error: `Line ${order + 1}: ${e.error}` }, { status: e.status });
      plan.lipsync = { credits: e.estimatedCredits, price: creditsApply(requireTenant()) ? e.estimatedCredits : e.usd };
    }
    plans.push(plan as LinePlan);
  }
  const all = plans.flatMap((p) => [p.translate, p.voice, p.lipsync]).filter((s): s is StepPrice => !!s);
  const unit = creditsApply(requireTenant()) ? "cr" : "usd";
  const credits = all.reduce((n, s) => n + s.credits, 0);
  const price = all.reduce((n, s) => n + s.price, 0);
  const summary = {
    lines: plans.length, synced: plans.filter((p) => p.synced).length, voiceOnly: plans.filter((p) => !p.synced).length, lipSync: mode, upTo: true as const,
    steps: plans.map((p) => ({ order: p.order, shotId: p.line.shotId, translate: p.translate?.credits ?? 0, voice: p.voice.credits, lipSync: p.lipsync?.credits ?? 0, synced: p.synced })),
  };
  if (quoteOnly) return admissionReply({ estimatedCredits: credits, price: unit === "cr" ? credits : Math.round(price * 1e6) / 1e6, unit, ...summary });

  /* ── The approval: one person, once, for the whole plan ── */
  /* A machine never approves: an agent's identity, a token (the API's and MCP's callers act as their owner), or a step Atomik's Auto approved (the same test as shotCapAdmin). */
  if (!isPersonApprover(got.user.id) || isAgentId(got.user.id) || got.token != null || options.run?.auto === true) return admissionReply({ error: PEOPLE_ONLY }, { status: 403 });
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || credits > (body.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });
  const max = body.maxCredits as number;
  if (body.versionId != null && !(typeof body.versionId === "string" && VERSION_ID.test(body.versionId))) return admissionReply({ error: "A version id is 6 to 64 letters, digits, dots, colons, dashes or underscores." }, { status: 400 });
  if (typeof body.versionId !== "string") return admissionReply({ error: "Name this version (versionId) so a retry finds what is already made." }, { status: 400 });
  const versionId = body.versionId;

  /* ── Run it: line by line, three at a time, each step quoted exactly by its tool and asked at that figure ── */
  const budget = { spent: 0, max };
  const results: Record<string, unknown>[] = new Array(plans.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const at = next++;
      if (at >= plans.length) return;
      results[at] = await runLine(plans[at], { versionId, projectId, voice, pace, speechModel, translateModel, lipSyncModel, syncMode }, budget, got, sub);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  /* The voice lines must carry their length (the export refuses one without it): read it back, measure it if the take did not record it. */
  for (const r of results) if (typeof r.voiceTakeId === "string" && !(await voiceSeconds(r.voiceTakeId))) { r.noLength = true; }
  const placed = draftId ? await placeInDraft(draftId, lines, starts, results, viewer.id, seams.draft ?? writeHindiToDraft) : null;
  const stopped = results.filter((r) => r.stopped).length;
  if (stopped === results.length && results.every((r) => r.made === 0)) {
    const first = results[0] as { reason?: string; status?: number };
    return admissionReply({ error: first.reason ?? "Nothing could be started.", versionId, lines: results.map(publicLine), spent: budget.spent }, { status: first.status ?? 502 });
  }
  return admissionReply({
    id: versionId, versionId, status: stopped ? "partial" : "running", estimatedCredits: credits, spent: budget.spent, stopped, lines: results.map(publicLine), ...(placed ? { draft: placed } : {}),
    ...(stopped ? { retry: RETRY_NOTE } : {}),
  });
}

const publicLine = (r: Record<string, unknown>) => { const { made: _m, status: _s, noLength: _n, ...rest } = r; void _m; void _s; void _n; return rest; };

/** A voice take's recorded length in seconds, measured and recorded now if it was not; null when it cannot be read. */
async function voiceSeconds(genId: string): Promise<number | null> {
  const row = (await db().execute({ sql: "SELECT duration_s FROM generations WHERE id=?", args: [genId] })).rows[0];
  if (row && Number(row.duration_s) > 0) return Number(row.duration_s);
  const source = await findStoredSource({ genId });
  return source ? (await resolveStoredDuration(source)).seconds : null;
}

/**
 * The Hindi language of the board's draft (`boardVoice.hi`), written whole from the takes this version has: a voice line for every line whose Hindi is spoken with a
 * recorded length and room before the next line starts, and a swap (the cut's take -> its lip-synced take) for every synced line named by take. Writing the draft
 * spends nothing; the takes were made first on their own tools. The lines left out are named so a person can fix them.
 */
async function placeInDraft(draftId: string, lines: Line[], starts: number[], results: Record<string, unknown>[], owner: string, write: DraftWriter): Promise<Record<string, unknown>> {
  const voice: VoiceLine[] = [];
  const swap: Record<string, string> = {};
  const left: { order: number; why: string }[] = [];
  let end = 0;
  for (const [i, r] of results.entries()) {
    const take = typeof r.voiceTakeId === "string" ? r.voiceTakeId : null;
    if (!take) { left.push({ order: i, why: "No voice yet." }); continue; }
    const seconds = r.noLength ? null : await voiceSeconds(take);
    if (!seconds) { left.push({ order: i, why: "The voice has no recorded length." }); continue; }
    const text = typeof r.hindi === "string" && r.hindi ? r.hindi : (await db().execute({ sql: "SELECT prompt FROM generations WHERE id=?", args: [take] })).rows[0]?.prompt;
    const start = starts[i];
    if (start < end - 1e-6) { left.push({ order: i, why: "It starts before the line before it ends." }); continue; }
    const next = starts[i + 1];
    if (next != null && start + seconds > next + 1e-6) { left.push({ order: i, why: `The Hindi runs ${(start + seconds - next).toFixed(1)} s past its slot: shorten it.` }); continue; }
    voice.push({ take, startSeconds: start, text: String(text ?? "") });
    end = start + seconds;
    if (typeof r.syncedTakeId === "string" && lines[i].clipGenId) swap[lines[i].clipGenId!] = r.syncedTakeId;
  }
  try {
    const out = await write(owner, draftId, { lines: voice, ...(Object.keys(swap).length ? { swap } : {}) });
    return { language: HINDI_BOARD_LANGUAGE, written: out.written, swaps: Object.keys(swap).length, ...(out.note ? { note: out.note } : {}), ...(left.length ? { left } : {}) };
  } catch (error) {
    return { language: HINDI_BOARD_LANGUAGE, written: 0, note: `The board could not be written: ${error instanceof Error ? error.message.slice(0, 160) : "try again"}.`, ...(left.length ? { left } : {}) };
  }
}

/** The default writer: the person's own draft, replaced for Hindi as one piece, retried against a save that landed first. */
export async function writeHindiToDraft(owner: string, draftId: string, voice: LanguageVoice): Promise<{ written: number; note?: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const draft = await readDraft(owner, draftId);
    if (!draft) return { written: 0, note: "That board is not here." };
    const project = { ...draft.project, boardVoice: withLanguageVoice(draft.project.boardVoice, HINDI_BOARD_LANGUAGE, voice) };
    try { await saveDraft(owner, project, draft.revision); return { written: voice.lines.length }; }
    catch (error) { if (!(error instanceof DraftConflictError)) throw error; }
  }
  return { written: 0, note: "The board changed while this was saved: run it again to place the Hindi." };
}

type RunArgs = { versionId: string; projectId: string | null; voice?: string; pace?: number; speechModel?: string; translateModel?: string; lipSyncModel?: string; syncMode?: string };

/** The take a retry would reuse: this version's, for this line and role, that is made or under way. */
async function existing(versionId: string, order: number, role: "voice" | "synced"): Promise<string | null> {
  const row = (await db().execute({
    sql: `SELECT id FROM generations WHERE deleted=0 AND status IN ('queued','running','succeeded') AND json_extract(params,'$.hindi.version')=? AND json_extract(params,'$.hindi.order')=? AND json_extract(params,'$.hindi.role')=? ORDER BY created_at DESC LIMIT 1`,
    args: [versionId, order, role],
  })).rows[0];
  return row ? String(row.id) : null;
}
async function tag(genId: string, value: { version: string; order: number; role: "voice" | "synced"; shotId: string | null; of?: string | null }): Promise<void> {
  await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.hindi',json(?)) WHERE id=?", args: [JSON.stringify(value), genId] });
}

async function runLine(p: LinePlan, a: RunArgs, budget: { spent: number; max: number }, got: AdmissionActor, sub: AdmissionExecution): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { order: p.order, shotId: p.line.shotId, made: 0 };
  const stop = (reason: string, status = 502) => ({ ...out, stopped: true, reason, status });
  /* One step: quoted exactly by its own tool, held to the approved total, asked at that figure. A step that fails costs nothing and is not counted. */
  const step = async (name: string, quote: () => Promise<Reply>, run: (credits: number) => Promise<Reply>): Promise<Reply | { stop: string; status: number }> => {
    const q = await quote();
    if (!ok(q)) return { stop: `${name}: ${errorOf(q, "It can't be priced.")}`, status: q.status };
    const credits = Number(q.body.estimatedCredits);
    if (!Number.isInteger(credits) || credits < 0) return { stop: `${name}: it could not be priced.`, status: 503 };
    if (budget.spent + credits > budget.max) return { stop: `${name}: this is past the approved amount, so it asks again.`, status: 409 };
    budget.spent += credits;
    const r = await run(credits);
    if (!ok(r)) { budget.spent -= credits; return { stop: `${name}: ${errorOf(r, "It did not start.")}`, status: r.status }; }
    return r;
  };
  const sarvam = (i: Record<string, unknown>) => executeSarvamAdmission(i, got, sub);

  let voiceId = await existing(a.versionId, p.order, "voice");
  if (voiceId) out.voiceTakeId = voiceId;
  else {
    let hindi = p.line.hindi;
    if (!hindi) {
      const t = await step("Translation",
        () => sarvam({ tool: "translate", text: p.line.text, source: SOURCE_LANGUAGE, target: HINDI_LANGUAGE, ...(a.translateModel ? { model: a.translateModel } : {}), quoteOnly: true }),
        (credits) => sarvam({ tool: "translate", text: p.line.text, source: SOURCE_LANGUAGE, target: HINDI_LANGUAGE, ...(a.translateModel ? { model: a.translateModel } : {}), maxCredits: credits }));
      if ("stop" in t) return stop(t.stop, t.status);
      hindi = typeof t.body.text === "string" ? t.body.text.trim() : "";
      if (!hindi) return stop("Translation: nothing came back. Nothing was billed.");
      out.made = Number(out.made) + 1;
    }
    out.hindi = hindi;
    const speech = { tool: "speech", text: hindi, language: HINDI_LANGUAGE, ...(a.voice ? { voice: a.voice } : {}), ...(a.pace != null ? { pace: a.pace } : {}), ...(a.speechModel ? { model: a.speechModel } : {}), projectId: a.projectId, shotId: p.line.shotId };
    const v = await step("Voice", () => sarvam({ ...speech, quoteOnly: true }), (credits) => sarvam({ ...speech, maxCredits: credits }));
    if ("stop" in v) return stop(v.stop, v.status);
    voiceId = String(v.body.id);
    await tag(voiceId, { version: a.versionId, order: p.order, role: "voice", shotId: p.line.shotId });
    out.voiceTakeId = voiceId;
    out.made = Number(out.made) + 1;
  }
  if (!p.synced) return out;

  const synced = await existing(a.versionId, p.order, "synced");
  if (synced) return { ...out, syncedTakeId: synced };
  const lip = { clipGenId: p.line.clipGenId ?? undefined, clipUploadId: p.line.clipUploadId ?? undefined, audioGenId: voiceId, ...(a.lipSyncModel ? { model: a.lipSyncModel } : {}), ...(a.syncMode ? { syncMode: a.syncMode } : {}), projectId: a.projectId, shotId: p.line.shotId };
  const l = await step("Lip-sync", () => executeLipSyncAdmission({ ...lip, quoteOnly: true }, got, sub), (credits) => executeLipSyncAdmission({ ...lip, maxCredits: credits }, got, sub));
  if ("stop" in l) return stop(l.stop, l.status);
  const syncedId = String(l.body.id);
  await tag(syncedId, { version: a.versionId, order: p.order, role: "synced", shotId: p.line.shotId, of: p.line.clipGenId ?? p.line.clipUploadId });
  return { ...out, syncedTakeId: syncedId, made: Number(out.made) + 1 };
}

/* ── What the cut reads ───────────────────────────────────────────────────────────────────────────────────────────────────── */

export type HindiLineStatus = {
  order: number; shotId: string | null;
  /** The Hindi, spoken: the voice take. Absent until it is made. */
  voice: { takeId: string; status: string; hindi: string } | null;
  /** The shot lip-synced to it, when this line is synced. */
  synced: { takeId: string; status: string; of: string | null } | null;
};

/**
 * Where a Hindi version stands, line by line, read from the takes it tagged. The Hindi cut takes, for each line in order, the synced take's picture when there is a done
 * one (else the shot's own video) and the voice take's sound. `done` is true when every voice take is made and every synced take that exists is made.
 */
export async function hindiVersionStatus(versionId: string): Promise<{ versionId: string; lines: HindiLineStatus[]; done: boolean; failed: number } | null> {
  if (!VERSION_ID.test(versionId)) return null;
  await ready();
  const rows = (await db().execute({
    sql: `SELECT id, status, prompt, params, shot_id FROM generations WHERE deleted=0 AND json_extract(params,'$.hindi.version')=? ORDER BY created_at`,
    args: [versionId],
  })).rows;
  const byOrder = new Map<number, HindiLineStatus>();
  for (const r of rows) {
    let tagged: { order?: number; role?: string; shotId?: string | null; of?: string | null } | undefined;
    try { tagged = (JSON.parse(String(r.params)) as { hindi?: typeof tagged }).hindi; } catch { /* unreadable */ }
    if (!tagged || typeof tagged.order !== "number") continue;
    const line = byOrder.get(tagged.order) ?? { order: tagged.order, shotId: tagged.shotId ?? (r.shot_id == null ? null : String(r.shot_id)), voice: null, synced: null };
    if (tagged.role === "voice") line.voice = { takeId: String(r.id), status: String(r.status), hindi: String(r.prompt ?? "") };
    else if (tagged.role === "synced") line.synced = { takeId: String(r.id), status: String(r.status), of: tagged.of ?? null };
    byOrder.set(tagged.order, line);
  }
  if (!byOrder.size) return null;
  const lines = [...byOrder.values()].sort((x, y) => x.order - y.order);
  const failed = lines.filter((l) => l.voice?.status === "failed" || l.synced?.status === "failed").length;
  const done = lines.every((l) => l.voice?.status === "succeeded" && (!l.synced || l.synced.status === "succeeded"));
  return { versionId, lines, done, failed };
}

/** The reply as the idempotency claim keeps it: without the Hindi text (a translation is kept nowhere but the voice take's own prompt). */
export function recordedHindiReply(json: string): string {
  let body: unknown;
  try { body = JSON.parse(json); } catch { return json; }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { lines?: unknown }).lines)) return json;
  const reply = body as { lines: Record<string, unknown>[] };
  return JSON.stringify({ ...reply, lines: reply.lines.map((l) => { const { hindi: _h, ...rest } = l; void _h; return rest; }) });
}

/**
 * `hindi_version`, declared beside its handler. The button, a board card, Atomik, a saved skill and an outside agent over MCP all reach the one route
 * (POST /api/hindi-version), at the same price, through the same approval. Anyone may PREPARE it (a quote); a person approves the price (`maxCredits`).
 */
export const HINDI_VERSION_TOOL = {
  id: "hindi_version",
  kind: "engine" as const,
  provider: "sarvam+syncso",
  needs: ["SARVAM_API_KEY", "SARVAM_USD_PER_INR", "SARVAM_ENABLED", "SYNC_API_KEY (only for lip-synced shots)", "SYNC_ENABLED (only for lip-synced shots)"],
  route: "/api/hindi-version",
  inputs: {
    lines: `up to ${HINDI_MAX_LINES} of { text (English) or hindi (already written), shotId, clipTakeId or clipUploadId (the shot's video, for a synced line), hero }`,
    lipSync: "hero (default), all or none", voice: "a stock voice's name (optional)", versionId: "names this version; a retry with it skips what is made",
    projectId: "the production (optional)", draftId: "the board to place the Hindi on (optional; each line then says startSeconds, or follows the video before it)", maxCredits: "the approved price, for the whole plan",
  },
  price: { quote: "POST /api/hindi-version { quoteOnly: true }" },
  who: "prepare: anyone; approve: a person" as const,
};

/** The tools present for a workspace: none unless Sarvam is on and priced for it. */
export async function hindiVersionTools(): Promise<(typeof HINDI_VERSION_TOOL)[]> {
  return (await hindiVersionOn()) ? [HINDI_VERSION_TOOL] : [];
}
