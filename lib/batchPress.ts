import { createHash } from "node:crypto";
import { creditsApply, creditState } from "./credits";
import { requireTenant } from "./tenant";
import { isHouseWorkspace } from "./houseWorkspace";
import { isPersonApprover } from "./workbench/plan-approval";
import { isAgentId } from "./security/people-only";
import { billedTo } from "./providers";
import { paidByPlatform, vendorKeyNameFor } from "./platformSpend";
import { jobLineNow } from "./shotCap";
import { prepareGeneration, admitGeneration } from "./generationAdmission";
import type { AdmissionActor, AdmissionExecution, AdmissionReply, PreparedAdmission } from "./admissionTypes";
import { admissionReply, assertAdmissionActor } from "./admissionSupport";
import { db, now } from "./db";
import { platformDb, platformReady } from "./platform";
import { fenceGenerationRequest, generationFingerprint, generationRequestsReady, settleStaleClaim } from "./generationRequests";
import { discardHeldJob } from "./held";
import { QueuedCancelError, cancelQueuedVideo, servedHere, type QueuedCancel } from "./queuedCancel";

/**
 * A multi-shot press is ONE job (owner, 16 Oct 2026, A.2): judged as one against the 200 cr line (SOW §7A guardrail 4), with one approval that shows the total.
 *
 * Without this, a press of N shots is N requests that are each under the line, and the line never sees the sum. Here the SERVER prices every member itself (the same
 * `prepareGeneration` every take is priced by; a total from the client is never read), adds their holds, and judges the sum with the one rule every job is judged by
 * (`jobLineNow`): over the line, a member of the workspace is told an admin has to start it, an admin's own tap clears it, and a token, an MCP client or Atomik can prepare it
 * and never start it. Exactly at the line is not over it.
 *
 * The approval is the person's, once, for exactly the listed members at their listed prices: it carries the batch's fingerprint (a hash of every member's own quote
 * fingerprint and the total), so a member added, removed or re-priced is another batch that asks again. The balance is checked against what is still to start before the
 * first member of this press starts, never halfway through.
 *
 * ONE PRESS, ASKED AGAIN, STARTS NOTHING TWICE. The press is named by its Idempotency-Key, which it must carry. Each member is admitted through the ordinary generation
 * admission under a key of its own, made from the press's key, the shots of the press and the member's place, plus an attempt number; that claim is bound in the same
 * write as the take's row (atomic binding), so a member's claim names its take or proves there is none. No reply is stored for the press as a whole: asking again
 * under the same key reads every member's claims afresh. A member whose claim names a take is that take (reported, never started again, whatever became of it); one
 * whose claim is still being accepted is reported as starting; one that was refused (a rate limit, a cap) made no take and was charged nothing, so it is admitted again
 * under its next attempt. A claim left behind by a press that was killed mid-way is settled once no request can still be running it (STALE_CLAIM_MS), and its member
 * then starts on the next ask. The same key with other shots is refused: it names another press.
 *
 * CANCELLED SHOTS ARE NOT CHARGED (owner, 16 Oct 2026 evening, 2e). Cancelling a press (`cancel: true` under its key) sets the press aside for good, so no member that
 * has not started ever starts under it, asked again or not: each member's claim is written only while the cancel does not exist, in one statement (`fencedBy`), so a
 * cancel that lands between the press's own check and a member's claim still stops that member before anything is reserved or sent; a member waiting held (for a slot or for credits) is discarded, never reserved or sent; a member still in its
 * engine's queue is cancelled there through the take's own cancel (lib/queuedCancel.ts), which bills nothing only while the engine still has it queued. A member the engine
 * has already started is not cancelled and is billed as today; the reply says so. No price, margin or ledger rule is written here.
 *
 * Members are ordinary generation requests (the body POST /api/generate takes, with no `maxCredits`). The members do not carry `batchId`/`batchSize`: those are a composer's
 * own claim about its press (lib/batchLine.ts) and would judge each member by the first one's price times the rest; this endpoint has already judged the sum.
 */
