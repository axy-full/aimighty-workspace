import {
  CONSUMER_GENJUTSU_RESOLUTIONS,
  consumerGenjutsuInputSchema,
  consumerMediaKey,
  type ConsumerGenjutsuInput,
} from "../higgsfield-consumer/genjutsu-contract";
import type { GenjutsuVariant } from "../genjutsuTypes";

/**
 * The phone's Form template (05-mobile: Motion Transfer and Object Swap) over
 * the SAME state the desktop form holds.
 *
 * The composition — source video, ordered image references, prompt, resolution
 * — is the draft `subatomik-consumer:<projectId>:<variant>` that
 * components/suites/ConsumerGenjutsu.tsx reads and writes (lib/useDraft.ts), so
 * the phone edits the desktop's form rather than a copy of it, and the request
 * it normalises is the one `consumerGenjutsuInputSchema` accepts.
 *
 * The QUOTE is the connected account's own, read from the saved jobs of
 * GET /api/higgsfield/consumer/genjutsu. Its staleness rule is the desktop's,
 * kept literally: a quote counts only while it is `quoted`, was taken for a
 * byte-identical input, has not expired and has not been attempted. Anything
 * else blocks submission — and the phone never runs the paid dispatch itself:
 * the page's Atomik plan prices this same request at its gate, which is the one
 * approval path (components/workspace/spec/tools/SubatomikTool.tsx).
 *
 * Everything here is pure so the blocking rule is unit-tested.
 */

export type FormResolution = ConsumerGenjutsuInput["resolution"];
export const FORM_RESOLUTIONS = CONSUMER_GENJUTSU_RESOLUTIONS;

/** The compact reference the shared draft stores. */
export type FormRef = {
  id: string;
  origin: "upload" | "generation";
  name: string;
  kind: "image" | "video";
  seconds: number | null;
};

export type FormCreative = {
  source: FormRef | null;
  /** Order is meaningful: it is preserved on submission. */
  references: FormRef[];
  prompt: string;
  resolution: FormResolution;
};

export const EMPTY_CREATIVE: FormCreative = { source: null, references: [], prompt: "", resolution: "720p" };

/** The draft key ConsumerGenjutsu uses, so both surfaces hold one composition. */
export const formDraftKey = (projectId: string, variant: GenjutsuVariant) => `subatomik-consumer:${projectId}:${variant}`;

const MEDIA_ID = /^[A-Za-z0-9_-]{1,160}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The desktop's own limits: 30 references, a 5,000-character prompt. */
export const REFERENCE_LIMIT = 30;
export const PROMPT_LIMIT = 5000;

function readRef(value: unknown, kind: "image" | "video"): FormRef | null {
  if (!object(value) || typeof value.id !== "string" || !MEDIA_ID.test(value.id)) return null;
  if (value.kind !== kind || !["upload", "generation"].includes(String(value.origin))) return null;
  return {
    id: value.id,
    origin: value.origin as FormRef["origin"],
    kind,
    name: typeof value.name === "string" ? value.name.slice(0, 160) : "Saved original",
    seconds: typeof value.seconds === "number" && Number.isFinite(value.seconds) ? value.seconds : null,
  };
}

/** Read the shared draft, exactly as ConsumerGenjutsu's `creative()` reads it. */
export function readFormCreative(value: unknown): FormCreative {
  if (!object(value)) return EMPTY_CREATIVE;
  const references = Array.isArray(value.references)
    ? value.references.map((item) => readRef(item, "image")).filter((item): item is FormRef => !!item)
    : [];
  return {
    source: readRef(value.source, "video"),
    references: [...new Map(references.map((item) => [`${item.origin}:${item.id}`, item])).values()].slice(0, REFERENCE_LIMIT),
    prompt: typeof value.prompt === "string" ? value.prompt.slice(0, PROMPT_LIMIT) : "",
    resolution: (CONSUMER_GENJUTSU_RESOLUTIONS as readonly string[]).includes(String(value.resolution))
      ? (value.resolution as FormResolution)
      : "720p",
  };
}

/** What the draft stores back: the compact shape, nothing more. */
export function writeFormCreative(creative: FormCreative): Record<string, unknown> {
  const compact = (ref: FormRef | null) =>
    ref ? { id: ref.id, origin: ref.origin, name: ref.name.slice(0, 80), kind: ref.kind, seconds: ref.seconds } : null;
  return {
    source: compact(creative.source),
    references: creative.references.map(compact),
    prompt: creative.prompt,
    resolution: creative.resolution,
  };
}

const identity = (ref: FormRef) => (ref.origin === "upload" ? { uploadId: ref.id } : { genId: ref.id });

/**
 * The request this form would send — the shape ConsumerGenjutsu normalises and
 * the shape the page's plan prices. Null while the form cannot send one.
 */
