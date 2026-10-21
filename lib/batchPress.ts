import { createHash } from "node:crypto";
import { creditsApply, creditState } from "./credits";
import { requireTenant } from "./tenant";
import { isHouseWorkspace } from "./houseWorkspace";
import { isPersonApprover, PLAN_APPROVAL_MS } from "./workbench/plan-approval";
import { isAgentId } from "./security/people-only";
import { billedTo } from "./providers";
import { paidByPlatform, vendorKeyNameFor } from "./platformSpend";
import { allowanceUsdOfStored, platformSpendThisMonth } from "./allowance";
import { houseCapOfStored, houseMonthStart, houseSpendSince } from "./houseCap";
import { verdictOf, type Quote } from "./quote";
import { prepareGeneration, admitGeneration } from "./generationAdmission";
import type { AdmissionActor, AdmissionExecution, AdmissionReply, PreparedAdmission } from "./admissionTypes";
import { admissionReply, assertAdmissionActor, preparedClaimFingerprint } from "./admissionSupport";
import { db, now } from "./db";
import { platformDb, platformReady } from "./platform";
import { STALE_CLAIM_MS, fenceGenerationRequest, generationFingerprint, generationRequestsReady, settleStaleClaim } from "./generationRequests";
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
 * re-quote of a partly started press without its key counts its started shots twice; quote it WITH the press's key instead (below). A workspace with no cap is not
 * judged here. A token, an MCP client or Atomik may ask the price, never press.
 *
 * The approval is the person's, once, for exactly the listed members at their listed prices: it carries the batch's fingerprint (a hash of every member's own quote
 * fingerprint and the total), so a member added, removed or re-priced is another batch that asks again. The balance is checked against what is still to start before the
 * first member of this press starts, never halfway through.
 *
 * THE PRESS IS READ BEFORE IT IS PRICED (owner, 21 Oct 2026, (a)-(c)). Under its key, a press's claims are read first. A shot that already started (or is still being
 * accepted) is reported as it stands and is NOT priced again: it stands at the hold it was admitted at, recorded beside its claim (`holdKey`), so the cap and every other
 * check a new take meets are not judged on it a second time (they were judged when it started, and its hold is in this month's spend). Only the shots still to start
 * (never started, or failed at no charge) are priced, with every check a single take meets, and only they are judged against the cap and the balance. A press asked
 * again near the cap therefore shows its running takes instead of a refusal, and still starts and bills nothing twice. A shot that started before its hold was recorded
 * is priced again as before.
 *
 * The approval the press was pressed with is recorded once, when it first starts something (`approvalKey`: its fingerprint, its total, when). Asked again under it,
 * the approval binds the TOTAL (owner, #811): the press's total now, its started shots at their holds and the shots left at today's price, may shift per shot and runs
 * while it stays at or under the approved total; a higher total asks again (409, `quoteChanged`, with the new total). Retry therefore costs only the shots left. An
 * approval is drawn on for as long as a plan's (PLAN_APPROVAL_MS, 7 days); past that, an ask that would start anything is answered as a moved price (409,
 * `quoteChanged` and `approvalExpired`, with the total at today's price) and never admitted on the old approval. The new approval the person gives is a new round of
 * the press, with a fingerprint of its own, so the expired one can never be sent again in its place.
 *
 * Quoted under its key, a press answers with its total as a new approval would cover it now, `toStart` (only the shots left: Retry's price), `pressed` (every shot
 * as it stands) and `approval` (the approval it holds: its total, when it expires, whether it still covers the shots left).
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
 * own claim about its press (lib/batchLine.ts) and would judge each member by the first one's price times the rest; each member here is judged on its own.
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

/**
 * What one member attempt was admitted at, recorded just before its claim: its hold (the most it can settle at), its estimate and, where the workspace's unit is
 * dollars, its price. Keyed by the attempt's claim AND the claim's own fingerprint (the prepared admission it was claimed with), so two asks racing on one attempt
 * each record their own figure and the claim that wins names which one is the take's. Never a request: it answers none.
 */
const holdKey = (attemptKey: string, claimFingerprint: string) => `${attemptKey}:hold:${hex(claimFingerprint, 24)}`;
const HOLD_FINGERPRINT = "batch-press-hold-v1";
/** One approval of the press, recorded when it first starts something under it: round 0 is the approval it was first pressed with, each new approval the next. */
export const approvalKey = (pressKey: string, round: number) => `${pressPrefix(pressKey)}approval:${round}`;
const APPROVAL_FINGERPRINT = "batch-press-approval-v1";
/** How long a press's approval may be drawn on: as long as a plan's (owner, 21 Oct 2026, (c): "held approvals expire as plans do (7 days)"). */
export const PRESS_APPROVAL_MS = PLAN_APPROVAL_MS;

type Attempt = { key: string; shots: string; index: number; attempt: number; jobId: string | null; pending: boolean; fingerprint: string };
type Held = { hold: number; estimated: number; price: number | null };
type Approval = { round: number; fingerprint: string; maxCredits: number; at: number };
type Claims = {
  attempts: Attempt[]; cancelled: boolean; recorded: { shots: string; members: number } | null;
  /** Each attempt's recorded figure, by `<attempt key>|<its claim's fingerprint>`. */
  holds: Map<string, Held>;
  /** The latest approval the press was pressed with, or null before it started anything under one. */
  approval: Approval | null;
};
const heldOf = (holds: Map<string, Held>, claim: { key: string; fingerprint: string }) => holds.get(`${claim.key}|${hex(claim.fingerprint, 24)}`) ?? null;
const figure = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The press's claims as the database has them now (the person's own, in the workspace's own database): every member attempt, whether the press was cancelled, its shots as
 * it recorded them (null before it pressed), what each attempt was admitted at, and the approval it holds. */
async function pressClaims(userId: string, pressKey: string): Promise<Claims> {
  await generationRequestsReady();
  const prefix = pressPrefix(pressKey);
  const rows = (await db().execute({
    sql: `SELECT request_key,fingerprint,generation_id,response_json,created_at FROM generation_requests WHERE user_id=? AND request_key>=? AND request_key<?`,
    args: [userId, prefix, `${prefix}~`],
  })).rows;
  const attempts: Attempt[] = [];
  const holds = new Map<string, Held>();
  let cancelled = false;
  let recorded: { shots: string; members: number } | null = null;
  let approval: Approval | null = null;
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
    /* Only this module writes these two kinds, under fingerprints no request is ever claimed with: anything else under their names is not read as one. */
    const h = /^([a-f0-9]{24}:\d{1,2}:\d{1,4}):hold:([a-f0-9]{24})$/.exec(rest);
    if (h) {
      const v = reply as { code?: unknown; hold?: unknown; estimated?: unknown; price?: unknown };
      if (String(row.fingerprint) === HOLD_FINGERPRINT && v.code === "press-hold" && figure(v.hold) && figure(v.estimated))
        holds.set(`${prefix}${h[1]}|${h[2]}`, { hold: v.hold as number, estimated: v.estimated as number, price: figure(v.price) ? (v.price as number) : null });
      continue;
    }
    const a = /^approval:(\d{1,4})$/.exec(rest);
    if (a) {
      const v = reply as { code?: unknown; round?: unknown; fingerprint?: unknown; maxCredits?: unknown };
      const round = Number(a[1]);
      if (String(row.fingerprint) === APPROVAL_FINGERPRINT && v.code === "press-approval" && v.round === round && typeof v.fingerprint === "string" && /^[a-f0-9]{64}$/.test(v.fingerprint)
        && Number.isInteger(v.maxCredits) && (v.maxCredits as number) >= 0 && (!approval || round > approval.round))
        approval = { round, fingerprint: v.fingerprint, maxCredits: v.maxCredits as number, at: Number(row.created_at) };
      continue;
    }
    const m = /^([a-f0-9]{24}):(\d{1,2}):(\d{1,4})$/.exec(rest);
    if (!m) continue;
    const jobId = row.generation_id != null ? String(row.generation_id) : typeof reply.id === "string" && reply.id ? reply.id : null;
    attempts.push({ key: String(row.request_key), shots: m[1], index: Number(m[2]), attempt: Number(m[3]), jobId, pending: !row.response_json && row.generation_id == null, fingerprint: String(row.fingerprint) });
  }
  return { attempts, cancelled, recorded, holds, approval };
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

/** A started or starting member names the claim it started under, so its recorded hold is read for that claim (heldOf). */
type MemberState = { state: "landed"; id: string; claim: { key: string; fingerprint: string } } | { state: "pending"; claim: { key: string; fingerprint: string } } | { state: "open"; next: number };
/**
 * Where one member of the press stands, from its own attempts. A claim that names a take is that take, unless the take failed at no charge (failedFree). One still
 * being accepted is starting, unless no request can still be running it: then it is settled (no take, nothing charged) and the member is open again. Otherwise every
 * attempt was refused or failed free, and the next attempt is open. `settle: false` (a quote) writes nothing: a claim past STALE_CLAIM_MS is read as the settle would
 * leave it, and the press that asks next settles it.
 */
async function memberState(userId: string, attempts: Attempt[], settle = true): Promise<MemberState> {
  for (const a of attempts.filter((x) => x.jobId)) if (!(await failedFree(a.jobId!))) return { state: "landed", id: a.jobId!, claim: a };
  for (const a of attempts.filter((x) => x.pending)) {
    if (settle ? await settleStaleClaim(userId, a.key) : await staleClaim(userId, a.key)) continue;
    /* Not settled: still being accepted, or it bound a take or got its answer a moment ago. Read it once more. */
    const row = (await db().execute({ sql: "SELECT generation_id,response_json FROM generation_requests WHERE user_id=? AND request_key=?", args: [userId, a.key] })).rows[0];
    if (row?.generation_id != null && !(await failedFree(String(row.generation_id)))) return { state: "landed", id: String(row.generation_id), claim: a };
    if (row?.generation_id == null && !row?.response_json) return { state: "pending", claim: a };
  }
  return { state: "open", next: attempts.reduce((n, a) => Math.max(n, a.attempt + 1), 0) };
}
/** settleStaleClaim's own test, read only: a claim naming no take and no reply, made longer ago than any request can run. */
async function staleClaim(userId: string, key: string): Promise<boolean> {
  const row = (await db().execute({ sql: `SELECT created_at FROM generation_requests WHERE user_id=? AND request_key=? AND generation_id IS NULL AND response_json IS NULL`, args: [userId, key] })).rows[0];
  return Boolean(row) && Number(row.created_at) < now() - STALE_CLAIM_MS;
}
async function takeStatuses(ids: string[]): Promise<Map<string, { status: string; provider: string; kind: string }>> {
  if (!ids.length) return new Map();
  const rows = (await db().execute({ sql: `SELECT id,status,provider,kind FROM generations WHERE id IN (${ids.map(() => "?").join(",")})`, args: ids })).rows;
  return new Map(rows.map((r) => [String(r.id), { status: String(r.status), provider: String(r.provider ?? ""), kind: String(r.kind ?? "") }]));
}

type MemberOut = { index: number; id?: string; status?: string; error?: string; code?: number; charged?: 0 };
const MOVED = "The shots or their prices changed. Look at the total again before approving.";
const ABOVE = "The total is now above the approved total. Look at it again before approving.";
const EXPIRED = "This approval has expired. Look at the total again before approving.";
const UNAPPROVED = "Approve the price first: the total is above the approved credit amount.";

/**
 * One member as the press judges it: a shot still to start (`open`), priced now with every check a take meets; or one that started (or is starting), at what it was
 * admitted at (its recorded hold, never priced again), or, when no hold was recorded for it, priced again as before.
 */
type Part = { open: boolean; p: PreparedAdmission | null; holdUsd: number; hold: number; estimated: number; price: number | null };
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const batchIdOf = (fingerprint: string) => `bt_${fingerprint.slice(0, 24)}`;

export async function admitBatch(input: Record<string, unknown>, got: AdmissionActor, options: BatchExecution): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  if (options.checkpoint) return admissionReply({ error: "A batch is several jobs under one approval: it is quoted here and approved by a person." }, { status: 400 });
  const quoteOnly = input.quoteOnly === true;
  const members = input.members;
  if (!Array.isArray(members) || !members.length) return admissionReply({ error: "Add the shots to make." }, { status: 400 });
  if (members.length > BATCH_MAX_MEMBERS) return admissionReply({ error: `A press takes up to ${BATCH_MAX_MEMBERS} shots at a time.` }, { status: 400 });
  /* ── Only a person presses: asked before the press is read or priced ── */
  if (!quoteOnly && (!isPersonApprover(got.user.id) || isAgentId(got.user.id) || got.token != null || options.run?.auto === true)) return admissionReply({ error: PEOPLE_ONLY }, { status: 403 });
  const shotsAsSent: Record<string, unknown>[] = [];
  for (const [i, raw] of members.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return admissionReply({ error: `Shot ${i + 1} is not valid.` }, { status: 400 });
    const { maxCredits: _a, quoteFingerprint: _b, batchId: _c, batchSize: _d, ...member } = raw as Record<string, unknown>;
    void _a; void _b; void _c; void _d;
    shotsAsSent.push(member);
  }
  const userId = got.user.id;
  const pressKey = options.pressKey;
  const shots = pressShots(shotsAsSent);

  /* ── The press as it stands, read BEFORE anything is priced: started, starting, or still to start ── */
  let states: MemberState[] = shotsAsSent.map((): MemberState => ({ state: "open", next: 0 }));
  let claims: Claims | null = null;
  if (pressKey) {
    claims = await pressClaims(userId, pressKey);
    if (claims.attempts.some((a) => a.shots !== shots) || (claims.recorded && claims.recorded.shots !== shots)) return admissionReply({ error: OTHER_PRESS }, { status: 409 });
    states = [];
    /* A quote writes nothing: a claim left by a killed press is read as settled, and settled by the next press. */
    for (let index = 0; index < shotsAsSent.length; index++) states.push(await memberState(userId, claims.attempts.filter((a) => a.index === index), !quoteOnly));
  }
  const held = claims?.approval ?? null;
  const statuses = await takeStatuses(states.flatMap((s) => (s.state === "landed" ? [s.id] : [])));
  const reported = (index: number, s: MemberState, cancelled: boolean): MemberOut =>
    s.state === "landed" ? { index, id: s.id, status: statuses.get(s.id)?.status ?? "queued" }
      : s.state === "pending" ? { index, status: "starting" }
        : cancelled ? { index, status: "cancelled", charged: 0 } : { index };
  /* A press that already started something is shown as it stands beside any refusal (`members` on a press, `pressed` on a quote): the running press is never hidden. */
  const standing = (): Record<string, MemberOut[]> =>
    pressKey && states.some((s) => s.state !== "open") ? { [quoteOnly ? "pressed" : "members"]: states.map((s, i) => reported(i, s, false)) } : {};
  if (claims?.cancelled)
    return admissionReply({ error: CANCELLED, cancelled: true, ...(held ? { id: batchIdOf(held.fingerprint), batchId: batchIdOf(held.fingerprint) } : {}), members: states.map((s, i) => reported(i, s, true)) }, { status: 409 });

  /* ── The server prices every shot still to start itself, with every check a single take meets there. A shot that started stands at its recorded hold. ── */
  const parts: Part[] = [];
  for (const [i, member] of shotsAsSent.entries()) {
    const s = states[i];
    const was = s.state !== "open" && held && claims ? heldOf(claims.holds, s.claim) : null;
    if (was) { parts.push({ open: false, p: null, holdUsd: 0, hold: was.hold, estimated: was.estimated, price: was.price }); continue; }
    /* Each shot's engine dollars at its hold, for the monthly cap only (server-only, never in a reply). */
    const cost: { holdUsd?: number } = {};
    const p = await prepareGeneration(member, got, cost);
    /* The shot is named beside the refusal, never inside it: a cap's or a limit's words stay exactly the door's own, with no figure in them. */
    if (!p.ok) return admissionReply({ ...p.body, error: typeof p.body.error === "string" ? p.body.error : "This shot can't be priced.", shot: i + 1, ...standing() }, { status: p.status });
    if (!Number.isFinite(cost.holdUsd) || cost.holdUsd! < 0) return admissionReply({ error: "This shot can't be priced.", shot: i + 1, ...standing() }, { status: 400 });
    parts.push({ open: s.state === "open", p: p.value, holdUsd: cost.holdUsd!, hold: holdCredits(p.value), estimated: p.value.quote.estimatedCredits, price: p.value.quote.price });
  }
  const unit = creditsApply(requireTenant()) ? "cr" : "usd";
  const sum = (xs: Part[], f: (x: Part) => number) => xs.reduce((n, x) => n + f(x), 0);
  const priceOf = (estimated: number, usd: number) => (unit === "cr" ? estimated : Math.round(usd * 1e6) / 1e6);
  const left = parts.filter((x) => x.open);
  /* The whole press: what an approval covers. Its started shots at their holds, the shots left at today's price. */
  const credits = sum(parts, (x) => x.hold);
  const estimatedCredits = sum(parts, (x) => x.estimated);
  /* The approval of these shots at these prices. Before the press holds an approval, every shot is priced and this is the fingerprint it always was; after, it is
     the press's next round, so an approval that ran out can never be sent again in its place. */
  const fingerprint = held
    ? sha({ v: 2, press: pressPrefix(pressKey!), round: held.round + 1, members: parts.map((x) => (x.open ? x.p!.quote.fingerprint : `held:${x.hold}`)), credits })
    : sha({ v: 1, members: parts.map((x) => x.p!.quote.fingerprint), credits });
  const whole = { estimatedCredits, price: priceOf(estimatedCredits, sum(parts, (x) => x.price ?? 0)), unit, members: parts.length, batchId: batchIdOf(fingerprint), fingerprint, ...(credits > estimatedCredits ? { ceilingCredits: credits } : {}) };
  /* Only the shots still to start (never started, or failed at no charge): Retry's price. */
  const figureOf = (xs: Part[]) => {
    const hold = sum(xs, (x) => x.hold);
    const estimated = sum(xs, (x) => x.estimated);
    return { members: xs.length, estimatedCredits: estimated, price: priceOf(estimated, sum(xs, (x) => x.price ?? 0)), unit, ...(hold > estimated ? { ceilingCredits: hold } : {}) };
  };
  const at = now();
  const expired = held != null && at >= held.at + PRESS_APPROVAL_MS;
  /* The approval the press holds: its total, when it stops being drawn on, and whether it still covers the shots left. */
  const holding = held ? { maxCredits: held.maxCredits, expiresAt: held.at + PRESS_APPROVAL_MS, expired, covers: !left.length || (!expired && credits <= held.maxCredits) } : null;
  const keyed = pressKey ? { toStart: figureOf(left), approval: holding } : {};

  if (quoteOnly) {
    /* ── The workspace's monthly cap on what is still to start, before anyone can press it ── */
    const cap = await capVerdict(left.map((x) => ({ p: x.p!, holdUsd: x.holdUsd })));
    if (cap.refusal) return admissionReply({ error: cap.refusal, ...standing() }, { status: 429 });
    return admissionReply({ ...whole, ...(cap.notice ? { notice: cap.notice } : {}), ...(pressKey ? { ...keyed, pressed: states.map((s, i) => reported(i, s, false)) } : {}) });
  }

  /* ── The approval: one person, for exactly these shots. Pressed the first time (or approved again at the current total), it is this press's fingerprint at
     this total. Asked again under the approval the press holds, it binds the TOTAL: per-shot shifts at or under it run; above it, or past its time, it asks again. ── */
  const asked = (error: string, extra: Record<string, unknown> = {}) =>
    admissionReply({ error, quoteChanged: true, ...extra, quote: { ...whole, ...keyed }, ...standing() }, { status: 409 });
  const incoming = typeof input.fingerprint === "string" ? input.fingerprint : null;
  const ceiling = Number.isInteger(input.maxCredits) && (input.maxCredits as number) >= 0 ? (input.maxCredits as number) : null;
  let fresh: boolean;
  if (incoming != null && incoming === fingerprint) {
    if (ceiling == null || credits > ceiling) return admissionReply({ error: UNAPPROVED }, { status: 409 });
    fresh = true;
  } else if (held && incoming === held.fingerprint) {
    /* Past its time, an approval starts nothing more: asked again at today's price. A press with nothing left to start is only shown. */
    if (left.length && expired) return asked(EXPIRED, { approvalExpired: true });
    if (credits > held.maxCredits) return asked(ABOVE);
    if (ceiling == null || credits > ceiling) return admissionReply({ error: UNAPPROVED }, { status: 409 });
    fresh = false;
  } else return asked(MOVED);
  if (!pressKey) return admissionReply({ error: NEEDS_KEY }, { status: 400 });
  const batchId = batchIdOf(fresh ? fingerprint : held!.fingerprint);

  /* The workspace's monthly cap on what is still to start, before the first of it starts: a press that would pass it starts nothing. What already started is
     in this month's spend at its hold, and is not judged again. Each shot's reservation judges the cap again, so two presses at once cannot pass it together. */
  {
    const cap = await capVerdict(left.map((x) => ({ p: x.p!, holdUsd: x.holdUsd })));
    if (cap.refusal) return admissionReply({ error: cap.refusal, ...standing() }, { status: 429 });
  }
  /* The balance against what is still to start, before the first of it starts (rule 14): never halfway through. What already started holds its own reservation. */
  const toStart = sum(left, (x) => x.hold);
  const state = unit === "cr" && toStart > 0 ? await creditState() : null;
  if (state && state.balance < toStart)
    return admissionReply({ error: `Short by ${Math.ceil((toStart - state.balance) * 10) / 10} cr. Top up, then approve. Nothing is spent until you do.`, short: true, ...standing() }, { status: 402 });

  /* ── Each member still to start, at its own quote, under its own claim ── */
  /* Its shots recorded first, so a cancel from here on lists every one of them, even a shot whose claim it lands before. */
  await db().execute({
    sql: `INSERT OR IGNORE INTO generation_requests(user_id,request_key,fingerprint,response_json,response_status,created_at,updated_at) VALUES(?,?,?,?,409,?,?)`,
    args: [userId, membersKey(pressKey), membersFingerprint(shots), JSON.stringify({ error: OTHER_PRESS, code: "press", members: parts.length }), now(), now()],
  });
  /* A new approval is recorded once, when it first starts something: its fingerprint, its total and, in the row's own time, when it was given. */
  const round = held ? held.round + 1 : 0;
  if (fresh && left.length)
    await db().execute({
      sql: `INSERT OR IGNORE INTO generation_requests(user_id,request_key,fingerprint,response_json,response_status,created_at,updated_at) VALUES(?,?,?,?,409,?,?)`,
      args: [userId, approvalKey(pressKey, round), APPROVAL_FINGERPRINT, JSON.stringify({ error: OTHER_PRESS, code: "press-approval", round, fingerprint, maxCredits: credits }), at, at],
    });
  const out: MemberOut[] = [];
  let stopped = false;
  for (const [index, x] of parts.entries()) {
    const s = states[index];
    if (s.state !== "open") { out.push(reported(index, s, false)); continue; }
    /* A cancel that arrived while this press was running: nothing more starts. */
    stopped ||= (await pressClaims(userId, pressKey)).cancelled;
    if (stopped) { out.push({ index, status: "cancelled", charged: 0 }); continue; }
    const requestKey = memberKey(pressKey, shots, index, s.next);
    /* What this attempt is admitted at, recorded before its claim and under the claim's own fingerprint: asked again, the shot stands at it and is not priced again. */
    await db().execute({
      sql: `INSERT OR IGNORE INTO generation_requests(user_id,request_key,fingerprint,response_json,response_status,created_at,updated_at) VALUES(?,?,?,?,409,?,?)`,
      args: [userId, holdKey(requestKey, preparedClaimFingerprint(x.p!, "generation")), HOLD_FINGERPRINT,
        JSON.stringify({ error: OTHER_PRESS, code: "press-hold", hold: x.hold, estimated: x.estimated, ...(unit === "usd" ? { price: x.price } : {}) }), now(), now()],
    });
    /* The cancel is checked again in the claim's own write (fencedBy): one that lands after the check above still stops this shot, before anything is reserved or sent. */
    const reply = await admitGeneration(x.p!, got, { requestKey, defer: options.defer, fencedBy: cancelKey(pressKey), ...(options.run ? { run: options.run } : {}) });
    if (reply.body.code === "set_aside" && typeof reply.body.id !== "string" && (await pressClaims(userId, pressKey)).cancelled) { stopped = true; out.push({ index, status: "cancelled", charged: 0 }); }
    else if ((reply.status === 200 || reply.status === 202) && typeof reply.body.id === "string") out.push({ index, id: reply.body.id, status: typeof reply.body.status === "string" ? reply.body.status : "queued" });
    else if (reply.status === 409 && reply.body.pending === true) out.push({ index, status: "starting" });
    else out.push({ index, error: typeof reply.body.error === "string" ? reply.body.error : "It did not start.", code: reply.status, charged: 0 });
  }
  const refused = out.filter((m) => m.error);
  const started = out.filter((m) => m.id || m.status === "starting").length;
  const status = stopped ? "cancelled" : refused.length ? (started ? "partial" : "refused") : "started";
  /* The approval this press ran under, and, when shots did not start, what Retry under it costs: only those shots. */
  const approval = fresh && left.length ? { maxCredits: credits, expiresAt: at + PRESS_APPROVAL_MS } : held ? { maxCredits: held.maxCredits, expiresAt: held.at + PRESS_APPROVAL_MS } : null;
  return admissionReply(
    { id: batchId, batchId, status, estimatedCredits, members: out, approval, ...(refused.length ? { retry: RETRY, toStart: figureOf(refused.map((m) => parts[m.index])) } : {}) },
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