export const BATCH_MAX_MEMBERS = 24;
const PEOPLE_ONLY = "Only a person approves spending. Atomik, outside agents and tokens can prepare this, never approve it.";
const NEEDS_KEY = "Send the press with an Idempotency-Key, so that asking again never starts a shot twice.";
const OTHER_PRESS = "This Idempotency-Key already names a press of other shots.";
const CANCELLED = "This press was cancelled. Nothing more starts under it.";
const RETRY = "Ask again under the same Idempotency-Key: shots already started are not started again. Nothing was charged for the shots that did not start.";
const STARTING = "This shot was being started as the press was cancelled. Cancel it once it shows.";
const UNCONFIRMED = "Cancellation could not be confirmed. The take is still tracked; check it before trying again.";

export type BatchExecution = {
  defer: AdmissionExecution["defer"];
  run?: AdmissionExecution["run"];
  checkpoint?: AdmissionExecution["checkpoint"];
  /** The press's own Idempotency-Key (the route's header): required to press or cancel, never to quote. */
  pressKey?: string;
};
/** The engine boundary of a cancel, replaceable in mocked tests only: a take in its engine's queue is cancelled through lib/queuedCancel.ts. */
export type BatchCancelDeps = { cancelQueued: (id: string) => Promise<QueuedCancel> };

/** What the line is judged on for one member: its price at its hold (the most it can settle at), and the engine's dollars at that hold (the house pays at cost). */
function holdOf(p: PreparedAdmission): { credits: number; usd: number } {
  const credits = p.quote.ceilingCredits ?? p.quote.estimatedCredits;
  const usd = p.quote.unit === "usd" ? p.quote.price * (p.quote.ceilingCredits != null && p.quote.estimatedCredits > 0 ? p.quote.ceilingCredits / p.quote.estimatedCredits : 1) : 0;
  return { credits, usd };
}
const platformKeyOf = (p: PreparedAdmission) => vendorKeyNameFor(billedTo(String((p.compiled.model as { provider?: unknown } | undefined)?.provider ?? "byteplus")));

/* ── The press's keys ── */
const hex = (value: string, n: number) => createHash("sha256").update(value).digest("hex").slice(0, n);
/** Every claim of a press lives under this prefix, among the person's own claims: the press's key, hashed (only a–f, digits and colons follow it). */
export const pressPrefix = (pressKey: string) => `bp:${hex(pressKey, 24)}:`;
/** The shots a press was made of, as the client listed them (order counts): the same key with other shots is another press. */
export const pressShots = (members: Record<string, unknown>[]) => hex(generationFingerprint(members), 24);
/** One member's claim for one attempt: `bp:<press>:<shots>:<index>:<attempt>`. */
export const memberKey = (pressKey: string, shots: string, index: number, attempt: number) => `${pressPrefix(pressKey)}${shots}:${index}:${attempt}`;
const cancelKey = (pressKey: string) => `${pressPrefix(pressKey)}cancel`;
const CANCEL_FINGERPRINT = "batch-press-cancel-v1";
/** The press's own record of its shots, written before its first shot is claimed, so a cancel lists every shot, claimed or not. Never a request: it answers none. */
const membersKey = (pressKey: string) => `${pressPrefix(pressKey)}members`;
const membersFingerprint = (shots: string) => `batch-press-members-v1:${shots}`;

