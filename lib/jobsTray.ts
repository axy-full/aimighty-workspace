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
 * Stages are the job's real ones. No engine reports a percentage today, so
 * `progress` is null and the tray draws an indeterminate bar; a ring appears
 * only for a row that carries a real 0–1 figure.
 */
import { failureCopy, failureKind } from "./jobState";
import { canProgress, resumeAge, resumePhase, shortName } from "./higgsfield-consumer/resume";
import { vendorNameIn } from "./vendorNames";

export type TrayStage = "submitting" | "queued" | "rendering" | "confirming" | "held" | "complete" | "failed" | "unconfirmed";
export type TrayTone = "blue" | "amber" | "green" | "red";
/** The one thing a row offers: see the take, start a held one, or make a failed one again. */
export type TrayAction = "open" | "release" | "recreate" | "business" | "viral";
export type TrayPrice = { amount: number; unit: "cr" | "usd" | "account-cr" };
/** What Recreate hands Gen: the failed take's own words and settings, never re-sent from here. */
export type TrayRecipe = {
  prompt: string; model: string; kind: string; title: string | null; task: string | null;
  params: Record<string, unknown>;
  /** Made on the connected account: Gen takes its words and model, on the account's catalogue. */
  connected?: boolean;
};

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
  /** Why it failed or is held, in the product's words. */
  reason: string | null;
  /** 0–1 when an engine reports real progress; null otherwise (none does today). */
  progress: number | null;
  createdAt: number;
  updatedAt: number;
  /** The approved price: workspace credits (or dollars on its own keys), or the account's own credits. */
  price: TrayPrice | null;
  /** The project (draft) it was made in, when known, and its name. */
  draftId: string | null;
  projectName: string | null;
  action: TrayAction | null;
  recipe?: TrayRecipe | null;
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

const IN_FLIGHT: readonly TrayStage[] = ["submitting", "queued", "rendering", "confirming"];
export const inFlight = (job: Pick<TrayJob, "stage">) => IN_FLIGHT.includes(job.stage);
export const active = (job: Pick<TrayJob, "stage">) => inFlight(job) || job.stage === "held";

const clean = (text: string | null | undefined) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "");
/** A row's own error, when it is short and names no vendor; else the product's sentence for its kind. */
function reasonFor(error: string | null | undefined, params: unknown): string {
  const kind = failureKind(error, params);
  const own = clean(error);
  if (kind === "unknown" && own && own.length <= 160 && !vendorNameIn(own)) return own;
  return failureCopy(kind).why;
}
const mediaOf = (kind: string | null | undefined, id: string | null | undefined) =>
  id && (kind === "image" || kind === "video") ? `/api/media/${encodeURIComponent(id)}` : null;
const kindOf = (value: unknown): TrayJob["kind"] => (value === "video" || value === "image" || value === "audio" ? value : "other");
const RECIPE_KEYS = ["rawPrompt", "task", "workflow", "references", "ratio", "resolution", "duration"] as const;

/* ── Rows from Particl's own engines (the generations table) ─────────── */

/** The fields of a stored take the tray reads (lib/jobs `Generation`, already made safe for the browser). */
export type EngineRow = {
  id: string; kind: string; model: string; prompt: string; title: string | null; status: string;
  params: Record<string, unknown>; storedUrl: string | null; error: string | null;
  creditsBilled: number | null; costUsd: number | null;
  shotCode: string | null; shotTitle: string | null; task: string; createdAt: number; updatedAt: number;
  projectName: string | null;
};
/** Priced on the server (the estimate needs the rate table, which never reaches the browser). */
export type EnginePricing = { unit: "cr" | "usd"; inFlight: number | null; heldNeeds: number | null };

