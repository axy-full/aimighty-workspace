/**
 * The jobs tray (components/graphite/JobsTray.tsx): every take this person
 * has in flight or just finished, from Particl's own engines and from the
 * connected account, as one list the header counts.
 *
 * Pure. The route turns stored rows into tray rows with it (so the browser
 * never sees a dollar it should not, nor a payload); the browser orders and
 * counts them and folds in the composer's not-yet-saved submit. A unit spec
 * drives all of it.
 *
 * Stages are the job's real ones, in the take cards' words (Queued ·
 * Rendering · Held · Failed · Cancelled). No engine reports a percentage
 * today, so `progress` is null and the tray draws an indeterminate bar on
 * what is actually rendering; a ring appears only for a row that carries a
 * real 0–1 figure. Money is the ledger's (lib/usageLedgerTerms): the price as
 * it was approved and reserved, what was charged once it settled, and "not
 * billed" only where the ledger shows nothing charged — or, on a workspace
 * that pays its vendors, only where the provider's own recorded word says so.
 */
import type { GenPreset } from "./shell/recipe";
import { failureKind } from "./jobState";
import { failedChip, failureCopy, failureUncharged } from "./errors";
import { accountFailure, type ProviderOutcome, type TakeFailure } from "./providerOutcome";
import { canProgress, resumeAge, resumePhase, shortName } from "./higgsfield-consumer/resume";
import { fmtConnectedCredits, fmtLedgerCredits, fmtLedgerUsd } from "./usageLedgerTerms";
import { vendorNameIn } from "./vendorNames";
import { isCreditAmount } from "./creditTerms";
import { KEY_CHANGED_LABEL, KEY_CHANGED_REASON, POOL_MARK, POOL_REASON, waitsOnChangedKey } from "./sharedKeyTerms";

/** `aside`: a connected job set aside (by its owner, or past the time it may hold a slot) — never sent again, nothing to wait for. */
export type TrayStage = "submitting" | "queued" | "rendering" | "confirming" | "held" | "unconfirmed" | "complete" | "failed" | "cancelled" | "aside";
export type TrayTone = "blue" | "amber" | "green" | "red" | "idle";
/** The one thing a row offers: see the take, start a held one, make a failed one again, or go where it was made. */
export type TrayAction = "open" | "release" | "recreate" | "gen" | "viral";
export type TrayPrice = { amount: number; unit: "cr" | "usd" | "account-cr" };

export type TrayJob = {
  id: string;
  /** Particl's own engines, or the connected account. */
  source: "engine" | "account";
  kind: "video" | "image" | "audio" | "other";
  name: string;
  /** A finished take's stored copy in Particl, for its thumbnail. */
  mediaUrl: string | null;
  stage: TrayStage;
  label: string;
  tone: TrayTone;
  /** Why it failed or waits, in one line of the product's words. */
  reason: string | null;
  /** 0–1 when an engine reports real progress; null otherwise (none does today). */
  progress: number | null;
  createdAt: number;
  /** When it succeeded, failed or was cancelled; null while it is not settled. */
  settledAt: number | null;
  /** The ledger's figure: approved and reserved while it runs, charged once settled; the account's own credits for a connected job. */
  price: TrayPrice | null;
  /** The project (draft) it was made in, when known, and its name. */
  draftId: string | null;
  projectName: string | null;
  action: TrayAction | null;
  /** Open in Takes: the take as the project's Library names it ("generation:<id>"). */
  takeId?: string | null;
  /** Release: the credits it approves (to a tenth) — the figure on its button, sent with the press (POST /api/jobs/:id/release `{ credits }`). */
  releaseCredits?: number | null;
  /** Recreate: the take's own recipe as Gen reads it (lib/shell/recipe recreatePreset), built where the take is read. */
  preset?: GenPreset | null;
};

export type TrayReply = {
  jobs: TrayJob[];
  pollAfterSeconds: number;
  /** The connected account's jobs could not be read this time; the engine's rows are complete. */
  partial?: boolean;
};