type Attempt = { key: string; shots: string; index: number; attempt: number; jobId: string | null; pending: boolean };
/** The press's claims as the database has them now: every member attempt, whether the press was cancelled, and its shots as it recorded them (null before it pressed). */
async function pressClaims(userId: string, pressKey: string): Promise<{ attempts: Attempt[]; cancelled: boolean; recorded: { shots: string; members: number } | null }> {
  await generationRequestsReady();
  const prefix = pressPrefix(pressKey);
  const rows = (await db().execute({
    sql: `SELECT request_key,fingerprint,generation_id,response_json FROM generation_requests WHERE user_id=? AND request_key>=? AND request_key<?`,
    args: [userId, prefix, `${prefix}~`],
  })).rows;
  const attempts: Attempt[] = [];
  let cancelled = false;
  let recorded: { shots: string; members: number } | null = null;
  for (const row of rows) {
    const rest = String(row.request_key).slice(prefix.length);
    let reply: { id?: unknown; code?: unknown } = {};
    try { reply = row.response_json ? JSON.parse(String(row.response_json)) : {}; } catch { /* an unreadable reply still has its bound job, below */ }
    if (rest === "cancel") { cancelled ||= reply.code === "set_aside"; continue; }
    if (rest === "members") {
      const n = Number((reply as { members?: unknown }).members);
      const shots = String(row.fingerprint).slice(membersFingerprint("").length);
      if (Number.isInteger(n) && n > 0 && n <= BATCH_MAX_MEMBERS) recorded = { shots, members: n };
      continue;
    }
    const m = /^([a-f0-9]{24}):(\d{1,2}):(\d{1,4})$/.exec(rest);
    if (!m) continue;
    const jobId = row.generation_id != null ? String(row.generation_id) : typeof reply.id === "string" && reply.id ? reply.id : null;
    attempts.push({ key: String(row.request_key), shots: m[1], index: Number(m[2]), attempt: Number(m[3]), jobId, pending: !row.response_json && row.generation_id == null });
  }
  return { attempts, cancelled, recorded };
}

/**
 * A take of the press that failed and was charged nothing: refused at its reservation (a cap, a rate limit: nothing was reserved, so it has no meter row), or failed
 * at no cost. Like any failed step that cost nothing it is retried under the same approval (rule 14), as a new attempt. A failed take that was charged anything, or
 * whose charge is not settled, is never retried here: that would be new spend, which asks again.
 */
async function failedFree(id: string): Promise<boolean> {
  const take = (await db().execute({ sql: "SELECT status FROM generations WHERE id=?", args: [id] })).rows[0];
  if (!take || String(take.status) !== "failed") return false;
  await platformReady();
  const meter = (await platformDb().execute({ sql: "SELECT status,billed_credits,engine_cost_usd FROM meter_events WHERE id=? AND workspace_id=?", args: [id, requireTenant().id] })).rows[0];
  return !meter || (String(meter.status) === "failed" && Number(meter.billed_credits ?? 0) === 0 && Number(meter.engine_cost_usd ?? 0) === 0);
}

type MemberState = { state: "landed"; id: string } | { state: "pending" } | { state: "open"; next: number };
/**
 * Where one member of the press stands, from its own attempts. A claim that names a take is that take, unless the take failed at no charge (failedFree). One still
 * being accepted is starting, unless no request can still be running it: then it is settled (no take, nothing charged) and the member is open again. Otherwise every
 * attempt was refused or failed free, and the next attempt is open.
 */
async function memberState(userId: string, attempts: Attempt[]): Promise<MemberState> {
  for (const a of attempts.filter((x) => x.jobId)) if (!(await failedFree(a.jobId!))) return { state: "landed", id: a.jobId! };
  for (const a of attempts.filter((x) => x.pending)) {
    if (await settleStaleClaim(userId, a.key)) continue;
    /* Not settled: still being accepted, or it bound a take or got its answer a moment ago. Read it once more. */
    const row = (await db().execute({ sql: "SELECT generation_id,response_json FROM generation_requests WHERE user_id=? AND request_key=?", args: [userId, a.key] })).rows[0];
    if (row?.generation_id != null && !(await failedFree(String(row.generation_id)))) return { state: "landed", id: String(row.generation_id) };
    if (row?.generation_id == null && !row?.response_json) return { state: "pending" };
  }
  return { state: "open", next: attempts.reduce((n, a) => Math.max(n, a.attempt + 1), 0) };
}
async function takeStatuses(ids: string[]): Promise<Map<string, { status: string; provider: string; kind: string }>> {
  if (!ids.length) return new Map();
  const rows = (await db().execute({ sql: `SELECT id,status,provider,kind FROM generations WHERE id IN (${ids.map(() => "?").join(",")})`, args: ids })).rows;
  return new Map(rows.map((r) => [String(r.id), { status: String(r.status), provider: String(r.provider ?? ""), kind: String(r.kind ?? "") }]));
}

