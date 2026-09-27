"use client";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { studioRequest, StudioRequestError } from "@/components/workbench/GenerationDialog";
import { DRAFT_RESOLUTION, FINAL_RESOLUTION, draftDate, draftState, type DraftState } from "@/lib/draftFinal";
import type { Generation } from "@/lib/jobs";
import { movedOn, poll } from "@/lib/poll";
import { draftFinalBody } from "@/lib/workbench/generation-request";
import { activeMediaJob } from "@/lib/workbench/job-recovery";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import { sendClaimedGeneration, settlePendingGeneration } from "@/lib/workspace/generate-submit";
import { refreshProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { neutralCopy } from "@/lib/workspace/rig";
import { useWorkspace } from "@/lib/workspace/state";
import { TakeStrip } from "./TakeStrip";

/**
 * A Seedance 2.5 draft and its 1080p final (lib/draftFinal.ts), drawn as ONE
 * strip — the batch strip's pattern — with the draft first, then its final(s).
 * Under the takes, what the draft offers next: its watermark and how long its
 * final can be made, then "Make the 1080p final · N cr", priced by a fresh
 * quote of exactly that final. Pressing it asks for approval first, saying what
 * the final keeps from the draft and that fine detail can differ; approving
 * quotes it once more and sends it only at the price approved, under a claimed
 * Idempotency-Key (settle-first: a lost reply is checked, never sent again).
 */

const FINE_DETAIL = "A new render at 1080p, without the watermark: framing and motion hold, and fine detail such as texture or small text can differ slightly.";
const KEPT = "Its prompt, references, length and shape come from this draft and can’t change.";

/** Whether a final's take cost this workspace anything, from what the browser is told (credits, or its own dollars). */
const charged = (g: Generation) => (g.creditsBilled == null && g.costUsd == null) || (g.creditsBilled ?? 0) > 0 || (g.costUsd ?? 0) > 0;
const viewOf = (draft: Generation, finals: readonly Generation[], now: number): DraftState =>
  draftState(draft, finals.map((f) => ({ id: f.id, status: f.status, charged: charged(f), createdAt: f.createdAt })), now);

type Quote = { credits: number; fingerprint: string };
const FINGERPRINT = /^[a-f0-9]{64}$/;

/** A fresh quote of exactly this final (POST /api/generate/quote): credits only, never a vendor figure. */
async function quoteFinal(scope: string, draft: Generation): Promise<Quote> {
  const fresh = await studioRequest<{ estimatedCredits?: unknown; fingerprint?: unknown }>("/api/generate/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
    body: JSON.stringify(draftFinalBody({ modelId: draft.model, draftId: draft.id })),
  });
  if (typeof fresh.estimatedCredits !== "number" || !Number.isInteger(fresh.estimatedCredits) || fresh.estimatedCredits < 0 || typeof fresh.fingerprint !== "string" || !FINGERPRINT.test(fresh.fingerprint))
    throw new Error("The final’s price could not be confirmed. Nothing was sent.");
  return { credits: fresh.estimatedCredits, fingerprint: fresh.fingerprint };
}

/** What a final's request became, said the way Gen says it. */
const LANDED = "Your last press of Make the final reached the server: that final is followed. Nothing new was sent.";

/**
 * The draft's next step: its state, and on a draft that can still make one,
 * the priced final with its approval. `actions: false` (Studio › Takes) says
 * where the pair stands and leaves the final to Gen and the Inspector.
 */