/** How long a finished take stays in the tray. */
export const TRAY_WINDOW_MS = 6 * 3_600_000;
export const TRAY_LIMIT = 30;
/** The server's pace for the next read: often while something runs, rarely otherwise. */
export const TRAY_ACTIVE_POLL_S = 10;
export const TRAY_IDLE_POLL_S = 60;
export const ENGINE_ACTIVE: readonly string[] = ["queued", "running", "held"];
export const ENGINE_SETTLED: readonly string[] = ["succeeded", "failed", "cancelled"];

/**
 * GET /api/jobs `status`: one status as before (any value; one that matches
 * nothing lists nothing), or a comma list of them (`queued,running,held`).
 */
export function statusFilter(raw: string | null): { status?: string; statuses?: string[] } {
  if (raw == null || !raw.includes(",")) return raw ? { status: raw } : {};
  const list = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 8);
  return list.length > 1 ? { statuses: list } : list.length ? { status: list[0] } : {};
}

/** Actually moving on an engine or the account: the rows the moving bar is for, and the pill's "rendering". */
const MOVING: readonly TrayStage[] = ["submitting", "rendering", "confirming"];
export const moving = (job: Pick<TrayJob, "stage">) => MOVING.includes(job.stage);
const SETTLED: readonly TrayStage[] = ["complete", "failed", "cancelled", "aside"];
export const settled = (job: Pick<TrayJob, "stage">) => SETTLED.includes(job.stage);
/** Not settled: in flight, waiting its turn, held, or sent and not yet confirmed. */
export const active = (job: Pick<TrayJob, "stage">) => !settled(job);
/** Something that moves on its own: worth reading often. A held take waits on a person, an unconfirmed job on nobody. */
export const changing = (job: Pick<TrayJob, "stage">) => moving(job) || job.stage === "queued";

