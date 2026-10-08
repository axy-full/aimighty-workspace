import { failedChip } from "../errors";
import { studioRequest, StudioRequestError } from "@/components/workbench/GenerationDialog";
import {
  CONNECTED_GENERATION_ENDPOINT,
  connectedBatchCheckRequest,
  connectedBatchQuoteRequest,
  connectedBatchSubmitRequest,
  connectedBatchTotal,
  parseConnectedJob,
  type ConnectedJob,
} from "../higgsfield-consumer/generation-client";
import type { ConsumerGenerationInput } from "../higgsfield-consumer/generation-contract";
import { readPendingGeneration, tabStorage } from "../workbench/pending-generation";
import { formatCredits } from "./cost";
import { dispatchGeneration, quoteDispatch, settlePendingGeneration, type DispatchRequest, type QuotedDispatch } from "./generate-submit";
import { generationPhase, neutralCopy } from "./rig";
import type { MediaJob } from "../workbench/job-recovery";
import { POOL_LABEL, POOL_MARK } from "../sharedKeyTerms";

/**
 * Takes 2–4 of one Generate, as ONE priced batch (idea 3).
 *
 * Money, the whole contract:
 *  - The button shows the batch's total. On Generate every take is quoted
 *    fresh, exactly as it will be sent, before any take is sent; the sum must
 *    equal the total on the button. If it does not, nothing is sent: the new
 *    total goes on the button for a second, deliberate Generate. A batch is
 *    never left half sent because a price moved.
 *  - The connected account: N quoted jobs, then ONE approval of their exact
 *    sum and ONE paid batch call (the route's `submit-batch`, through
 *    submitConsumerGenerationBatchJobs). Its credits are the account's own
 *    currency, never converted at this workspace's rate. A lost reply is
 *    checked, never replayed: the server fences a batch that never arrived
 *    (`check-batch`), so the answer is final and nothing is paid twice.
 *  - This workspace's credits: every take carries the same batch id and its
 *    take number. Takes are sent in order, each at the ceiling it was quoted
 *    at. If admission refuses take k (a cap, a limit), takes k+1… are not
 *    sent, and the person is told exactly which takes were made and charged
 *    and which were not; a refused take is never billed. When the credits run
 *    out, admission holds a take instead: it is said so, and it is not
 *    charged until it runs (topping up releases it at the same ceiling).
 *  - Every take that is sent is followed until it settles (the composer), and
 *    a take that fails is not billed (the engines' own settlement).
 */

export type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

/** What became of one take of a batch, as the person is told. */
export type BatchTakeState =
  /** Sent and accepted: `jobId` is followed until it settles. */
  | "queued"
  /** Admitted but held (this workspace ran out of credits, or every slot is busy): not charged until it runs. */
  | "held"
  /** Its reply never came back: checked before anything else is sent, never sent again. */
  | "unconfirmed"
  /** Refused before anything was made: not charged. */
  | "refused"
  /** Never sent: an earlier take stopped the batch. */
  | "not-sent";

export type BatchTake = { variation: number; state: BatchTakeState; jobId: string | null; credits: number; reason?: string };

/** The one gate: the sum of every take's fresh quote is exactly the total the person approved on the button. */
export function batchGate(shown: number | null, fresh: readonly number[]): { ok: true; total: number } | { ok: false; total: number } {
  const total = fresh.reduce((sum, c) => sum + c, 0);
  return shown !== null && total === shown ? { ok: true, total } : { ok: false, total };
}

