import { createHash } from "node:crypto";
import { creditsApply, creditState } from "./credits";
import { requireTenant } from "./tenant";
import { isHouseWorkspace } from "./houseWorkspace";
import { isPersonApprover } from "./workbench/plan-approval";
import { isAgentId } from "./security/people-only";
import { billedTo } from "./providers";
import { paidByPlatform, vendorKeyNameFor } from "./platformSpend";
import { allowanceUsdOfStored, platformSpendThisMonth } from "./allowance";
import { houseCapOfStored, houseMonthStart, houseSpendSince } from "./houseCap";
import { verdictOf, type Quote } from "./quote";
import { prepareGeneration, admitGeneration } from "./generationAdmission";
import type { AdmissionActor, AdmissionExecution, AdmissionReply, PreparedAdmission } from "./admissionTypes";
import { admissionReply, assertAdmissionActor } from "./admissionSupport";
import { db, now } from "./db";
import { platformDb, platformReady } from "./platform";
import { fenceGenerationRequest, generationFingerprint, generationRequestsReady, settleStaleClaim } from "./generationRequests";
import { discardHeldJob } from "./held";
import { QueuedCancelError, cancelQueuedVideo, servedHere, type QueuedCancel } from "./queuedCancel";

/**
 * A multi-shot press is ONE job (owner, 16 Oct 2026, A.2), with one approval that shows the total.
 *
 * The SERVER prices every member itself (the same `prepareGeneration` every take is priced by, with every check a single take meets there; a total from the client
 * is never read) and adds their holds. The 200 cr per-job line is not judged on the sum (owner, 19 Oct 2026: "#815 keeps “a multi-shot press is one job, one
 * approval for the total” and drops the guardrail-4 check; a press whose total would pass the workspace cap is refused at the quote"). What the sum IS judged
 * against is the workspace's monthly spending cap (`capVerdict`): the workspace's own cap on the platform's engines, or for the house workspace its house cap
 * (lib/houseCap.ts), counted as the admission gate counts it (this month's spend and running holds), with every shot of the press at its hold. A press that would
 * pass it is refused whole, at the quote and again at the press before any shot is admitted (429, in the cap's own words). Each shot's own reservation still judges
 * the cap as before and remains the backstop: two presses at once, a claim still in flight or a take parked as held (neither counted here) are caught there, and an
 * edge where the reservation counts a take higher than this gate does can still end a press `partial`, with nothing charged for the shots that did not start. A
 * re-quote of a partly started press counts its started shots twice; ask again with the press's key instead. A workspace with no cap is not judged here. A token,
 * an MCP client or Atomik may ask the price, never press.
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
 * own label for its press; nothing judges a member on a batch line (there is no per-job line since 20 Oct 2026), and each member here is judged on its own.
 */
export const BATCH_MAX_MEMBERS = 24;
const PEOPLE_ONLY = "Only a person approves spending. Atomik, outside agents and tokens can prepare this, never approve it.";
const NEEDS_KEY = "Send the press with an Idempotency-Key, so that asking again never starts a shot twice.";
const OTHER_PRESS = "This Idempotency-Key already names a press of other shots.";
const CANCELLED = "This press was cancelled. Nothing more starts under it.";
const RETRY = "Ask again under the same Idempotency-Key: shots already started are not started again. Nothing billed for the shots that did not start.";
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

/** One member's price at its hold (the most it can settle at): what the approval and the balance are judged on. */
const holdCredits = (p: PreparedAdmission): number => p.quote.ceilingCredits ?? p.quote.estimatedCredits;
const platformKeyOf = (p: PreparedAdmission) => vendorKeyNameFor(billedTo(String((p.compiled.model as { provider?: unknown } | undefined)?.provider ?? "byteplus")));

/**
 * The workspace's monthly cap judged on the sum of these members, each at its hold, by the verdict a quote is judged with (lib/quote.ts verdictOf): only its
 * monthly cap and, in the house, the house cap; every other check is each shot's own. The caps as the reservation reads them (lib/generationRequests.ts
 * reserveGenerationSpendLocked): the stored `allowance_usd` read afresh, the workspace's own figure or the deployment's default for a customer
 * (allowanceUsdOfStored, which applies only to work the platform's keys pay for), the house's figure or its default for the house (houseCapOfStored). This
 * month's spend is what those caps count it as: the platform's spend for this workspace (platformSpendThisMonth), or the house's meter rows (houseSpendSince),
 * running jobs at their hold. Engine dollars stay here: the refusal carries the cap's own sentence and no figure; the house's notice is its own words.
 */