export function DraftFinalBar({ scope, projectId, draft, finals, actions = true }: {
  scope: string;
  /** The workbench project whose library holds the pair: re-read once the final is sent and once it lands. */
  projectId: string | null;
  draft: Generation;
  finals: readonly Generation[];
  actions?: boolean;
}) {
  const { toast } = useWorkspace();
  const [now, setNow] = useState(() => Date.now());
  /** A final sent from here that the library has not shown yet: followed all the same. */
  const [sent, setSent] = useState<string | null>(null);
  const [observed, setObserved] = useState<Generation | null>(null);
  const allFinals = observed && !finals.some((f) => f.id === observed.id) ? [...finals, observed] : finals;
  const known = sent && allFinals.some((f) => f.id === sent) ? null : sent;
  const view = known ? { state: "finalising" as const, finalId: known } : viewOf(draft, allFinals, now);
  const ready = view.state === "ready";
  const expiresAt = view.state === "ready" || view.state === "expired" ? view.expiresAt : null;

  /* The clock only matters while a final can still be made: the button turns into its reason at the cutoff. */
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [ready]);

  const [quote, setQuote] = useState<{ key: string; value: Quote } | null>(null);
  const [failed, setFailed] = useState<{ key: string; text: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [sending, setSending] = useState(false);
  const [asked, setAsked] = useState(0);
  const quoteKey = ready ? `${scope}:${draft.id}:${view.retry ?? ""}:${asked}` : "";
  const price = quote && quote.key === quoteKey ? quote.value : null;
  const problem = failed && failed.key === quoteKey ? failed.text : null;
  const pricing = actions && ready && !price && !problem;

  /* A fresh quote of the final whenever the draft can make one: the price on the button is exactly this final's. */
  useEffect(() => {
    if (!actions || !quoteKey) return;
    let live = true;
    quoteFinal(scope, draft)
      .then((value) => { if (live) setQuote({ key: quoteKey, value }); })
      .catch((error: unknown) => { if (live) setFailed({ key: quoteKey, text: neutralCopy(error instanceof Error ? error.message : "The final could not be priced.", "The final could not be priced.") }); });
    return () => { live = false; };
    /* `draft` is read for its id and model, which the key already names. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, quoteKey, scope]);

  /* A final on its way is followed to the end, here as anywhere it is shown; the library is read again when it lands. */
  const following = view.state === "finalising" ? view.finalId : null;
  useEffect(() => {
    if (!following) return;
    const moved = movedOn();
    const poller = poll({
      immediate: true,
      read: (signal) => studioRequest<{ generation: Generation }>(`/api/jobs/${encodeURIComponent(following)}`, { signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" }),
      moved: (data) => moved(following, data.generation.status),
      done: (data) => !activeMediaJob(data.generation),
      onValue: (data) => {
        if (activeMediaJob(data.generation)) return;
        setObserved(data.generation);
        if (projectId) void refreshProjectLibrary(scope, projectId);
        if (data.generation.status === "succeeded") toast("The 1080p final rendered. Filed in Takes beside its draft.");
      },
    });
    return () => poller.stop();
  }, [following, scope, projectId, toast]);

  const storageId = pendingGenerationKey(scope, projectId ?? "unfiled", `final:${draft.id}`);
  const panel = useRef<HTMLDivElement>(null);
  const makeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!approving || !ready) return;
    panel.current?.scrollIntoView({ block: "nearest" });
    panel.current?.querySelector<HTMLButtonElement>('[data-testid="draft-final-approve-send"]')?.focus({ preventScroll: true });
  }, [approving, ready]);

  const approve = async () => {
    if (!price || !ready) return;
    setSending(true);
    setNote(null);
    try {
      /* Settle first (lib/workspace/generate-submit.ts): a final whose reply was lost is followed, never sent again. */
      const earlier = await settlePendingGeneration({ scope, storageId });
      if (earlier.state === "landed") { setSent(earlier.jobId); setApproving(false); setNote(LANDED); if (projectId) void refreshProjectLibrary(scope, projectId); return; }
      if (earlier.state === "unknown") { setNote(earlier.reason); return; }
      /* It never arrived (and is set aside now), or it was refused: nothing was charged for it, and this press goes. */
      const before = earlier.state === "lost" ? "Your last press never reached the server, so nothing was charged for it. " : "";
      /* The approval is of this price: quoted again, and sent only if it still is. */
      const fresh = await quoteFinal(scope, draft);
      if (fresh.credits !== price.credits) {
        setQuote({ key: quoteKey, value: fresh });
        setNote(`${before}The price is now ${fresh.credits.toLocaleString("en-US")} cr. Approve again to make the final at that price.`);
        return;
      }
      const out = await sendClaimedGeneration({
        scope, storageId, credits: fresh.credits,
        body: draftFinalBody({ modelId: draft.model, draftId: draft.id, maxCredits: fresh.credits, quoteFingerprint: fresh.fingerprint }),
      });
      if (out.state === "queued") {
        setSent(out.jobId);
        setApproving(false);
        setNote(out.followed ? LANDED : out.status === "held" ? `${before}The final is held until credits or a slot free up. Nothing is charged until it runs.` : before.trim() || null);
        if (projectId) void refreshProjectLibrary(scope, projectId);
        return;
      }
      setApproving(false);
      setNote(`${before}${out.reason}`);
      /* Refused because the draft already has its final (another tab, another press): show that final. */
      if (projectId) void refreshProjectLibrary(scope, projectId);
    } catch (error) {
      setNote(neutralCopy(error instanceof StudioRequestError || error instanceof Error ? error.message : "The final could not be sent.", "The final’s status could not be confirmed. Check it before trying again."));
    } finally {
      setSending(false);
    }
  };

  const facts: string[] = [];
  if (draft.status === "succeeded") facts.push(`Watermarked ${DRAFT_RESOLUTION} draft`);
  if (view.state === "ready") facts.push(`Final available until ${draftDate(view.expiresAt)}`);
  const statusId = useId();
  const status = view.state === "rendering" ? "Rendering the draft…"
    : view.state === "failed" ? "The draft did not render, so it has no final to make."
    : view.state === "expired" ? `This draft expired on ${draftDate(expiresAt!)}: a final can only be made within seven days of its draft.`
    : view.state === "finalising" ? `Making the ${FINAL_RESOLUTION} final…`
    : view.state === "finalFailed" ? "The final did not render. Another final is unavailable for this draft; review the take’s status."
    : view.state === "final" ? `The ${FINAL_RESOLUTION} final is made, without the watermark.`
    : view.retry ? "The last final did not render. Nothing was charged for it." : null;

  return (
    <div className="gx-draft-bar" data-testid="draft-final" data-state={view.state} data-draft-id={draft.id}>
      {facts.length ? <p className="gx-draft-facts" data-testid="draft-final-facts">{facts.join(" · ")}</p> : null}
      {status ? <p className="gx-draft-status" id={statusId} data-tone={view.state === "expired" || view.state === "failed" || view.state === "finalFailed" ? "red" : view.state === "final" ? "green" : undefined} data-testid="draft-final-status">{status}</p> : null}
      {actions && (view.state === "ready" || view.state === "expired") && !approving ? (
        <button ref={makeButton} type="button" className="gx-primary gx-gen-go gx-draft-go" disabled={view.state === "expired" || !price || sending}
          aria-describedby={view.state === "expired" ? statusId : undefined} data-priced={price && view.state === "ready" ? "" : undefined}
          onClick={() => { setNote(null); setApproving(true); }} data-testid="draft-final-make"
          aria-label={view.state === "ready" && price ? `Make the ${FINAL_RESOLUTION} final · ${price.credits.toLocaleString("en-US")} cr` : `Make the ${FINAL_RESOLUTION} final`}>
          <span className="gx-go-act">{pricing ? `Pricing the ${FINAL_RESOLUTION} final…` : `Make the ${FINAL_RESOLUTION} final`}</span>
          {view.state === "ready" && price ? <span className="gx-go-price"><span className="gx-go-sep">{" · "}</span>{price.credits.toLocaleString("en-US")} cr</span> : null}
        </button>
      ) : null}
      {actions && ready && problem && !approving ? (
        <div className="gx-draft-row">
          <p className="gx-draft-status" data-tone="red" role="alert">{problem}</p>
          <button type="button" className="gx-hbtn" onClick={() => setAsked((n) => n + 1)} data-testid="draft-final-requote">Try again</button>
        </div>
      ) : null}
      {actions && ready && approving && price ? (
        <div className="gx-draft-approve" ref={panel} role="group" aria-label={`Approve the ${FINAL_RESOLUTION} final`} data-testid="draft-final-approve">
          <p className="gx-draft-approve-title">Make the {FINAL_RESOLUTION} final from this draft?</p>
          <ul className="gx-draft-approve-list">
            <li>{KEPT}</li>
            <li>{FINE_DETAIL}</li>
          </ul>
          <div className="gx-draft-row">
            <button type="button" className="gx-primary gx-gen-go gx-draft-go" disabled={sending} data-priced={sending ? undefined : ""} onClick={() => void approve()} data-testid="draft-final-approve-send"
              aria-label={sending ? "Sending…" : `Approve · ${price.credits.toLocaleString("en-US")} cr`}>
              {sending ? "Sending…" : <><span className="gx-go-act">Approve</span><span className="gx-go-price"><span className="gx-go-sep">{" · "}</span>{price.credits.toLocaleString("en-US")} cr</span></>}
            </button>
            <button type="button" className="gx-hbtn" disabled={sending} onClick={() => { setApproving(false); setNote(null); requestAnimationFrame(() => makeButton.current?.focus({ preventScroll: true })); }} data-testid="draft-final-cancel">Cancel</button>
          </div>
        </div>
      ) : null}
      {note ? <p className="gx-draft-status" role="status" data-testid="draft-final-note">{note}</p> : null}
    </div>
  );
}

/** A draft or final tile's status line, in the strip's own words. */
function pairStatus(entry: LibraryEntry, role: "draft" | "final"): { text: string; tone: "blue" | "green" | "red" | "amber" | undefined } {
  const g = entry.asset.origin === "generation" ? entry.asset.value : null;
  if (!g) return { text: "", tone: undefined };
  if (g.status === "failed" || g.status === "cancelled")
    return { text: entry.take.failedUnbilled ? "Failed · not charged" : "Failed", tone: "red" };
  if (g.status === "held") return { text: "Held", tone: "amber" };
  if (g.status !== "succeeded") return { text: g.status === "queued" ? "Queued" : "Rendering", tone: "blue" };
  return { text: role === "draft" ? "Watermarked" : "No watermark", tone: role === "final" ? "green" : undefined };
}

/**
 * A draft and the finals made from it as one strip: "draft · 480p", then each
 * "final · 1080p", each tile the caller's own (`tile`), and the draft's next
 * step under them (DraftFinalBar).
 */
export function DraftStrip({ scope, projectId, draft, finals, tile, testId, actions = true, plain = false }: {
  scope: string;
  projectId: string | null;
  draft: LibraryEntry;
  finals: readonly LibraryEntry[];
  /** The caller's tile for one take, with the label and status line the strip gives it. */
  tile: (entry: LibraryEntry, label: string, status: { text: string; tone: "blue" | "green" | "red" | "amber" | undefined }) => ReactNode;
  testId: string;
  actions?: boolean;
  plain?: boolean;
}) {
  const draftGen = draft.asset.value as Generation;
  /* Finals newest first after their draft: the one that stands leads. */
  const ordered = useMemo(() => [...finals].sort((a, b) => b.take.createdAt - a.take.createdAt), [finals]);
  const finalGens = useMemo(() => ordered.map((f) => f.asset.value as Generation), [ordered]);
  const billed = [draft, ...ordered].map((e) => e.take.credits);
  const settled = billed.every((c) => typeof c === "number") ? `${billed.reduce((s: number, c) => s + (c ?? 0), 0).toLocaleString("en-US")} cr settled` : null;
  const live = [draft, ...ordered].some((e) => e.take.status === "rendering");
  return (
    <TakeStrip batchId={`draft:${draftGen.id}`} testId={testId} state={live ? "live" : "done"} plain={plain}
      label={ordered.length ? `draft → final` : "draft"} name={draft.take.name} meta={settled}
      foot={<DraftFinalBar scope={scope} projectId={projectId} draft={draftGen} finals={finalGens} actions={actions} />}>
      {tile(draft, `draft · ${DRAFT_RESOLUTION}`, pairStatus(draft, "draft"))}
      {ordered.map((f) => tile(f, `final · ${FINAL_RESOLUTION}`, pairStatus(f, "final")))}
    </TakeStrip>
  );
}