const clean = (text: string | null | undefined) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "");
/** A row's own words, cut to their first sentence, without links, ids or JSON; null when they name a vendor or say nothing. */
function ownLine(message: string | null | undefined): string | null {
  const plain = clean(message).replace(/https?:\/\/\S+/g, "").replace(/[{[][\s\S]*$/, "").trim();
  if (!plain || vendorNameIn(plain)) return null;
  const sentence = /^(.{8,}?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.length > 120 ? `${sentence.slice(0, 117).trimEnd()}…` : sentence;
}
/**
 * Why a take failed, in one line (the take cards' words: lib/jobState
 * failureKind reads the row's own). It never claims a refund: whether it was
 * billed is the label's to say, from the ledger. A failure its provider
 * answered for reads in the typed words instead (typedReason).
 */
export function failureLine(error: string | null | undefined, params?: unknown): string {
  const raw = clean(error);
  const said = raw ? failureKind(raw) : "unknown";
  switch (said !== "unknown" ? said : failureKind(raw, params)) {
    case "refused": return "Refused by the content filter";
    case "cap": return "The production is at its cap";
    case "balance": return "Out of credits";
    case "slots": return "Every render slot was busy";
    case "vendor": return /timed out|timeout|never came back/i.test(raw) ? "The engine timed out" : "The engine hit an error";
    default: return ownLine(raw) ?? "It did not render";
  }
}
/**
 * A failure its provider answered for (lib/providerOutcome.ts), in the typed
 * words the take cards use (lib/errors.ts): refused settings are not the
 * content filter, and the engine's own account running dry is not this
 * workspace's balance. Null when no provider answered: the row's words speak.
 */
export const typedReason = (failure: TakeFailure | null | undefined): string | null =>
  failure?.provider != null ? failureCopy(failure.kind, failure.payer).what : null;
const mediaOf = (kind: string | null | undefined, id: string | null | undefined) =>
  id && (kind === "image" || kind === "video") ? `/api/media/${encodeURIComponent(id)}` : null;
const kindOf = (value: unknown): TrayJob["kind"] => (value === "video" || value === "image" || value === "audio" ? value : "other");
const amount = (value: number | null | undefined, unit: TrayPrice["unit"]): TrayPrice | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? { amount: value, unit } : null;

/* ── Rows from Particl's own engines (the generations table) ─────────── */

/** The fields of a stored take the tray reads (lib/jobs `Generation`, already made safe for the browser). */
export type EngineRow = {
  id: string; kind: string; model: string; prompt: string; title: string | null; status: string;
  params: Record<string, unknown>; storedUrl: string | null; error: string | null;
  createdAt: number; settledAt?: number | null; projectName: string | null;
  /** A failed take's recorded outcome, as lib/jobs made it safe for this viewer. */
  failure?: TakeFailure | null;
};
/**
 * The take's money, read off the ledger on the server (lib/jobsTray.server):
 * never estimated again from today's rates.
 */
export type EngineMoney = {
  /** Credits for a workspace on credits; dollars for one that pays its vendors. */
  unit: "cr" | "usd";
  /** In flight: what admission approved and reserved for it (the meter's running row). */
  reserved: number | null;
  /** Settled: what the ledger charged — 0 is "not billed" — or null when the ledger has no settled figure. */
  charged: number | null;
  /** Held: what was approved when it was held (credits, whole), never re-derived; the figure its Release sends. */
  needs: number | null;
};
/** What Recreate does for a take: Gen's recipe for it, or why Gen cannot make it (lib/shell/recipe recreateBlock). */
export type EngineRecreate = { preset: GenPreset } | { blocked: string } | null;

export function engineTrayJob(row: EngineRow, money: EngineMoney, draftId: string | null = null, recreate: EngineRecreate = null): TrayJob {
  const params = row.params ?? {};
  const held = (params.held ?? null) as { why?: string; pool?: string } | null;
  /* Named the way the Library and Takes name it: its title, else its words. */
  const name = shortName(clean(row.title) || clean(row.prompt), 60) || "Untitled take";
  const base = {
    id: row.id, source: "engine" as const, kind: kindOf(row.kind), name, mediaUrl: null, reason: null, progress: null,
    createdAt: row.createdAt, settledAt: null, draftId, projectName: row.projectName, price: null, action: null,
  };
  const takeId = `generation:${row.id}`;
  const reserved = amount(money.reserved, money.unit);
  const charged = amount(money.charged, money.unit);
  /* Credits: a settled take the ledger shows at zero was not charged (Particl's own receipt). Dollars: the money is
     the workspace's own with its vendor, and a recorded zero is only Particl's metering — a refused request may still
     be charged — so only the provider's recorded word (refunded, not charged) says it was not. */
  const unbilled = money.unit === "cr" ? money.charged === 0 : failureUncharged(row.failure);
  const again = (): Pick<TrayJob, "action" | "preset" | "takeId"> =>
    recreate && "preset" in recreate ? { action: "recreate", preset: recreate.preset } : { action: "open", takeId };
  switch (row.status) {
    case "succeeded":
      return {
        ...base, stage: "complete", label: "Complete", tone: "green", settledAt: row.settledAt ?? null,
        mediaUrl: row.storedUrl ? mediaOf(row.kind, row.id) : null, price: charged, action: "open", takeId,
      };
    case "failed":
      return {
        ...base, stage: "failed", tone: "red", settledAt: row.settledAt ?? null,
        label: unbilled ? "Failed · not billed" : "Failed", reason: typedReason(row.failure) ?? failureLine(row.error, params), price: charged, ...again(),
      };
    case "cancelled": {
      /* Discarded while held: the person's own doing, not a failure, and nothing was reserved for it. */
      const discarded = params.discardedAt != null;
      return {
        ...base, stage: "cancelled", tone: "idle", settledAt: row.settledAt ?? null,
        label: discarded ? "Discarded" : unbilled ? "Cancelled · not billed" : "Cancelled",
        reason: discarded ? null : ownLine(row.error), price: charged, ...again(),
      };
    }
    case "held": {
      /* Held for a slot is a place in the line, and starts on its own; held for credits waits for a Release or a top-up. */
      if (held?.why === "slots")
        return { ...base, stage: "queued", label: "Queued", tone: "blue", reason: held.pool === POOL_MARK ? POOL_REASON : "Waiting for a free slot", price: amount(money.needs, money.unit) ?? reserved };
      const needs = money.unit === "cr" && money.needs ? money.needs : null;
      /* A reason of its own written by a refused release (a cap): the label already says what credits it needs. */
      const kind = row.error ? failureKind(row.error) : "unknown";
      return {
        ...base, stage: "held", tone: "amber",
        label: needs ? `Held · needs ${fmtLedgerCredits(needs)}` : "Held · needs credits",
        reason: kind === "balance" || kind === "slots" ? null : ownLine(row.error),
        /* Release approves an exact figure: without one there is nothing to approve here. */
        price: null, ...(needs ? { action: "release" as const, releaseCredits: needs } : {}),
      };
    }
    case "running":
      /* Sent on a provider key that is gone: it waits, never failed or sent again, while that is sorted out. */
      if (waitsOnChangedKey(params)) return { ...base, stage: "confirming", label: KEY_CHANGED_LABEL, tone: "amber", reason: KEY_CHANGED_REASON, price: reserved };
      return { ...base, stage: "rendering", label: "Rendering", tone: "blue", price: reserved };
    default:
      if (waitsOnChangedKey(params)) return { ...base, stage: "confirming", label: KEY_CHANGED_LABEL, tone: "amber", reason: KEY_CHANGED_REASON, price: reserved };
      return { ...base, stage: "queued", label: "Queued", tone: "blue", price: reserved };
  }
}

/* ── Rows from the connected account (higgsfield_consumer_jobs) ──────── */

/** The columns the route reads — never the payload, receipt or grant themselves. */
export type AccountRow = {
  id: string; draftId: string; workflow: string; status: string; quoteCredits: number;
  failureCode: string | null; createdAt: number; updatedAt: number;
  hasReceipt: boolean; setAside: boolean;
  prompt: string | null; modelId: string | null; outputType: string | null; toolLabel: string | null;
  originalId: string | null; originalKind: string | null; projectName: string | null;
  /** A failed job: what the account said (lib/providerOutcome.ts); its charge stays unknown until its own ledger names one. */
  outcome?: ProviderOutcome | null;
};

const WORKFLOW_NAME: Record<string, string> = {
  genjutsu: "Motion transfer", "marketing-video": "Ad", "marketing-template": "Ad template", "voice-tool": "Voice",
  shorts: "Short", "reference-match": "Reference match", virality: "Viral check", generation: "Take",
};

/**
 * A connected job, as the account's own record has it. Its price is the
 * account's own credits as quoted and approved, never converted. The ledger
 * (#407) keeps connected jobs as quotes and does not record what the account
 * refunded, so a failure here never claims "not billed".
 */
export function accountTrayJob(row: AccountRow, preset: GenPreset | null = null): TrayJob {
  const job = { status: row.status, providerReceipt: row.hasReceipt ? true : undefined, setAside: row.setAside, failureCode: row.failureCode };
  const following = canProgress(job) && !row.setAside;
  const phase = resumePhase(job, following);
  const words = clean(row.prompt);
  const name = words ? shortName(words, 60) : clean(row.toolLabel) || WORKFLOW_NAME[row.workflow] || "Take";
  const kind = kindOf(row.originalKind ?? row.outputType ?? (row.workflow === "genjutsu" || row.workflow.startsWith("marketing") || row.workflow === "shorts" ? "video" : row.workflow === "voice-tool" ? "audio" : null));
  const quoted = amount(row.quoteCredits, "account-cr");
  const base = {
    id: row.id, source: "account" as const, kind, name, mediaUrl: null, reason: null, progress: null,
    createdAt: row.createdAt, settledAt: null, draftId: row.draftId, projectName: row.projectName, price: quoted, action: null,
  };
  /* Where the job's own card is (with Check again and Dismiss), for one nobody can confirm from here.
     A Business ad's page is gone (Business › Ads was removed): its row opens Takes, where its results are. */
  const where: TrayAction | null = row.workflow === "generation" ? "gen" : row.workflow === "genjutsu" ? "viral" : row.workflow.startsWith("marketing") ? "open" : null;
  switch (row.status) {
    case "completed":
      return {
        ...base, stage: "complete", label: "Complete", tone: "green", settledAt: row.updatedAt, mediaUrl: mediaOf(row.originalKind, row.originalId),
        ...(row.originalId ? { action: "open" as const, takeId: `generation:${row.originalId}` } : {}),
      };
    case "failed": {
      const kept = row.failureCode === "invalid_result";
      const action: TrayAction | null = preset ? "recreate" : row.workflow === "genjutsu" ? "viral" : row.workflow.startsWith("marketing") ? "open" : null;
      /* The account's own reason when it gave one; "refunded" or "charged" only once its own ledger names the job. */
      const failure = row.outcome ? accountFailure(row.outcome, row.failureCode) : null;
      return {
        ...base, stage: "failed", tone: "red", settledAt: row.updatedAt, action, ...(preset ? { preset } : {}),
        label: kept ? phase.label : failedChip(failure),
        reason: kept ? "The account finished it, but the result could not be kept. Its receipt is saved."
          : failure ? failureCopy(failure.kind, failure.payer).what : "The connected account reported it as failed.",
        /* Finished on the account but not kept: the approved figure may have been spent. Refused: no figure is claimed either way. */
        price: kept ? quoted : null,
      };
    }
    default:
      /* Set aside, or past the time it may hold a slot: never sent again, and nothing here waits on it. */
      if (row.setAside) return { ...base, stage: "aside", label: phase.label, tone: "idle", settledAt: row.updatedAt, action: where };
      if (following) return row.status === "accepted" ? { ...base, stage: "rendering", label: "Rendering", tone: "blue" } : { ...base, stage: "confirming", label: phase.label, tone: "amber" };
      /* Sent, or maybe sent, with nothing to confirm it by: never sent twice; its card says what can be done. */
      return { ...base, stage: "unconfirmed", label: phase.label, tone: "amber", action: where };
  }
}

/* ── The browser: order, count, and the composer's own submit ───────── */

const STAGES: ReadonlySet<string> = new Set(["submitting", "queued", "rendering", "confirming", "held", "unconfirmed", "complete", "failed", "cancelled", "aside"]);
const KINDS: ReadonlySet<string> = new Set(["video", "image", "audio", "other"]);
const TONES: ReadonlySet<string> = new Set(["blue", "amber", "green", "red", "idle"]);
const ACTIONS: ReadonlySet<string> = new Set(["open", "release", "recreate", "gen", "viral"]);
/** An action a reply may still carry for a page that is gone (Business › Ads), and the one that stands in: Takes, with no take named. */
const RETIRED_ACTIONS: Readonly<Record<string, TrayAction>> = { ads: "open" };
const UNITS: ReadonlySet<string> = new Set(["cr", "usd", "account-cr"]);
const TAKE_ID = /^generation:[A-Za-z0-9_-]{1,160}$/;
/** A recipe as Gen's letterbox takes it: words, and the take it came from. */
function parsePreset(value: unknown): GenPreset | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<GenPreset>;
  return typeof p.prompt === "string" && p.from && typeof p.from.id === "string" && typeof p.from.name === "string" ? (value as GenPreset) : null;
}
/**
 * The route's reply, checked row by row: a row missing a field the tray draws
 * is dropped, an unknown kind, tone or action falls back to a plain one (an
 * action whose target is missing is dropped), and only Particl's own media
 * path is ever put in a thumbnail. No jobs list, no reply.
 */
export function parseTrayReply(value: unknown): TrayReply | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as TrayReply).jobs)) return null;
  const reply = value as TrayReply;
  const jobs = reply.jobs.flatMap((job): TrayJob[] => {
    if (!job || typeof job !== "object" || typeof job.id !== "string" || !job.id || typeof job.name !== "string" || !STAGES.has(job.stage)
      || typeof job.label !== "string" || !Number.isFinite(job.createdAt)) return [];
    const price = job.price && typeof job.price === "object" && Number.isFinite(job.price.amount) && UNITS.has(job.price.unit) ? job.price : null;
    const takeId = typeof job.takeId === "string" && TAKE_ID.test(job.takeId) ? job.takeId : null;
    const preset = parsePreset(job.preset);
    const releaseCredits = isCreditAmount(job.releaseCredits) && Number(job.releaseCredits) > 0 ? Number(job.releaseCredits) : null;
    /* "open" with a take lands on it; a Business ad's "open" names no take and opens Takes itself. */
    const asked = job.action ? RETIRED_ACTIONS[job.action] ?? job.action : null;
    const pageless = asked === "open" && !takeId && job.source === "account";
    const action = asked && ACTIONS.has(asked) && (asked !== "open" || takeId || pageless) && (asked !== "recreate" || preset) && (asked !== "release" || releaseCredits) ? asked : null;
    return [{
      ...job,
      kind: KINDS.has(job.kind) ? job.kind : "other",
      tone: TONES.has(job.tone) ? job.tone : "blue",
      action, takeId, preset, releaseCredits, price,
      settledAt: Number.isFinite(job.settledAt) ? job.settledAt : null,
      mediaUrl: typeof job.mediaUrl === "string" && job.mediaUrl.startsWith("/api/media/") ? job.mediaUrl : null,
      progress: typeof job.progress === "number" && job.progress >= 0 && job.progress <= 1 ? job.progress : null,
      reason: typeof job.reason === "string" ? job.reason : null,
      draftId: typeof job.draftId === "string" ? job.draftId : null,
      projectName: typeof job.projectName === "string" ? job.projectName : null,
    }];
  });
  return { jobs, pollAfterSeconds: Number(reply.pollAfterSeconds) || TRAY_IDLE_POLL_S, ...(reply.partial ? { partial: true } : {}) };
}