export function engineTrayJob(row: EngineRow, pricing: EnginePricing, draftId: string | null = null): TrayJob {
  const params = row.params ?? {};
  const held = (params.held ?? null) as { why?: string } | null;
  const shot = row.shotCode ? [row.shotCode, row.shotTitle].filter(Boolean).join(" · ") : "";
  const words = clean(typeof params.rawPrompt === "string" && params.rawPrompt ? params.rawPrompt : row.prompt);
  const name = clean(row.title) || shot || (words ? shortName(words, 60) : "") || "Untitled take";
  const unbilled = !((row.creditsBilled ?? 0) > 0) && !((row.costUsd ?? 0) > 0);
  const spent = pricing.unit === "cr" ? row.creditsBilled : row.costUsd;
  const base = {
    id: row.id, source: "engine" as const, kind: kindOf(row.kind), name, mediaUrl: null, reason: null, progress: null,
    createdAt: row.createdAt, updatedAt: row.updatedAt, draftId, projectName: row.projectName, action: null, recipe: null,
  };
  const price = (amount: number | null | undefined): TrayPrice | null =>
    typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? { amount, unit: pricing.unit } : null;
  switch (row.status) {
    case "succeeded":
      return { ...base, stage: "complete", label: "Complete", tone: "green", mediaUrl: row.storedUrl ? mediaOf(row.kind, row.id) : null, price: price(spent), action: "open" };
    case "failed":
    case "cancelled": {
      const recipe: TrayRecipe = {
        prompt: row.prompt, model: row.model, kind: row.kind, title: row.title, task: row.task,
        params: Object.fromEntries(RECIPE_KEYS.filter((k) => params[k] !== undefined).map((k) => [k, params[k]])),
      };
      return {
        ...base, stage: "failed", tone: "red",
        label: `${row.status === "cancelled" ? "Cancelled" : "Failed"}${unbilled ? " · not billed" : ""}`,
        reason: row.status === "cancelled" ? null : reasonFor(row.error, params),
        price: unbilled ? null : price(spent), action: "recreate", recipe,
      };
    }
    case "held": {
      /* A take held for a slot starts on its own; one held for credits waits for a Release (or a top-up). */
      if (held?.why === "slots")
        return { ...base, stage: "queued", label: "Held · waiting for a slot", tone: "amber", price: price(pricing.inFlight) };
      const needs = pricing.heldNeeds;
      const refused = clean(row.error);
      return {
        ...base, stage: "held", tone: "amber",
        label: needs && pricing.unit === "cr" ? `Held · needs ${needs.toLocaleString("en-US")} cr` : "Held · needs credits",
        reason: refused && !vendorNameIn(refused) ? refused : null,
        price: price(needs ?? pricing.inFlight), action: "release",
      };
    }
    case "running":
      return { ...base, stage: "rendering", label: "Rendering", tone: "blue", price: price(pricing.inFlight) };
    default:
      return { ...base, stage: "queued", label: "Queued", tone: "blue", price: price(pricing.inFlight) };
  }
}

/* ── Rows from the connected account (higgsfield_consumer_jobs) ──────── */

/** The columns the route reads — never the payload, receipt or grant themselves. */
export type AccountRow = {
  id: string; draftId: string; workflow: string; status: string; quoteCredits: number;
  failureCode: string | null; createdAt: number; updatedAt: number;
  hasReceipt: boolean; setAside: boolean;
  prompt: string | null; composer: string | null; modelId: string | null; outputType: string | null; toolLabel: string | null;
  originalId: string | null; originalKind: string | null; projectName: string | null;
};

const WORKFLOW_NAME: Record<string, string> = {
  genjutsu: "Motion transfer", "marketing-video": "Ad", "marketing-template": "Ad template", "voice-tool": "Voice",
  shorts: "Short", "reference-match": "Reference match", virality: "Viral check", generation: "Take",
};