type MemberOut = { index: number; id?: string; status?: string; error?: string; code?: number; charged?: 0 };

export async function admitBatch(input: Record<string, unknown>, got: AdmissionActor, options: BatchExecution): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  if (options.checkpoint) return admissionReply({ error: "A batch is several jobs under one approval: it is quoted here and approved by a person." }, { status: 400 });
  const quoteOnly = input.quoteOnly === true;
  const members = input.members;
  if (!Array.isArray(members) || !members.length) return admissionReply({ error: "Add the shots to make." }, { status: 400 });
  if (members.length > BATCH_MAX_MEMBERS) return admissionReply({ error: `A press takes up to ${BATCH_MAX_MEMBERS} shots at a time.` }, { status: 400 });

  /* ── The server prices every member itself ── */
  const prepared: PreparedAdmission[] = [];
  const shotsAsSent: Record<string, unknown>[] = [];
  for (const [i, raw] of members.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return admissionReply({ error: `Shot ${i + 1} is not valid.` }, { status: 400 });
    const { maxCredits: _a, quoteFingerprint: _b, batchId: _c, batchSize: _d, ...member } = raw as Record<string, unknown>;
    void _a; void _b; void _c; void _d;
    shotsAsSent.push(member);
    const p = await prepareGeneration(member, got);
    /* The shot is named beside the refusal, never inside it: a cap's or a limit's words stay exactly the door's own, with no figure in them. */
    if (!p.ok) return admissionReply({ ...p.body, error: typeof p.body.error === "string" ? p.body.error : "This shot can't be priced.", shot: i + 1 }, { status: p.status });
    prepared.push(p.value);
  }
  const unit = creditsApply(requireTenant()) ? "cr" : "usd";
  const holds = prepared.map(holdOf);
  const credits = holds.reduce((n, h) => n + h.credits, 0);
  const usd = holds.reduce((n, h) => n + h.usd, 0);
  const price = prepared.reduce((n, p) => n + p.quote.price, 0);
  const estimatedCredits = prepared.reduce((n, p) => n + p.quote.estimatedCredits, 0);

  /* ── Guardrail 4 on the SUM, by the one rule every job is judged by ── */
  const anyPlatform = prepared.find((p) => paidByPlatform(platformKeyOf(p)));
  if (anyPlatform || isHouseWorkspace(requireTenant())) {
    const over = jobLineNow({ credits, usd, key: platformKeyOf(anyPlatform ?? prepared[0]), actor: got, auto: options.run?.auto === true });
    if (over) return admissionReply({ error: over, needsAdmin: true, members: prepared.length }, { status: 403 });
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ v: 1, members: prepared.map((p) => p.quote.fingerprint), credits })).digest("hex");
  const batchId = `bt_${fingerprint.slice(0, 24)}`;
  if (quoteOnly) return admissionReply({ estimatedCredits, price: unit === "cr" ? estimatedCredits : Math.round(price * 1e6) / 1e6, unit, members: prepared.length, batchId, fingerprint, ...(credits > estimatedCredits ? { ceilingCredits: credits } : {}) });

  /* ── The approval: one person, once, for exactly these members at these prices ── */
  if (!isPersonApprover(got.user.id) || isAgentId(got.user.id) || got.token != null || options.run?.auto === true) return admissionReply({ error: PEOPLE_ONLY }, { status: 403 });
  if (typeof input.fingerprint !== "string" || input.fingerprint !== fingerprint)
    return admissionReply({ error: "The shots or their prices changed. Look at the total again before approving.", quoteChanged: true }, { status: 409 });
  if (!Number.isInteger(input.maxCredits) || (input.maxCredits as number) < 0 || credits > (input.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the total is above the approved credit amount." }, { status: 409 });
  const pressKey = options.pressKey;
  if (!pressKey) return admissionReply({ error: NEEDS_KEY }, { status: 400 });

  /* ── Where each member stands under this press: started, starting, or still to start ── */
  const userId = got.user.id;
  const shots = pressShots(shotsAsSent);
  const claims = await pressClaims(userId, pressKey);
  if (claims.attempts.some((a) => a.shots !== shots) || (claims.recorded && claims.recorded.shots !== shots)) return admissionReply({ error: OTHER_PRESS }, { status: 409 });
  const states: MemberState[] = [];
  for (let index = 0; index < prepared.length; index++) states.push(await memberState(userId, claims.attempts.filter((a) => a.index === index)));
  const statuses = await takeStatuses(states.flatMap((s) => (s.state === "landed" ? [s.id] : [])));
  const reported = (index: number, s: MemberState, cancelled: boolean): MemberOut =>
    s.state === "landed" ? { index, id: s.id, status: statuses.get(s.id)?.status ?? "queued" }
      : s.state === "pending" ? { index, status: "starting" }
        : cancelled ? { index, status: "cancelled", charged: 0 } : { index };
  if (claims.cancelled)
    return admissionReply({ error: CANCELLED, cancelled: true, id: batchId, batchId, members: states.map((s, i) => reported(i, s, true)) }, { status: 409 });

  /* The balance against what is still to start, before the first of it starts (rule 14): never halfway through. What already started holds its own reservation. */
  const toStart = states.reduce((n, s, i) => n + (s.state === "open" ? holds[i].credits : 0), 0);
  const state = unit === "cr" && toStart > 0 ? await creditState() : null;
  if (state && state.balance < toStart)
    return admissionReply({ error: `Short by ${Math.ceil((toStart - state.balance) * 10) / 10} cr. Top up, then approve. Nothing is spent until you do.`, short: true }, { status: 402 });

  /* ── Each member still to start, at its own quote, under its own claim ── */
  /* Its shots recorded first, so a cancel from here on lists every one of them, even a shot whose claim it lands before. */
  await db().execute({
    sql: `INSERT OR IGNORE INTO generation_requests(user_id,request_key,fingerprint,response_json,response_status,created_at,updated_at) VALUES(?,?,?,?,409,?,?)`,
    args: [userId, membersKey(pressKey), membersFingerprint(shots), JSON.stringify({ error: OTHER_PRESS, code: "press", members: prepared.length }), now(), now()],
  });
  const out: MemberOut[] = [];
  let stopped = false;
  for (const [index, p] of prepared.entries()) {
    const s = states[index];
    if (s.state !== "open") { out.push(reported(index, s, false)); continue; }
    /* A cancel that arrived while this press was running: nothing more starts. */
    stopped ||= (await pressClaims(userId, pressKey)).cancelled;
    if (stopped) { out.push({ index, status: "cancelled", charged: 0 }); continue; }
    /* The cancel is checked again in the claim's own write (fencedBy): one that lands after the check above still stops this shot, before anything is reserved or sent. */
    const reply = await admitGeneration(p, got, { requestKey: memberKey(pressKey, shots, index, s.next), defer: options.defer, fencedBy: cancelKey(pressKey), ...(options.run ? { run: options.run } : {}) });
    if (reply.body.code === "set_aside" && typeof reply.body.id !== "string" && (await pressClaims(userId, pressKey)).cancelled) { stopped = true; out.push({ index, status: "cancelled", charged: 0 }); }
    else if ((reply.status === 200 || reply.status === 202) && typeof reply.body.id === "string") out.push({ index, id: reply.body.id, status: typeof reply.body.status === "string" ? reply.body.status : "queued" });
    else if (reply.status === 409 && reply.body.pending === true) out.push({ index, status: "starting" });
    else out.push({ index, error: typeof reply.body.error === "string" ? reply.body.error : "It did not start.", code: reply.status, charged: 0 });
  }
  const refused = out.filter((m) => m.error);
  const started = out.filter((m) => m.id || m.status === "starting").length;
  const status = stopped ? "cancelled" : refused.length ? (started ? "partial" : "refused") : "started";
  return admissionReply(
    { id: batchId, batchId, status, estimatedCredits, members: out, ...(refused.length ? { retry: RETRY } : {}) },
    { status: status === "refused" ? refused[0].code ?? 502 : 200 },
  );
}

/**
 * Cancel a press (owner, 16 Oct 2026 evening, 2e: cancelled shots are not charged). First the press is set aside for good, so nothing that has not started starts
 * under it, then each member that started is cancelled where that bills nothing: held (never reserved or sent), it is discarded; in its engine's queue, it is cancelled
 * there (the take's own cancel). A take the engine already started is billed as today, and the reply says so. The person's own press, by its key; nothing is priced here.
 */
export async function cancelBatch(pressKey: string | null | undefined, got: AdmissionActor, deps: BatchCancelDeps = { cancelQueued: (id) => cancelQueuedVideo(id) }): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  if (!pressKey) return admissionReply({ error: "Name the press to cancel by its Idempotency-Key." }, { status: 400 });
  const userId = got.user.id;
  await fenceGenerationRequest({ userId, key: cancelKey(pressKey), fingerprint: CANCEL_FINGERPRINT });
  const { attempts, recorded } = await pressClaims(userId, pressKey);
  /* Every shot the press recorded, claimed or not (a shot not yet claimed now never will be: its claim's write sees this cancel), and any claimed shot besides. */
  const indices = [...new Set([...attempts.map((a) => a.index), ...Array.from({ length: recorded?.members ?? 0 }, (_, i) => i)])].sort((a, b) => a - b);
  const states = new Map<number, MemberState>();
  for (const index of indices) states.set(index, await memberState(userId, attempts.filter((a) => a.index === index)));
  const statuses = await takeStatuses([...states.values()].flatMap((s) => (s.state === "landed" ? [s.id] : [])));
  const members: MemberOut[] = [];
  for (const index of indices) {
    const s = states.get(index)!;
    if (s.state === "open") { members.push({ index, status: "cancelled", charged: 0 }); continue; }
    if (s.state === "pending") { members.push({ index, status: "starting", error: STARTING }); continue; }
    const take = statuses.get(s.id);
    if (take?.status === "held") {
      if (await discardHeldJob(s.id)) { members.push({ index, id: s.id, status: "cancelled", charged: 0 }); continue; }
      /* Released a moment ago: it is a take like any other now. */
      const now = (await takeStatuses([s.id])).get(s.id);
      members.push({ index, id: s.id, status: now?.status ?? "queued", ...(now?.status === "queued" ? { error: UNCONFIRMED } : {}) });
      continue;
    }
    if (take?.status === "queued" && servedHere(take)) {
      try {
        const done = await deps.cancelQueued(s.id);
        members.push({ index, id: s.id, status: done.status, ...(done.status === "cancelled" ? { charged: 0 as const } : {}) });
      } catch (error) {
        members.push({ index, id: s.id, status: "queued", error: error instanceof QueuedCancelError ? error.message : UNCONFIRMED });
      }
      continue;
    }
    /* Started at its engine, or already ended: not cancelled here, billed as today. */
    members.push({ index, id: s.id, status: take?.status ?? "queued" });
  }
  return admissionReply({ status: "cancelled", members });
}