const RANK: Record<TrayStage, number> = { held: 0, submitting: 1, rendering: 1, confirming: 1, queued: 2, unconfirmed: 3, failed: 4, complete: 4, cancelled: 4, aside: 4 };
const when = (job: TrayJob) => job.settledAt ?? job.createdAt;
/** Held first (it waits on you), then what renders, then what waits its turn, newest first; then what finished, latest first. */
export function trayOrder(jobs: readonly TrayJob[]): TrayJob[] {
  const seen = new Set<string>();
  return jobs.filter((job) => (seen.has(job.id) ? false : (seen.add(job.id), true)))
    .sort((a, b) => RANK[a.stage] - RANK[b.stage] || (RANK[a.stage] >= 4 ? when(b) - when(a) : b.createdAt - a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, TRAY_LIMIT);
}

/** The composer's job as the shell's strip shows it (lib/workspace/types `Generation`). */
export type ComposerSlot = { id: string; name: string; label?: string; tone?: "blue" | "green" | "red" } | null;
/**
 * The composer publishes its job the moment Generate is pressed, before the
 * server has a row for it (and before the next read brings that row). Until
 * then it is shown from the composer's own words. Once the read has it, the
 * read's row wins — except that a composer which has seen its job end says
 * so at once, over a row the last read still had in flight, until the next
 * read (asked for at that moment) brings the settled row and its figure.
 */
export function withComposerSlot(jobs: readonly TrayJob[], slot: ComposerSlot, now: number): TrayJob[] {
  if (!slot) return [...jobs];
  const ended = slot.tone === "green" ? { stage: "complete" as const, label: "Complete", tone: "green" as const }
    : slot.tone === "red" ? { stage: "failed" as const, label: "Failed", tone: "red" as const } : null;
  const listed = jobs.find((job) => job.id === slot.id);
  if (listed) {
    if (!ended || settled(listed)) return [...jobs];
    return jobs.map((job) => (job.id === slot.id ? { ...job, ...ended, reason: null, settledAt: now, price: null, action: null } : job));
  }
  const pending = slot.id.startsWith("pending:");
  const label = slot.label ?? (pending ? "Submitting" : "Rendering");
  const stage: TrayStage = ended ? ended.stage : pending || /^submitting/i.test(label) ? "submitting" : /^queued/i.test(label) ? "queued" : /^held/i.test(label) ? "held" : "rendering";
  const tone: TrayTone = ended ? ended.tone : stage === "held" ? "amber" : "blue";
  return [{
    id: slot.id, source: "engine", kind: "other", name: slot.name || "New take", mediaUrl: null, stage, label: ended ? ended.label : label, tone, reason: null, progress: null,
    createdAt: now, settledAt: ended ? now : null, price: null, draftId: null, projectName: null, action: null,
  }, ...jobs];
}

/** A settled row, as the person last saw it: seen again only if it changes (a late success after a failure). */
export const seenKey = (job: Pick<TrayJob, "id" | "stage">) => `${job.id}:${job.stage}`;
/** What finished is news until it has been seen; a discarded, cancelled or set-aside job is never news. */
const news = (job: TrayJob, seen: ReadonlySet<string>) => (job.stage === "complete" || job.stage === "failed") && !seen.has(seenKey(job));

export type TraySummary = {
  /** Something runs or waits; else something finished unseen; else only what finished earlier, which the tray keeps a few hours. */
  kind: "active" | "news" | "quiet";
  rendering: number; queued: number; held: number; unconfirmed: number; done: number; failed: number;
  /** "2 rendering · 1 queued · 1 held", "1 done · 1 failed", "Jobs". */
  text: string;
  /** The phone's (and a phone on its side's) one figure; the quiet pill has none. */
  short: string;
  tone: TrayTone;
};
/**
 * The header pill, counted the way the rows are labelled: rendering is what a
 * row says renders (or is confirming, or on its way); queued is what waits
 * its turn (including a take held for a free slot); held is what waits on
 * credits; unconfirmed is a connected job nobody can confirm from here. With
 * none of those, what finished that the person has not seen in the tray.
 * With none of that either, a quiet pill while the tray still has rows, so
 * they can always be reached. Null only when there is nothing at all.
 */
export function traySummary(jobs: readonly TrayJob[], seen: ReadonlySet<string> | null): TraySummary | null {
  if (!jobs.length) return null;
  const count = (stages: readonly TrayStage[]) => jobs.filter((job) => stages.includes(job.stage)).length;
  const rendering = count(MOVING), queued = count(["queued"]), held = count(["held"]), unconfirmed = count(["unconfirmed"]);
  const done = seen ? jobs.filter((job) => job.stage === "complete" && news(job, seen)).length : 0;
  const failed = seen ? jobs.filter((job) => job.stage === "failed" && news(job, seen)).length : 0;
  const counts = { rendering, queued, held, unconfirmed, done, failed };
  const waiting = rendering + queued + held + unconfirmed;
  if (waiting) {
    const text = [[rendering, "rendering"], [queued, "queued"], [held, "held"], [unconfirmed, "unconfirmed"]]
      .filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(" · ");
    const tone: TrayTone = rendering ? "blue" : held || unconfirmed ? "amber" : "blue";
    return { kind: "active", ...counts, text, short: String(waiting), tone };
  }
  if (done || failed) {
    const text = [done ? `${done} done` : null, failed ? `${failed} failed` : null].filter(Boolean).join(" · ");
    return { kind: "news", ...counts, text, short: String(done + failed), tone: failed ? "red" : "green" };
  }
  return { kind: "quiet", ...counts, text: "Jobs", short: "", tone: "idle" };
}

export const ACTION_LABEL: Record<TrayAction, string> = { open: "Open in Takes", release: "Release", recreate: "Recreate", gen: "Open Gen", viral: "Open Viral" };

/** The ledger's own words for a figure: "13 cr", "$0.840"; a connected job's is the account's own credits, said so ("40 connected cr"). */
export function priceLabel(price: TrayPrice | null): string | null {
  if (!price) return null;
  if (price.unit === "usd") return fmtLedgerUsd(price.amount);
  return price.unit === "account-cr" ? fmtConnectedCredits(price.amount) : fmtLedgerCredits(price.amount);
}

/** "4 min" it has been going; once settled, "20 min ago" it finished ("just now" either way under a minute). */
export function trayWhen(job: Pick<TrayJob, "stage" | "createdAt" | "settledAt">, now: number): string {
  if (!settled(job)) return resumeAge(job.createdAt, now);
  const age = resumeAge(job.settledAt ?? job.createdAt, now);
  return age === "just now" ? age : `${age} ago`;
}