export function accountTrayJob(row: AccountRow): TrayJob {
  const job = { status: row.status, providerReceipt: row.hasReceipt ? true : undefined, setAside: row.setAside, failureCode: row.failureCode };
  const following = canProgress(job) && !row.setAside;
  const phase = resumePhase(job, following);
  const words = clean(row.prompt);
  const name = words ? shortName(words, 60) : clean(row.toolLabel) || WORKFLOW_NAME[row.workflow] || "Take";
  const kind = kindOf(row.originalKind ?? row.outputType ?? (row.workflow === "genjutsu" || row.workflow.startsWith("marketing") || row.workflow === "shorts" ? "video" : row.workflow === "voice-tool" ? "audio" : null));
  const base = {
    id: row.id, source: "account" as const, kind, name, mediaUrl: null, reason: null, progress: null,
    createdAt: row.createdAt, updatedAt: row.updatedAt, draftId: row.draftId, projectName: row.projectName,
    price: row.quoteCredits > 0 ? { amount: row.quoteCredits, unit: "account-cr" as const } : null, action: null, recipe: null,
  };
  switch (row.status) {
    case "completed":
      return { ...base, stage: "complete", label: "Complete", tone: "green", mediaUrl: mediaOf(row.originalKind, row.originalId), action: "open" };
    case "failed": {
      const kept = row.failureCode === "invalid_result";
      const action: TrayAction | null = row.workflow === "generation" && row.modelId && words ? "recreate"
        : row.workflow === "genjutsu" ? "viral" : row.workflow.startsWith("marketing") ? "business" : null;
      return {
        ...base, stage: "failed", label: phase.label, tone: "red",
        reason: kept ? "The account finished it, but the result could not be kept. Its receipt is saved." : "The connected account could not make it. Failed runs are not billed.",
        /* Refused by the account: nothing was billed. Finished but not kept: the approved figure stands. */
        price: kept ? base.price : null, action,
        recipe: action === "recreate" ? { prompt: row.prompt ?? "", model: row.modelId!, kind: row.outputType ?? "video", title: null, task: null, params: {}, connected: true } : null,
      };
    }
    case "accepted":
      return following ? { ...base, stage: "rendering", label: "Rendering", tone: "blue" } : { ...base, stage: "unconfirmed", label: phase.label, tone: "amber" };
    default:
      /* Sent, or maybe sent, with no answer yet: confirmed on the next read that can move it, never sent twice. */
      return following ? { ...base, stage: "confirming", label: phase.label, tone: "amber" } : { ...base, stage: "unconfirmed", label: phase.label, tone: "amber" };
  }
}

/* ── The browser: order, count, and the composer's own submit ───────── */

const STAGES: ReadonlySet<string> = new Set(["submitting", "queued", "rendering", "confirming", "held", "complete", "failed", "unconfirmed"]);
const KINDS: ReadonlySet<string> = new Set(["video", "image", "audio", "other"]);
const TONES: ReadonlySet<string> = new Set(["blue", "amber", "green", "red"]);
const ACTIONS: ReadonlySet<string> = new Set(["open", "release", "recreate", "business", "viral"]);
const UNITS: ReadonlySet<string> = new Set(["cr", "usd", "account-cr"]);
/**
 * The route's reply, checked row by row: a row missing a field the tray draws
 * is dropped, an unknown kind, tone or action falls back to a plain one, and
 * only Particl's own media path is ever put in a thumbnail. No jobs list, no
 * reply.
 */
export function parseTrayReply(value: unknown): TrayReply | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as TrayReply).jobs)) return null;
  const reply = value as TrayReply;
  const jobs = reply.jobs.flatMap((job): TrayJob[] => {
    if (!job || typeof job !== "object" || typeof job.id !== "string" || !job.id || typeof job.name !== "string" || !STAGES.has(job.stage)
      || typeof job.label !== "string" || !Number.isFinite(job.createdAt) || !Number.isFinite(job.updatedAt)) return [];
    const price = job.price && typeof job.price === "object" && Number.isFinite(job.price.amount) && UNITS.has(job.price.unit) ? job.price : null;
    return [{
      ...job,
      kind: KINDS.has(job.kind) ? job.kind : "other",
      tone: TONES.has(job.tone) ? job.tone : "blue",
      action: job.action && ACTIONS.has(job.action) ? job.action : null,
      price,
      mediaUrl: typeof job.mediaUrl === "string" && job.mediaUrl.startsWith("/api/media/") ? job.mediaUrl : null,
      progress: typeof job.progress === "number" && job.progress >= 0 && job.progress <= 1 ? job.progress : null,
      reason: typeof job.reason === "string" ? job.reason : null,
      draftId: typeof job.draftId === "string" ? job.draftId : null,
      projectName: typeof job.projectName === "string" ? job.projectName : null,
    }];
  });
  return { jobs, pollAfterSeconds: Number(reply.pollAfterSeconds) || TRAY_IDLE_POLL_S, ...(reply.partial ? { partial: true } : {}) };
}

