"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import LazyMedia from "@/components/LazyMedia";
import { useDraft } from "@/lib/useDraft";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { GenjutsuVariant } from "@/lib/genjutsuTypes";
import { usePlanRequest } from "@/lib/workspace/atomik-host";
import { mediaBands } from "@/lib/workspace/format";
import { useProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import {
  EMPTY_CREATIVE,
  FORM_QUOTE_NOTE,
  FORM_RESOLUTIONS,
  estimateAction,
  formBlocked,
  formDraftKey,
  formInput,
  formQuote,
  formQuoteAttemptKey,
  formQuoteLabel,
  formSummary,
  readFormCreative,
  readQuoteAttempt,
  refFromTake,
  takeEstimate,
  withoutReference,
  withReference,
  writeFormCreative,
  type FormJob,
  type FormResolution,
  type QuoteAttempt,
  type StoredAttempt,
} from "@/lib/workspace/mobile-form";
import { usePublishPrimary } from "@/lib/workspace/mobile-primary";
import { useWorkspace } from "@/lib/workspace/state";
import type { PageId } from "@/lib/workspace/types";
import { MobileRing, RING } from "../MobileRing";
import type { MobilePageProps } from "../screens/registry";
import "@/app/workspace-assets.css";

/**
 * Form (05-mobile, template 6): the source video card, the ordered reference
 * strip, the prompt, the resolution segmented and the live-quote card.
 *
 * Both pages edit the SAME composition the desktop form holds — the shared
 * `subatomik-consumer:<project>:<variant>` draft — and read the SAME quote, the
 * connected account's own, from the saved jobs of the transform endpoint. The
 * staleness rule is kept literally (lib/workspace/mobile-form.ts): a missing,
 * changed, expired or already-submitted quote blocks submission and the pinned
 * primary says which.
 *
 * The phone does NOT hold a second copy of the paid path. What it composes is
 * published as the page's plan request — exactly as
 * components/workspace/spec/tools/SubatomikTool.tsx publishes it on the desktop
 * — so the dispatch is the plan's, at its own approval gate, with the exact
 * figure on the button.
 */

const VARIANT: Partial<Record<PageId, GenjutsuVariant>> = { motion: "motion-transfer", swap: "object-swap" };
const KEY: Partial<Record<PageId, "motion" | "swap">> = { motion: "motion", swap: "swap" };
const ENDPOINT = "/api/higgsfield/consumer/genjutsu";

type Connection = { connected: boolean } | null;
type TransformRead = { key: string; jobs: FormJob[]; connection: Connection; error: string | null };

/** One read of the endpoint's own GET: the saved jobs and the connection. */
async function readTransform(request: (url: string, init?: RequestInit) => Promise<Response>, scope: string, projectId: string): Promise<TransformRead> {
  const key = `${scope}:${projectId}`;
  try {
    const response = await request(`${ENDPOINT}?draftId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as
      | { jobs?: FormJob[]; connection?: { connected?: boolean; requiresReconnect?: boolean }; error?: string }
      | null;
    if (!response.ok || !body || !Array.isArray(body.jobs))
      return { key, jobs: [], connection: null, error: body?.error ?? "Saved transform jobs could not be read." };
    return {
      key,
      jobs: body.jobs,
      connection: { connected: body.connection?.connected === true && body.connection?.requiresReconnect !== true },
      error: null,
    };
  } catch {
    return { key, jobs: [], connection: null, error: "Saved transform jobs could not be read." };
  }
}

/** The saved jobs and the connection for this draft, re-read on demand. */
function useTransformJobs(scope: string, projectId: string | null) {
  const request = useScopedFetch(scope);
  const [state, setState] = useState<TransformRead | null>(null);
  const key = projectId ? `${scope}:${projectId}` : "";
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void readTransform(request, scope, projectId).then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [request, scope, projectId]);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    setState(await readTransform(request, scope, projectId));
  }, [request, scope, projectId]);
  const live = state && state.key === key ? state : null;
  return { jobs: live?.jobs ?? [], connection: live?.connection ?? null, error: live?.error ?? null, refresh };
}

/**
 * Taking the live estimate: the desktop's quote step (ConsumerGenjutsu `act("quote")`), with
 * its recovery record, so a lost answer is finished with the same key rather than copying
 * the originals twice. The record goes only when an estimate is in, or when the person
 * discards it, as on the desktop. It prices; it never submits.
 */
function useEstimate(scope: string, projectId: string | null, refresh: () => Promise<void>) {
  const request = useScopedFetch(scope);
  const storageKey = projectId ? formQuoteAttemptKey(scope, projectId) : null;
  /* The browser's record, read as a store: nothing on the server, and every write here announces itself. */
  const raw = useSyncExternalStore(
    subscribeAttempts,
    () => {
      if (!storageKey) return null;
      try { return window.localStorage.getItem(storageKey); } catch { return STORAGE_OFF; }
    },
    () => null,
  );
  const stored: StoredAttempt = useMemo(() => (raw === STORAGE_OFF ? "unavailable" : readQuoteAttempt(raw)), [raw]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback((value: QuoteAttempt | null) => {
    if (!storageKey) throw new Error("No project is open.");
    if (value) window.localStorage.setItem(storageKey, JSON.stringify(value));
    else window.localStorage.removeItem(storageKey);
    window.dispatchEvent(new Event(ATTEMPT_EVENT));
  }, [storageKey]);
  const take = useCallback(async (attempt: QuoteAttempt) => {
    if (!projectId || !storageKey || busy) return;
    setError(null);
    setBusy(true);
    const result = await takeEstimate(projectId, attempt, {
      save,
      post: async (body) => {
        const response = await request(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
        return { ok: response.ok, error: typeof data?.error === "string" ? data.error : null };
      },
    });
    setBusy(false);
    if (result.ok) await refresh();
    else setError(result.error);
  }, [projectId, storageKey, busy, save, request, refresh]);
  /* The desktop's "Discard unsubmitted quote request": the person lets the lock go, knowing a new estimate may copy again. */
  const discard = useCallback(() => {
    if (busy) return;
    try { save(null); setError(null); }
    catch { setError("This browser would not clear the saved request. It stays locked."); }
  }, [busy, save]);
  return { stored, busy, error, take, discard };
}

const ATTEMPT_EVENT = "particl-form-quote-attempt";
/** The snapshot when this browser refuses site data: not a record, and not "none". */
const STORAGE_OFF = "\u0000storage-off";
function subscribeAttempts(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(ATTEMPT_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(ATTEMPT_EVENT, listener);
  };
}

function Flat({ id }: { id: string }) {
  const [c1, c2] = mediaBands(id);
  return (
    <span className="pxm-flat" aria-hidden="true">
      <span className="pxm-card-band-a" style={{ background: c1 }} />
      <span className="pxm-card-band-b" style={{ background: c2 }} />
    </span>
  );
}

export function FormPage({ page, project, scope }: MobilePageProps) {
  const ws = useWorkspace();
  const variant = VARIANT[page] ?? "motion-transfer";
  const projectId = project?.id ?? null;
  const draft = useDraft<Record<string, unknown>>(formDraftKey(projectId ?? "none", variant), writeFormCreative(EMPTY_CREATIVE));
  const creative = useMemo(() => readFormCreative(draft.value), [draft.value]);
  const library = useProjectLibrary(scope, projectId);
  const transform = useTransformJobs(scope, projectId);
  const [picking, setPicking] = useState<"source" | "reference" | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /* A quote ages out on a clock, so the card and the button have to watch one. */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const request = useMemo(() => formInput(variant, creative), [variant, creative]);
  const quote = useMemo(() => formQuote(transform.jobs, request, now), [transform.jobs, request, now]);
  const estimate = useEstimate(scope, projectId, transform.refresh);
  const connected = transform.connection?.connected === true;
  const action = estimateAction({ request, quote, stored: estimate.stored, jobs: transform.jobs });
  const blocked = formBlocked({ projectOpen: !!project, connected: transform.connection ? transform.connection.connected : null, creative, request, quote });

  /* What the page's plan prices at its gate: the form's own body, and only
     once the form could send it — the desktop publishes exactly this. */
  const planKey = KEY[page] ?? "motion";
  const published = useMemo(() => {
    if (!request || quote.state !== "ready") return undefined;
    const { variant: _variant, ...rest } = request;
    void _variant;
    return rest as Record<string, unknown>;
  }, [request, quote.state]);
  usePlanRequest(planKey, published);

  const change = (next: Parameters<typeof writeFormCreative>[0]) => draft.set(writeFormCreative(next));

  /* The pinned primary carries the exact live figure and blocks on a stale one.
     Approving is the plan's gate: this button opens it, it never dispatches. */
  const refresh = transform.refresh;
  usePublishPrimary(
    page,
    useMemo(
      () => ({
        label: "Submit",
        cost: quote.credits !== null ? formQuoteLabel(quote) : null,
        blocked,
        run: () => {
          /* Re-read the quote before anything opens: a price that moved while
             this screen sat open must block rather than travel to the gate. */
          void refresh();
          ws.setSheet("atomik");
        },
      }),
      [quote, blocked, refresh, ws],
    ),
  );

  const videos = library.items.filter((entry) => entry.media === "video");
  const images = library.items.filter((entry) => entry.media === "image");

  return (
    <div className="pxm-pad-x pxm-pad-top" data-template="form" data-testid="mobile-form">
      {transform.error ? <p className="pxm-note" role="alert">{transform.error}</p> : null}

      <div className="pxm-kicker pxm-form-kicker" data-functional-label="">SOURCE VIDEO</div>
      <button type="button" className="pxm-source" data-testid="mobile-form-source" onClick={() => setPicking(picking === "source" ? null : "source")}>
        <span className="pxm-source-media">{creative.source ? <Flat id={creative.source.id} /> : <Flat id={page} />}</span>
        <span className="pxm-grow">
          <span className="pxm-source-name">{creative.source ? creative.source.name : "Choose a source video"}</span>
          <span className="pxm-source-meta">
            {creative.source
              ? [creative.source.origin === "upload" ? "Your own original" : "A generation in this project", creative.source.seconds != null ? `${creative.source.seconds}s` : null]
                  .filter(Boolean)
                  .join(" · ")
              : "From this project’s own library"}
          </span>
        </span>
        <span className="pxm-chevron" aria-hidden="true">›</span>
      </button>
      {picking === "source" ? (
        <Picker
          entries={videos}
          empty="No video originals in this project yet. Upload one from Takes."
          onPick={(entry) => {
            change({ ...creative, source: refFromTake(entry.take, "video", null) });
            setPicking(null);
          }}
        />
      ) : null}

      <div className="pxm-group-head pxm-form-head">
        <span className="pxm-kicker" data-functional-label="">REFERENCES</span>
        <span className="pxm-group-note">{formSummary(creative)}</span>
      </div>
      <div className="pxm-ref-strip" data-testid="mobile-form-refs">
        {creative.references.map((ref, i) => (
          <button
            type="button"
            className="pxm-ref"
            key={`${ref.origin}:${ref.id}`}
            data-ref-id={ref.id}
            aria-label={`Remove ${ref.name} from position ${i + 1}`}
            onClick={() => change(withoutReference(creative, ref.id))}
          >
            <Flat id={ref.id} />
            <span className="pxm-ref-index" data-functional-label="">{String(i + 1).padStart(2, "0")}</span>
          </button>
        ))}
        <button type="button" className="pxm-ref pxm-ref-add" data-testid="mobile-form-add-ref" onClick={() => setPicking(picking === "reference" ? null : "reference")}>
          <span aria-hidden="true">+</span>
        </button>
      </div>
      <p className="pxm-form-note">Order is preserved on submission. These are your own originals — nothing is fetched at generation time.</p>
      {picking === "reference" ? (
        <Picker
          entries={images}
          empty="No image originals in this project yet. Upload some from Takes."
          onPick={(entry) => {
            change(withReference(creative, refFromTake(entry.take, "image", null)));
            setPicking(null);
          }}
        />
      ) : null}

      <div className="pxm-kicker pxm-form-kicker" data-functional-label="">CREATIVE DIRECTION</div>
      <textarea
        className="pxm-textarea"
        rows={4}
        data-testid="mobile-form-prompt"
        aria-label="Creative direction"
        value={creative.prompt}
        onChange={(event) => change({ ...creative, prompt: event.target.value })}
      />
      <p className="pxm-form-note">Optional. A starting point, not a provider preset.</p>

      <div className="pxm-kicker pxm-form-kicker" data-functional-label="">RESOLUTION</div>
      <div className="pxm-segmented" role="group" aria-label="Resolution">
        {FORM_RESOLUTIONS.map((option) => (
          <button
            type="button"
            key={option}
            className="pxm-seg"
            data-res={option}
            aria-pressed={creative.resolution === option}
            onClick={() => change({ ...creative, resolution: option as FormResolution })}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="pxm-quote" data-testid="mobile-form-quote" data-quote={quote.state}>
        <div className="pxm-quote-head">
          <span className="pxm-quote-label">Live quote</span>
          <span className="pxm-quote-figure" data-testid="mobile-form-quote-figure">{formQuoteLabel(quote)}</span>
        </div>
        {/* The card explains the price; the pinned bar says what to do. */}
        <p className="pxm-quote-note" data-testid="mobile-form-quote-note">{FORM_QUOTE_NOTE[quote.state]}</p>
        {connected && action.kind === "take" ? (
          <div className="pxm-pair">
            {/* The label says what pressing it does: the chosen originals go to the connected account to be priced. */}
            <button type="button" className="pxm-control" data-testid="mobile-form-estimate" disabled={estimate.busy} onClick={() => void estimate.take({ key: crypto.randomUUID(), input: action.input })}>
              {estimate.busy ? "Copying originals…" : "Copy originals · get estimate"}
            </button>
          </div>
        ) : null}
        {action.kind === "recover" || action.kind === "unreadable" ? (
          <>
            {action.kind === "unreadable" ? <p className="pxm-quote-note" role="note">The saved estimate request could not be read.</p> : null}
            <div className="pxm-pair" data-testid="mobile-form-estimate-recovery">
              {connected && action.kind === "recover" ? (
                <button type="button" className="pxm-control" data-testid="mobile-form-estimate" disabled={estimate.busy} onClick={() => void estimate.take(action.attempt)}>
                  {estimate.busy ? "Copying originals…" : "Finish the last estimate"}
                </button>
              ) : null}
              <button type="button" className="pxm-control" data-testid="mobile-form-estimate-discard" disabled={estimate.busy} onClick={estimate.discard}>
                Discard it
              </button>
            </div>
            <p className="pxm-quote-note" role="note">Originals already copied stay in the connected account; after discarding, a new estimate may copy them again.</p>
          </>
        ) : null}
        {connected && action.kind === "blocked" ? <p className="pxm-quote-note" role="note">{action.reason}</p> : null}
        {estimate.error ? <p className="pxm-note" role="alert" data-testid="mobile-form-estimate-error">{estimate.error}</p> : null}
      </div>
      {library.state.status !== "ready" ? (
        <p className="pxm-note" role="status">
          <MobileRing size={RING.card} beating color="var(--pxw-blue)" /> Reading this project’s originals…
        </p>
      ) : null}
    </div>
  );
}

/** Choosing from the project's own library: no upload path, no second picker. */
function Picker({ entries, empty, onPick }: { entries: LibraryEntry[]; empty: string; onPick: (entry: LibraryEntry) => void }) {
  const list = useRef<HTMLDivElement>(null);
  if (!entries.length) return <p className="pxm-empty">{empty}</p>;
  return (
    <div className="pxm-picker" ref={list} data-testid="mobile-form-picker">
      {entries.map((entry) => (
        <button type="button" className="pxm-picker-row" key={entry.take.id} data-pick={entry.take.id} onClick={() => onPick(entry)}>
          <span className="pxm-picker-media">
            {entry.url && (entry.media === "image" || entry.media === "video") ? (
              <LazyMedia url={entry.url} kind={entry.media} alt="" className="pxw-lazy" />
            ) : (
              <Flat id={entry.take.id} />
            )}
          </span>
          <span className="pxm-grow">
            <span className="pxm-picker-name">{entry.take.name}</span>
            <span className="pxm-picker-meta">{entry.take.meta}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