async function capVerdict(members: { p: PreparedAdmission; holdUsd: number }[]): Promise<{ refusal: string | null; notice: string }> {
  if (!members.length) return { refusal: null, notice: "" };
  const ws = requireTenant();
  const house = isHouseWorkspace(ws);
  const lines = members.map(({ p, holdUsd }, i) => ({
    key: String(i), credits: holdCredits(p), count: 1, usd: holdUsd, spent: 0, code: "", projectId: null, platformPays: house || paidByPlatform(platformKeyOf(p)),
  }));
  if (!house && !lines.some((l) => l.platformPays)) return { refusal: null, notice: "" };
  await platformReady();
  const standing = (await platformDb().execute({ sql: "SELECT allowance_usd FROM workspaces WHERE id=?", args: [ws.id] })).rows[0];
  const houseCap = house ? houseCapOfStored(standing?.allowance_usd).usd : null;
  const cap = house ? null : standing ? allowanceUsdOfStored(standing.allowance_usd) : allowanceUsdOfStored(ws.allowanceUsd);
  if (houseCap == null && cap == null) return { refusal: null, notice: "" };
  const quote: Quote = { totalCredits: lines.reduce((n, l) => n + l.credits, 0), unitCredits: null, units: lines.length, usd: lines.reduce((n, l) => n + l.usd, 0), lines };
  const verdict = verdictOf(quote, {
    balance: null,
    allowance: cap == null ? null : { cap, spent: await platformSpendThisMonth() },
    houseCap: houseCap == null ? null : { cap: houseCap, spent: await houseSpendSince(houseMonthStart()) },
    caps: {}, warnPct: 80, rule: "anyone", shotCap: 0, isAdmin: false,
  });
  return verdict.allow ? { refusal: null, notice: verdict.notice } : { refusal: verdict.line, notice: "" };
}

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
 * whose charge is not settled, is never retried here: that would be new spend, which asks again. Free means KNOWN to be free: a meter row whose credits or vendor
 * cost were never reported (NULL; on a workspace's own key a lost vendor answer leaves the cost unknown, and a retry would spend its own vendor dollars again) is not.
 */
async function failedFree(id: string): Promise<boolean> {
  const take = (await db().execute({ sql: "SELECT status FROM generations WHERE id=?", args: [id] })).rows[0];
  if (!take || String(take.status) !== "failed") return false;
  await platformReady();
  const meter = (await platformDb().execute({ sql: "SELECT status,billed_credits,engine_cost_usd FROM meter_events WHERE id=? AND workspace_id=?", args: [id, requireTenant().id] })).rows[0];
  const knownZero = (v: unknown) => v != null && Number(v) === 0;
  return !meter || (String(meter.status) === "failed" && knownZero(meter.billed_credits) && knownZero(meter.engine_cost_usd));
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
  /* Each member's engine dollars at its hold, for the monthly cap only (server-only, never in a reply). */
  const holdUsd: number[] = [];
  const shotsAsSent: Record<string, unknown>[] = [];
  for (const [i, raw] of members.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return admissionReply({ error: `Shot ${i + 1} is not valid.` }, { status: 400 });
    const { maxCredits: _a, quoteFingerprint: _b, batchId: _c, batchSize: _d, ...member } = raw as Record<string, unknown>;
    void _a; void _b; void _c; void _d;
    shotsAsSent.push(member);
    const cost: { holdUsd?: number } = {};
    const p = await prepareGeneration(member, got, cost);
    /* The shot is named beside the refusal, never inside it: a cap's or a limit's words stay exactly the door's own, with no figure in them. */
    if (!p.ok) return admissionReply({ ...p.body, error: typeof p.body.error === "string" ? p.body.error : "This shot can't be priced.", shot: i + 1 }, { status: p.status });
    if (!Number.isFinite(cost.holdUsd) || cost.holdUsd! < 0) return admissionReply({ error: "This shot can't be priced.", shot: i + 1 }, { status: 400 });
    prepared.push(p.value);
    holdUsd.push(cost.holdUsd!);
  }
  const unit = creditsApply(requireTenant()) ? "cr" : "usd";
  const holds = prepared.map(holdCredits);
  const credits = holds.reduce((n, h) => n + h, 0);
  const price = prepared.reduce((n, p) => n + p.quote.price, 0);
  const estimatedCredits = prepared.reduce((n, p) => n + p.quote.estimatedCredits, 0);
  const fingerprint = createHash("sha256").update(JSON.stringify({ v: 1, members: prepared.map((p) => p.quote.fingerprint), credits })).digest("hex");
  const batchId = `bt_${fingerprint.slice(0, 24)}`;
  if (quoteOnly) {
    /* ── The workspace's monthly cap on the whole press, before anyone can press it ── */
    const cap = await capVerdict(prepared.map((p, i) => ({ p, holdUsd: holdUsd[i] })));
    if (cap.refusal) return admissionReply({ error: cap.refusal }, { status: 429 });
    return admissionReply({ estimatedCredits, price: unit === "cr" ? estimatedCredits : Math.round(price * 1e6) / 1e6, unit, members: prepared.length, batchId, fingerprint, ...(credits > estimatedCredits ? { ceilingCredits: credits } : {}), ...(cap.notice ? { notice: cap.notice } : {}) });
  }

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

  /* The workspace's monthly cap on what is still to start, before the first of it starts: a press that would pass it starts nothing. What already started is
     in this month's spend at its hold. Each shot's reservation judges the cap again, so two presses at once cannot pass it together. */
  {
    const cap = await capVerdict(prepared.flatMap((p, i) => (states[i].state === "open" ? [{ p, holdUsd: holdUsd[i] }] : [])));
    if (cap.refusal) return admissionReply({ error: cap.refusal }, { status: 429 });
  }
  /* The balance against what is still to start, before the first of it starts (rule 14): never halfway through. What already started holds its own reservation. */
  const toStart = states.reduce((n, s, i) => n + (s.state === "open" ? holds[i] : 0), 0);
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