/** "takes 1–2", "take 3", "takes 1, 3" — the takes a sentence is about. */
export function takesPhrase(variations: readonly number[]): string {
  const list = [...variations].sort((a, b) => a - b);
  if (list.length === 1) return `take ${list[0]}`;
  const run = list.every((v, i) => i === 0 || v === list[i - 1] + 1);
  return run ? `takes ${list[0]}–${list[list.length - 1]}` : `takes ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * One line that says exactly what the batch did: which takes were sent (and
 * what they were approved at), which were refused or never sent (and that
 * nothing was charged for them), and which are still being checked.
 */
export function batchNotice(takes: readonly BatchTake[], unit: "cr" | "connected cr"): string {
  const money = (n: number) => (unit === "cr" ? formatCredits(n) : `${n.toLocaleString("en-US")} connected cr`);
  const sent = takes.filter((t) => t.state === "queued");
  const held = takes.filter((t) => t.state === "held");
  const unsure = takes.filter((t) => t.state === "unconfirmed");
  const refused = takes.filter((t) => t.state === "refused");
  const unsent = takes.filter((t) => t.state === "not-sent");
  if (sent.length === takes.length)
    return `${takes.length} takes sent at ${money(sent.reduce((s, t) => s + t.credits, 0))}. They file into Takes as one strip as they land.`;
  const parts: string[] = [];
  if (sent.length) parts.push(`${upper(takesPhrase(sent.map((t) => t.variation)))} ${sent.length === 1 ? "was" : "were"} sent at ${money(sent.reduce((s, t) => s + t.credits, 0))}.`);
  if (held.length) parts.push(`${upper(takesPhrase(held.map((t) => t.variation)))} ${held.length === 1 ? "is" : "are"} held, not charged until ${held.length === 1 ? "it runs" : "they run"}: top up to release ${held.length === 1 ? "it" : "them"} at the same price.`);
  if (unsure.length) parts.push(`${upper(takesPhrase(unsure.map((t) => t.variation)))}: the reply never came back. It is checked before anything else is sent, and never sent twice.`);
  const stopped = [...refused, ...unsent];
  if (stopped.length) {
    const why = refused.find((t) => t.reason)?.reason;
    parts.push(`${upper(takesPhrase(stopped.map((t) => t.variation)))} ${stopped.length === 1 ? "was" : "were"} not made${why ? ` (${why.replace(/[.\s]+$/, "")})` : ""}. Nothing was charged for ${stopped.length === 1 ? "it" : "them"}.`);
  }
  return parts.join(" ");
}

/* ── This workspace's credits ─────────────────────────────────────────── */

export type WorkspaceBatchOutcome =
  /** The fresh total is not the total on the button: nothing was sent. */
  | { state: "repriced"; total: number; takes: number[]; reason: string }
  /** Refused before any take was sent (a quote could not be had): nothing was sent. */
  | { state: "refused"; reason: string }
  /** Sent, take by take, as far as it went: each take's own state. */
  | { state: "sent"; takes: BatchTake[] };

/**
 * Quote every take's exact request, gate their sum against the total on the
 * button, then send the takes in order through the shared dispatch, each with
 * the ceiling it was quoted at (never priced again on the way). A refusal or
 * an unanswered take stops the batch there; the takes after it are not sent.
 */
export async function sendWorkspaceBatch(options: {
  scope: string;
  /** The total on the button: what the person approved. */
  shown: number | null;
  count: number;
  /** Take `variation` (1-based), exactly as it will be sent: the same batch id on each, its own take number. */
  request: (variation: number) => DispatchRequest;
  /** Take `variation`'s recovery key (pendingGenerationKey). */
  storageId: (variation: number) => string;
  onTake?: (take: BatchTake) => void;
  storage?: Storage;
}): Promise<WorkspaceBatchOutcome> {
  const { scope, count } = options;
  const quotes: QuotedDispatch[] = [];
  try {
    for (let v = 1; v <= count; v++) quotes.push(await quoteDispatch(scope, options.request(v)));
  } catch (error) {
    return { state: "refused", reason: neutralCopy(error instanceof Error ? error.message : "The live price could not be confirmed. Nothing was submitted.") };
  }
  const gate = batchGate(options.shown, quotes.map((q) => q.credits));
  if (!gate.ok)
    return { state: "repriced", total: gate.total, takes: quotes.map((q) => q.credits),
      reason: `The price is now ${formatCredits(gate.total)} for ${count} takes. Nothing was sent; press Generate again to approve it.` };
  const storage = options.storage ?? window.localStorage;
  const takes: BatchTake[] = [];
  let stop = false;
  for (let v = 1; v <= count; v++) {
    const credits = quotes[v - 1].credits;
    if (stop) { takes.push({ variation: v, state: "not-sent", jobId: null, credits }); continue; }
    const outcome = await dispatchGeneration({ scope, storageId: options.storageId(v), shown: credits, request: options.request(v), quoted: quotes[v - 1], storage });
    let take: BatchTake;
    if (outcome.state === "queued") take = { variation: v, state: outcome.status === "held" ? "held" : "queued", jobId: outcome.jobId, credits: outcome.credits };
    else {
      /* The dispatch keeps its claim only when it does not know what became of the request (a lost reply). */
      const kept = readKept(storage, options.storageId(v));
      take = { variation: v, state: kept ? "unconfirmed" : "refused", jobId: null, credits, reason: outcome.reason };
      stop = true;
    }
    takes.push(take);
    options.onTake?.(take);
  }
  return { state: "sent", takes };
}

function readKept(storage: Storage, storageId: string): boolean {
  try { return readPendingGeneration(storage, storageId) !== null; } catch { return true; }
}

/** An earlier workspace batch take whose reply was lost, asked about before anything else is sent. */
export type SettledTake =
  | { state: "landed"; jobId: string; credits: number }
  /** It made nothing, and nothing was charged for it. */
  | { state: "lost" }
  /** Still not known: nothing new is sent. */
  | { state: "unknown"; reason: string };

/**
 * An unconfirmed take's claimed request, asked about by its own key, route and
 * body (settlePendingGeneration, POST /api/generate/check): landed, its job is
 * followed; never arrived, the server fences the key so it can never land, and
 * nothing was charged; not known yet, the claim stays. It is never sent again.
 */
export async function settleWorkspaceTake(options: { scope: string; storageId: string; storage?: Storage }): Promise<SettledTake> {
  const settled = await settlePendingGeneration({ scope: options.scope, storageId: options.storageId, storage: options.storage });
  if (settled.state === "landed") return { state: "landed", jobId: settled.jobId, credits: settled.credits };
  if (settled.state === "unknown") return { state: "unknown", reason: settled.reason };
  return { state: "lost" };
}

/* ── The connected account ────────────────────────────────────────────── */

export type ConnectedBatchOutcome =
  | { state: "repriced"; total: number; takes: number[]; reason: string }
  /** Refused before anything was sent or charged. */
  | { state: "refused"; reason: string }
  /** The account's admission took the batch: every take is followed (a take it refused is failed, unbilled). */
  | { state: "sent"; jobs: ConnectedJob[]; note?: string }
  /** The reply was lost and could not be checked yet: nothing new is sent until it is. */
  | { state: "unknown"; reason: string };

type PendingBatch = { draftId: string; batchId: string; ids: string[]; workspaceId: string; credits: number; at: number };
const PENDING_PREFIX = "particl:connected-batch:v1:";
const pendingKey = (scope: string, draftId: string) => `${PENDING_PREFIX}${JSON.stringify([scope, draftId])}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A batch sent but not yet answered, remembered before it is sent. Unreadable storage is never a reason to send more. */
export function readPendingBatch(storage: Storage, scope: string, draftId: string): PendingBatch | null {
  const raw = storage.getItem(pendingKey(scope, draftId));
  if (!raw) return null;
  const value = JSON.parse(raw) as PendingBatch;
  if (!value || value.draftId !== draftId || typeof value.batchId !== "string" || !Array.isArray(value.ids) || value.ids.length < 2 || value.ids.length > 4 ||
      !value.ids.every((id) => typeof id === "string" && UUID.test(id)) || typeof value.workspaceId !== "string" || !Number.isFinite(value.credits) || typeof value.at !== "number")
    throw new Error("The saved batch cannot be read. Check Takes before starting another.");
  return value;
}
function claimPendingBatch(storage: Storage, scope: string, value: PendingBatch) {
  const key = pendingKey(scope, value.draftId);
  if (storage.getItem(key)) throw new Error("Another batch on this project is still waiting for its answer. Nothing new was sent.");
  const raw = JSON.stringify(value);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("Enable local storage to send a batch safely. Nothing was sent.");
}
function clearPendingBatch(storage: Storage, scope: string, draftId: string, batchId: string) {
  try {
    const saved = readPendingBatch(storage, scope, draftId);
    if (saved?.batchId === batchId) storage.removeItem(pendingKey(scope, draftId));
  } catch { /* unreadable: left for the person to see */ }
}

const headers = (scope: string) => ({ "Content-Type": "application/json", "X-Workbench-Scope": scope });

/** What a connected batch that was checked after a lost reply became. */
export type SettledBatch =
  | { state: "none" }
  | { state: "landed"; jobs: ConnectedJob[] }
  | { state: "lost" }
  | { state: "unknown"; reason: string };

const UNCHECKED_BATCH = "Your last batch could not be checked yet, so nothing new was sent. Try again in a moment.";

/** Ask the server what became of these takes; one that never arrived is fenced there in the same step. */
async function checkBatch(scope: string, draftId: string, ids: readonly string[]): Promise<Exclude<SettledBatch, { state: "none" }>> {
  try {
    const found = await studioRequest<{ state?: unknown; jobs?: unknown[] }>(CONNECTED_GENERATION_ENDPOINT, {
      method: "POST", headers: headers(scope), body: JSON.stringify(connectedBatchCheckRequest(draftId, ids)),
    });
    if (found.state === "landed") return { state: "landed", jobs: (found.jobs ?? []).map((job) => parseConnectedJob(job, draftId)) };
    return found.state === "absent" ? { state: "lost" } : { state: "unknown", reason: UNCHECKED_BATCH };
  } catch (error) {
    /* The takes are not this project's any more (deleted with it): there is nothing to follow or to fence. */
    if (error instanceof StudioRequestError && error.status === 404) return { state: "lost" };
    return { state: "unknown", reason: UNCHECKED_BATCH };
  }
}

/**
 * Check, then fence: before anything else is sent for this project, a batch
 * whose reply was lost is asked about by its takes' ids. Landed: its takes are
 * followed and nothing is sent again. Never arrived: the server has fenced it,
 * so it never can, and nothing was charged. Not known (the question got no
 * answer): the record stays and nothing new is sent.
 */
export async function settleConnectedBatch(options: { scope: string; draftId: string; storage?: Storage }): Promise<SettledBatch> {
  const storage = options.storage ?? window.localStorage;
  let pending: PendingBatch | null;
  try { pending = readPendingBatch(storage, options.scope, options.draftId); } catch (error) {
    return { state: "unknown", reason: error instanceof Error ? error.message : "The saved batch cannot be read." };
  }
  if (!pending) return { state: "none" };
  const checked = await checkBatch(options.scope, pending.draftId, pending.ids);
  if (checked.state !== "unknown") clearPendingBatch(storage, options.scope, pending.draftId, pending.batchId);
  return checked;
}

/**
 * Quote every take fresh, gate the exact sum against the total on the button,
 * remember the batch, then ONE submit for all of it. A lost reply is checked
 * (and fenced) at once; it is never sent again.
 */
export async function sendConnectedBatch(options: {
  scope: string;
  draftId: string;
  input: ConsumerGenerationInput;
  count: number;
  /** The total on the button, in the account's credits. */
  shown: number | null;
  batchId: string;
  composer?: "gen";
  /** Every fresh quote, the moment it is known (the composer holds the figure for the button). */
  onQuoted?: (jobs: ConnectedJob[]) => void;
  storage?: Storage;
  now?: () => number;
}): Promise<ConnectedBatchOutcome> {
  const { scope, draftId, count, batchId } = options;
  const storage = options.storage ?? window.localStorage;
  const now = options.now ?? Date.now;
  let jobs: ConnectedJob[];
  try {
    const quoted = await studioRequest<{ jobs?: unknown[] }>(CONNECTED_GENERATION_ENDPOINT, {
      method: "POST", headers: headers(scope),
      body: JSON.stringify(connectedBatchQuoteRequest(draftId, options.input, count, batchId, options.composer ? { composer: options.composer } : {})),
    });
    jobs = (quoted.jobs ?? []).map((job) => parseConnectedJob(job, draftId));
  } catch (error) {
    return { state: "refused", reason: neutralCopy(error instanceof Error ? error.message : "The batch could not be priced. Nothing was sent.", "The batch could not be priced. Nothing was sent.") };
  }
  /* Exactly the takes asked for, in take order, one wallet, all still quoted: anything else is never sent. */
  if (jobs.length !== count || jobs.some((job, i) => job.status !== "quoted" || job.batch?.id !== batchId || job.batch.variation !== i + 1 || job.workspaceId !== jobs[0].workspaceId))
    return { state: "refused", reason: "The batch's quotes did not match what was asked. Nothing was sent." };
  options.onQuoted?.(jobs);
  const gate = batchGate(options.shown, jobs.map((job) => job.quoteCredits));
  if (!gate.ok)
    return { state: "repriced", total: gate.total, takes: jobs.map((job) => job.quoteCredits),
      reason: `The price is now ${gate.total.toLocaleString("en-US")} connected cr for ${count} takes. Nothing was sent; press Generate again to approve it.` };
  if (jobs.some((job) => job.quoteExpiresAt <= now())) return { state: "refused", reason: "That price expired. Press Generate again for a fresh one." };
  const pending: PendingBatch = { draftId, batchId, ids: jobs.map((job) => job.id), workspaceId: jobs[0].workspaceId, credits: connectedBatchTotal(jobs), at: now() };
  try { claimPendingBatch(storage, scope, pending); } catch (error) {
    return { state: "refused", reason: error instanceof Error ? error.message : "The batch could not be remembered. Nothing was sent." };
  }
  try {
    const sent = await studioRequest<{ jobs?: unknown[] }>(CONNECTED_GENERATION_ENDPOINT, {
      method: "POST", headers: headers(scope), body: JSON.stringify(connectedBatchSubmitRequest(draftId, jobs)),
    });
    /* An answer that does not name every take it was sent is no answer: it is checked like a lost reply (below). */
    const views = (sent.jobs ?? []).map((job) => parseConnectedJob(job, draftId));
    if (views.length !== count || views.some((view, i) => view.id !== pending.ids[i])) throw new Error("unreadable batch answer");
    clearPendingBatch(storage, scope, draftId, batchId);
    return { state: "sent", jobs: views };
  } catch (error) {
    /* Answered, and refused before any take was claimed: nothing was sent or charged. A take already claimed by
       another submit, or no answer at all, is the one case that is not known: it is checked before anything else. */
    const code = error instanceof StudioRequestError ? String(error.data?.code ?? "") : "";
    if (error instanceof StudioRequestError && error.status >= 400 && error.status < 500 && code !== "already_submitted") {
      clearPendingBatch(storage, scope, draftId, batchId);
      const reason = code === "capacity"
        ? `The connected account already has jobs running; a batch of ${count} needs ${count} free slots.`
        : neutralCopy(error.message, "The connected account refused this batch.");
      return { state: "refused", reason: `Nothing was sent or charged: ${reason.charAt(0).toLowerCase()}${reason.slice(1).replace(/\.?$/, ".")}` };
    }
    const checked = await checkBatch(scope, draftId, pending.ids);
    if (checked.state !== "unknown") clearPendingBatch(storage, scope, draftId, batchId);
    if (checked.state === "landed") return { state: "sent", jobs: checked.jobs, note: "The answer was lost on the way back, so the batch was checked: it had reached the connected account." };
    if (checked.state === "lost") return { state: "refused", reason: "The batch never reached the connected account. Nothing was charged; press Generate to send it again." };
    return { state: "unknown", reason: checked.reason };
  }
}

/* ── A workspace batch whose reply was lost ───────────────────────────── */

/** The takes of a workspace batch left unconfirmed, remembered until the next Generate on the project asks about them. */
type WorkspaceBatchRecord = {
  projectId: string; batchId: string; name: string; model: string; at: number;
  takes: { variation: number; storageId: string; credits: number }[];
};
const WS_PREFIX = "particl:workspace-batch:v1:";
const wsKey = (scope: string, projectId: string) => `${WS_PREFIX}${JSON.stringify([scope, projectId])}`;

/**
 * Kept where every tab of this browser finds it, and in this tab's own store too (lib/workbench/pending-generation.ts ›
 * tabStorage): another tab's press may settle the batch and remove the shared record, and this tab's next press must still
 * ask about its own takes (each by its own claimed request) before anything new is sent.
 */
export function rememberWorkspaceBatch(storage: Storage, scope: string, record: Omit<WorkspaceBatchRecord, "at">) {
  const value = JSON.stringify({ ...record, at: Date.now() });
  try { storage.setItem(wsKey(scope, record.projectId), value); } catch { /* each take's claim is still kept by the dispatch */ }
  try { tabStorage(storage).setItem(wsKey(scope, record.projectId), value); } catch { /* the shared record still guards */ }
}
function readWorkspaceBatch(storage: Storage, scope: string, projectId: string): WorkspaceBatchRecord | null {
  const raw = storage.getItem(wsKey(scope, projectId));
  if (!raw) return null;
  const value = JSON.parse(raw) as WorkspaceBatchRecord;
  if (!value || value.projectId !== projectId || typeof value.batchId !== "string" || !Array.isArray(value.takes) || !value.takes.length ||
      !value.takes.every((t) => Number.isInteger(t.variation) && typeof t.storageId === "string" && Number.isFinite(t.credits)))
    throw new Error("The saved batch cannot be read. Check Takes before starting another.");
  return value;
}

export type SettledWorkspaceBatch =
  | { state: "none" }
  | { state: "settled"; batchId: string; name: string; model: string; landed: { variation: number; jobId: string; credits: number }[]; lost: number[] }
  | { state: "unknown"; reason: string };

/**
 * Before anything else is sent for this project: each take of an earlier
 * batch whose reply was lost is asked about by its own claimed request
 * (settleWorkspaceTake). What landed is followed; what never did is let go
 * with nothing charged; while any is still unknown, nothing new is sent.
 */
export async function settleWorkspaceBatch(options: { scope: string; projectId: string; storage?: Storage }): Promise<SettledWorkspaceBatch> {
  const storage = options.storage ?? window.localStorage;
  const own = tabStorage(storage);
  const key = wsKey(options.scope, options.projectId);
  let record: WorkspaceBatchRecord | null;
  try { record = readWorkspaceBatch(storage, options.scope, options.projectId); } catch (error) {
    return { state: "unknown", reason: error instanceof Error ? error.message : "The saved batch cannot be read." };
  }
  /* No shared record, but this tab's own: another tab settled that batch. This press asks about it as if it were still shared. */
  let mine = false;
  if (!record) {
    try { record = readWorkspaceBatch(own, options.scope, options.projectId); mine = record != null; } catch { try { own.removeItem(key); } catch { /* nothing to drop */ } record = null; }
  }
  if (!record) return { state: "none" };
  const landed: { variation: number; jobId: string; credits: number }[] = [], lost: number[] = [], waiting: WorkspaceBatchRecord["takes"] = [];
  let reason = "";
  for (const take of record.takes) {
    const settled = await settleWorkspaceTake({ scope: options.scope, storageId: take.storageId, storage });
    if (settled.state === "landed") landed.push({ variation: take.variation, jobId: settled.jobId, credits: settled.credits });
    else if (settled.state === "lost") lost.push(take.variation);
    else { waiting.push(take); reason ||= settled.reason; }
  }
  const batchId = record.batchId;
  const holds = (store: Storage) => { try { return (JSON.parse(store.getItem(key) ?? "null") as { batchId?: unknown } | null)?.batchId === batchId; } catch { return false; } };
  for (const store of mine ? [own] : [storage, own]) {
    if (store === own && !mine && !holds(own)) continue;
    try {
      if (waiting.length) store.setItem(key, JSON.stringify({ ...record, takes: waiting }));
      else store.removeItem(key);
    } catch { /* the claims themselves are still kept */ }
  }
  if (waiting.length) return { state: "unknown", reason: `Your last batch could not be checked yet (${reason.replace(/[.\s]+$/, "")}), so nothing new was sent. Try again in a moment.` };
  return { state: "settled", batchId: record.batchId, name: record.name, model: record.model, landed, lost };
}

/* ── Progress: one reading of each take for the strip, Gen's Results and the toast ── */

export type TakeRead = { media?: MediaJob; connected?: ConnectedJob };
export type TakeView = {
  variation: number;
  /** "take 2". */
  label: string;
  /** Its state in a few words: "Rendering", "Complete", "Failed · not billed", "Not sent · not charged". */
  status: string;
  tone: "blue" | "green" | "red" | "amber" | "idle";
  /** Nothing more will happen to it here. */
  done: boolean;
  /** The job to follow (a generation id, or the connected job id). */
  jobId: string | null;
  /** The generation its output was filed as, once known: the Library card to show. */
  generationId: string | null;
  credits: number;
};

/** One take, from what the batch did with it and the latest read of its job. */
export function takeView(take: BatchTake, source: "workspace" | "connected", read: TakeRead | undefined): TakeView {
  const base = { variation: take.variation, label: `take ${take.variation}`, jobId: take.jobId, generationId: null as string | null, credits: take.credits };
  if (take.state === "refused") return { ...base, status: "Not made · not charged", tone: "red", done: true };
  if (take.state === "not-sent") return { ...base, status: "Not sent · not charged", tone: "idle", done: true };
  if (take.state === "unconfirmed") return { ...base, status: "Reply lost · checked next Generate", tone: "amber", done: true };
  /* Held (credits ran out, or no slot yet): not charged until it runs. One waiting for credits waits for the person; one waiting for a slot starts by itself. */
  if (source === "workspace" && (take.state === "held" || read?.media?.status === "held")) {
    const why = read?.media?.params?.held?.why;
    const pooled = why === "slots" && read?.media?.params?.held?.pool === POOL_MARK;
    return { ...base, status: pooled ? POOL_LABEL : why === "slots" ? "Held · waiting for a slot" : "Held · needs credits", tone: "amber", done: Boolean(read?.media) && why !== "slots" };
  }
  if (source === "connected") {
    const job = read?.connected;
    if (!job) return { ...base, status: "Checking with the account", tone: "blue", done: false };
    if (job.status === "completed") {
      const original = job.result && typeof job.result === "object" ? (job.result as { original?: { generationId?: unknown } }).original : undefined;
      return { ...base, status: "Complete", tone: "green", done: true, generationId: typeof original?.generationId === "string" ? original.generationId : null };
    }
    /* Refunded or charged only once the account's own ledger names the job; just "Failed" until then. */
    if (job.status === "failed") return { ...base, status: job.failureCode === "invalid_result" ? "Finished · not kept" : failedChip(job.failure), tone: "red", done: true };
    if (job.status === "accepted") return { ...base, status: "Rendering", tone: "blue", done: false };
    if (job.status === "quoted") return { ...base, status: "Not sent · not charged", tone: "idle", done: true };
    return { ...base, status: "Checking with the account", tone: "blue", done: false };
  }
  /* The Rig's own reading of a job (held, failed · not billed …), so a take says here what it says there. */
  const phase = generationPhase(read?.media ?? { status: "queued" });
  return { ...base, status: phase.label, tone: phase.tone, done: phase.done, generationId: read?.media?.status === "succeeded" ? take.jobId : null };
}

/** The whole batch in one line for the shell's strip: how far it is, and whether it is over. */
export function batchPhase(views: readonly TakeView[]): { label: string; pct: number; tone: "blue" | "green" | "red"; done: boolean } {
  const total = views.length;
  const finished = views.filter((v) => v.done).length;
  const made = views.filter((v) => v.tone === "green").length;
  const done = finished === total;
  const pct = Math.round((views.reduce((sum, v) => sum + (v.done ? 100 : v.status === "Rendering" ? 50 : 10), 0) / Math.max(1, total)));
  if (!done) return { label: made ? `${made} of ${total} rendered` : `Rendering ${total} takes`, pct: Math.min(96, pct), tone: "blue", done };
  if (made === total) return { label: `${total} takes rendered`, pct: 100, tone: "green", done };
  if (!made) return { label: "No take rendered", pct: 100, tone: "red", done };
  return { label: `${made} of ${total} rendered`, pct: 100, tone: "green", done };
}

/** What the toast says once a batch is over: what rendered, what did not, and that nothing unmade was billed. */
export function batchSettledText(name: string, views: readonly TakeView[]): string {
  const made = views.filter((v) => v.tone === "green");
  if (made.length === views.length) return `${name}: ${views.length} takes rendered. They are one strip in Takes.`;
  const held = views.filter((v) => v.status.startsWith("Held"));
  const unsure = views.filter((v) => v.status.startsWith("Reply lost"));
  const failed = views.filter((v) => v.tone !== "green" && !held.includes(v) && !unsure.includes(v));
  const parts = [made.length ? `${name}: ${made.length} of ${views.length} takes rendered, one strip in Takes.` : `${name}: no take rendered yet.`];
  if (failed.length) {
    const unbilled = failed.every((v) => v.status.includes("not billed") || v.status.includes("not charged") || v.status.includes("refunded"));
    parts.push(`${upper(takesPhrase(failed.map((v) => v.variation)))} did not${unbilled ? " and cost nothing" : ""}.`);
  }
  if (held.length) parts.push(`${upper(takesPhrase(held.map((v) => v.variation)))} ${held.length === 1 ? "is" : "are"} held, not charged until ${held.length === 1 ? "it runs" : "they run"}.`);
  if (unsure.length) parts.push(`${upper(takesPhrase(unsure.map((v) => v.variation)))}: the reply was lost, and it is checked before anything else is sent.`);
  return parts.join(" ");
}