export function formInput(variant: GenjutsuVariant, creative: FormCreative): ConsumerGenjutsuInput | null {
  if (!creative.source) return null;
  const candidate = {
    variant,
    resolution: creative.resolution,
    prompt: creative.prompt,
    source: identity(creative.source),
    references: creative.references.map(identity),
  };
  const parsed = consumerGenjutsuInputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The saved job fields the quote rule reads (the endpoint's own shape). */
export type FormJob = {
  id: string;
  status: string;
  input: ConsumerGenjutsuInput;
  quoteCredits: number;
  quoteExpiresAt: number;
  quoteExpired?: boolean;
};

export type FormQuoteState = "none" | "changed" | "expired" | "attempted" | "ready";
export type FormQuote = {
  state: FormQuoteState;
  /** The exact connected-account figure, only when the quote is usable. */
  credits: number | null;
  /** When it ages out, so the card can say it. */
  expiresAt: number | null;
};

/**
 * Two requests are the same request when they name the same media in the same
 * order with the same settings. Compared canonically, because a quote comes back
 * from the server and the key order it serialises is not ours to depend on —
 * reference ORDER is, and stays significant.
 */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;

export const sameFormInput = (a: ConsumerGenjutsuInput, b: ConsumerGenjutsuInput) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sameInput = sameFormInput;

/**
 * The live quote for what the form currently holds.
 *
 * `changed` means a quote exists but was taken for a different composition —
 * the desktop's `matches` guard. `expired` is its `quoteExpiresAt > clock`
 * guard, `attempted` its submission-recovery guard. Only `ready` carries a
 * figure, so a stale quote cannot be printed on a button.
 */
export function formQuote(
  jobs: readonly FormJob[],
  input: ConsumerGenjutsuInput | null,
  now: number,
  attempted: readonly string[] = [],
): FormQuote {
  if (!input) return { state: "none", credits: null, expiresAt: null };
  const quoted = jobs.filter((job) => job.status === "quoted");
  if (!quoted.length) return { state: "none", credits: null, expiresAt: null };
  const mine = quoted.filter((job) => sameInput(job.input, input));
  if (!mine.length) return { state: "changed", credits: null, expiresAt: null };
  const newest = [...mine].sort((a, b) => b.quoteExpiresAt - a.quoteExpiresAt)[0];
  if (attempted.includes(newest.id)) return { state: "attempted", credits: null, expiresAt: newest.quoteExpiresAt };
  if (newest.quoteExpired === true || newest.quoteExpiresAt <= now)
    return { state: "expired", credits: null, expiresAt: newest.quoteExpiresAt };
  return { state: "ready", credits: newest.quoteCredits, expiresAt: newest.quoteExpiresAt };
}

/** What the live-quote card prints: the exact figure, or why there is none. */
export function formQuoteLabel(quote: FormQuote): string {
  return quote.state === "ready" && quote.credits !== null ? `${quote.credits.toLocaleString("en-US")} cr` : "—";
}

export const FORM_QUOTE_NOTE: Record<FormQuoteState, string> = {
  none: "No live estimate yet. A missing or stale estimate blocks submission.",
  changed: "This composition changed since the last estimate, so that price no longer applies.",
  expired: "The last estimate has aged out and must be taken again.",
  attempted: "This estimate was already submitted once; it will not be sent again.",
  ready: "Approved against this exact amount and wallet. A missing or stale estimate blocks submission.",
};

/**
 * What the pinned primary says when the quote is why it cannot run. The card
 * above explains the PRICE; this says what to do about it, so the two lines
 * carry different work rather than repeating one sentence twice.
 */
export const FORM_BLOCKED: Record<Exclude<FormQuoteState, "ready">, string> = {
  none: "Take a live estimate before submitting.",
  changed: "The composition changed — take a new estimate.",
  expired: "That estimate has aged out — take a new one.",
  attempted: "Already submitted once; take a new estimate to send it again.",
};

/**
 * Why the pinned primary cannot submit, or null when it can. The order is the
 * desktop's: the connection first, then the composition, then the quote.
 */
export function formBlocked(input: {
  projectOpen: boolean;
  /** The connected account answered, is connected and is not suspended. */
  connected: boolean | null;
  creative: FormCreative;
  request: ConsumerGenjutsuInput | null;
  quote: FormQuote;
}): string | null {
  if (!input.projectOpen) return "Open a project to use this page.";
  if (input.connected === null) return "Checking the connected account…";
  if (!input.connected) return "This needs a connected account. Connect one in Settings.";
  if (!input.creative.source) return "Choose a source video from this project.";
  if (!input.request) return "This composition is not one the engine accepts yet.";
  if (input.quote.state !== "ready") return FORM_BLOCKED[input.quote.state];
  return null;
}

/** "1080p · 4 ordered references" — the summary above the quote. */
export function formSummary(creative: FormCreative): string {
  const refs = creative.references.length;
  return [creative.resolution, `${refs.toLocaleString("en-US")} ordered ${refs === 1 ? "reference" : "references"}`].join(" · ");
}

/** Media identity for a library take: `generation:<id>` / `upload:<id>` split. */
export function refFromTake(take: { id: string; sourceId: string; kind: "GEN" | "UPLOAD"; name: string; meta: string }, kind: "image" | "video", seconds: number | null = null): FormRef {
  return { id: take.sourceId, origin: take.kind === "UPLOAD" ? "upload" : "generation", name: take.name, kind, seconds };
}

/** Distinct originals only: the schema refuses a repeated source. */
export function withReference(creative: FormCreative, ref: FormRef): FormCreative {
  const key = consumerMediaKey(identity(ref));
  const taken = [creative.source, ...creative.references].filter((item): item is FormRef => !!item).map((item) => consumerMediaKey(identity(item)));
  if (taken.includes(key) || creative.references.length >= REFERENCE_LIMIT) return creative;
  return { ...creative, references: [...creative.references, ref] };
}

export function withoutReference(creative: FormCreative, id: string): FormCreative {
  return { ...creative, references: creative.references.filter((item) => item.id !== id) };
}
