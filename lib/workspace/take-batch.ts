import { readPendingGeneration } from "../workbench/pending-generation";
import { formatCredits } from "./cost";
import { dispatchGeneration, quoteDispatch, settlePendingGeneration, type DispatchRequest, type QuotedDispatch } from "./generate-submit";
import { generationPhase, neutralCopy } from "./rig";
import type { MediaJob } from "../workbench/job-recovery";

/**
 * Takes 2–4 of one Generate, as ONE priced batch (idea 3).
 *
 * Money, the whole contract:
 *  - The button shows the batch's total. On Generate every take is quoted
 *    fresh, exactly as it will be sent, before any take is sent; the sum must
 *    equal the total on the button. If it does not, nothing is sent: the new
 *    total goes on the button for a second, deliberate Generate. A batch is
 *    never left half sent because a price moved.
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
export function batchNotice(takes: readonly BatchTake[]): string {
  const money = formatCredits;
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

/* ── A workspace batch whose reply was lost ───────────────────────────── */

/** The takes of a workspace batch left unconfirmed, remembered until the next Generate on the project asks about them. */
type WorkspaceBatchRecord = {
  projectId: string; batchId: string; name: string; model: string; at: number;
  takes: { variation: number; storageId: string; credits: number }[];
};
const WS_PREFIX = "particl:workspace-batch:v1:";
const wsKey = (scope: string, projectId: string) => `${WS_PREFIX}${JSON.stringify([scope, projectId])}`;

export function rememberWorkspaceBatch(storage: Storage, scope: string, record: Omit<WorkspaceBatchRecord, "at">) {
  try { storage.setItem(wsKey(scope, record.projectId), JSON.stringify({ ...record, at: Date.now() })); } catch { /* each take's claim is still kept by the dispatch */ }
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
  let record: WorkspaceBatchRecord | null;
  try { record = readWorkspaceBatch(storage, options.scope, options.projectId); } catch (error) {
    return { state: "unknown", reason: error instanceof Error ? error.message : "The saved batch cannot be read." };
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
  try {
    if (waiting.length) storage.setItem(wsKey(options.scope, options.projectId), JSON.stringify({ ...record, takes: waiting }));
    else storage.removeItem(wsKey(options.scope, options.projectId));
  } catch { /* the claims themselves are still kept */ }
  if (waiting.length) return { state: "unknown", reason: `Your last batch could not be checked yet (${reason.replace(/[.\s]+$/, "")}), so nothing new was sent. Try again in a moment.` };
  return { state: "settled", batchId: record.batchId, name: record.name, model: record.model, landed, lost };
}

/* ── Progress: one reading of each take for the strip, Gen's Results and the toast ── */

export type TakeRead = { media?: MediaJob };
export type TakeView = {
  variation: number;
  /** "take 2". */
  label: string;
  /** Its state in a few words: "Rendering", "Complete", "Failed · not billed", "Not sent · not charged". */
  status: string;
  tone: "blue" | "green" | "red" | "amber" | "idle";
  /** Nothing more will happen to it here. */
  done: boolean;
  /** The job to follow (a generation id). */
  jobId: string | null;
  /** The generation its output was filed as, once known: the Library card to show. */
  generationId: string | null;
  credits: number;
};

/** One take, from what the batch did with it and the latest read of its job. */
export function takeView(take: BatchTake, read: TakeRead | undefined): TakeView {
  const base = { variation: take.variation, label: `take ${take.variation}`, jobId: take.jobId, generationId: null as string | null, credits: take.credits };
  if (take.state === "refused") return { ...base, status: "Not made · not charged", tone: "red", done: true };
  if (take.state === "not-sent") return { ...base, status: "Not sent · not charged", tone: "idle", done: true };
  if (take.state === "unconfirmed") return { ...base, status: "Reply lost · checked next Generate", tone: "amber", done: true };
  /* Held (credits ran out, or no slot yet): not charged until it runs. One waiting for credits waits for the person; one waiting for a slot starts by itself. */
  if (take.state === "held" || read?.media?.status === "held") {
    const why = read?.media?.params?.held?.why;
    return { ...base, status: why === "slots" ? "Held · waiting for a slot" : "Held · needs credits", tone: "amber", done: Boolean(read?.media) && why !== "slots" };
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