const RANK: Record<TrayStage, number> = { held: 0, submitting: 1, rendering: 1, confirming: 1, queued: 2, unconfirmed: 3, failed: 4, complete: 4 };
/** Held first (it waits on you), then what runs, newest first; then what finished, latest first. */
export function trayOrder(jobs: readonly TrayJob[]): TrayJob[] {
  const seen = new Set<string>();
  return jobs.filter((job) => (seen.has(job.id) ? false : (seen.add(job.id), true)))
    .sort((a, b) => RANK[a.stage] - RANK[b.stage] || (RANK[a.stage] >= 4 ? b.updatedAt - a.updatedAt : b.createdAt - a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, TRAY_LIMIT);
}

/** The composer's job as the shell's strip shows it (lib/workspace/types `Generation`). */
export type ComposerSlot = { id: string; name: string; label?: string; tone?: "blue" | "green" | "red" } | null;
/**
 * The composer publishes its job the moment Generate is pressed, before the
 * server has a row for it (and before the next read brings that row). Until
 * then it is shown from the composer's own words; once the read has it, the
 * read's row wins.
 */
export function withComposerSlot(jobs: readonly TrayJob[], slot: ComposerSlot, now: number): TrayJob[] {
  if (!slot || jobs.some((job) => job.id === slot.id)) return [...jobs];
  const pending = slot.id.startsWith("pending:");
  const label = slot.label ?? (pending ? "Submitting" : "Rendering");
  const stage: TrayStage = slot.tone === "green" ? "complete" : slot.tone === "red" ? "failed" : pending || /^submitting/i.test(label) ? "submitting" : /^queued/i.test(label) ? "queued" : /^held/i.test(label) ? "held" : "rendering";
  const tone: TrayTone = slot.tone === "green" ? "green" : slot.tone === "red" ? "red" : stage === "held" ? "amber" : "blue";
  return [{
    id: slot.id, source: "engine", kind: "other", name: slot.name || "New take", mediaUrl: null, stage, label, tone, reason: null, progress: null,
    createdAt: now, updatedAt: now, price: null, draftId: null, projectName: null, action: null, recipe: null,
  }, ...jobs];
}

export type TraySummary = { rendering: number; held: number; done: number; failed: number; text: string; short: string; tone: TrayTone };
/**
 * The header pill: what runs and what waits on you ("3 rendering · 1 held");
 * with nothing running, what finished since the tray was last opened
 * ("2 done · 1 failed"). Null when there is nothing to say.
 */
export function traySummary(jobs: readonly TrayJob[], seenAt: number): TraySummary | null {
  const rendering = jobs.filter(inFlight).length;
  const held = jobs.filter((job) => job.stage === "held").length;
  const done = jobs.filter((job) => job.stage === "complete" && job.updatedAt > seenAt).length;
  const failed = jobs.filter((job) => job.stage === "failed" && job.updatedAt > seenAt).length;
  const parts = rendering || held
    ? [rendering ? `${rendering} rendering` : null, held ? `${held} held` : null]
    : [done ? `${done} done` : null, failed ? `${failed} failed` : null];
  const text = parts.filter(Boolean).join(" · ");
  if (!text) return null;
  /* The phone's pill has room for one figure: how many jobs it is about (its name says which). */
  const short = String(rendering || held ? rendering + held : done + failed);
  const tone: TrayTone = rendering ? "blue" : held ? "amber" : failed ? "red" : "green";
  return { rendering, held, done, failed, text, short, tone };
}

export const ACTION_LABEL: Record<TrayAction, string> = { open: "Open in Takes", release: "Release", recreate: "Recreate", business: "Open Business", viral: "Open Viral" };

/** "13 cr", "$0.84"; a connected job's figure is the account's own credits, said so ("40 connected cr"), never the workspace's. */
export function priceLabel(price: TrayPrice | null): string | null {
  if (!price) return null;
  if (price.unit === "usd") return `$${price.amount.toFixed(2)}`;
  return `${Math.round(price.amount).toLocaleString("en-US")} ${price.unit === "account-cr" ? "connected cr" : "cr"}`;
}

/** "just now", "4 min", "2 h", "3 d" since it was made (the resumed rows' own clock). */
export const trayAge = resumeAge;
