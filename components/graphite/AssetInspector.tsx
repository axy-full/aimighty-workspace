"use client";
import { useRef, useState } from "react";
import { SAY, referenceRole } from "@/lib/shell/assets";
import { recipePrompt, recreateBlock } from "@/lib/shell/recipe";
import { useShell } from "@/lib/shell/state";
import { formatProviderCreditQuote, providerCreditQuote } from "@/lib/providerCreditQuote";
import { settledFact } from "@/lib/usageLedgerTerms";
import { useLedgerEntry } from "./UsageLedger";
import { useRecreate } from "@/lib/shell/use-asset-actions";
import type { Project } from "@/lib/workbench/studio";
import { entryDraft, entryFace, useProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { takeStatusWord } from "@/lib/workspace/takes";
import { billingSentence, failureLine } from "@/lib/errors";
import type { TakeFailure } from "@/lib/providerOutcome";
import type { Generation } from "@/lib/jobs";
import { DraftFinalBar } from "./DraftFinal";
import { useWorkspace } from "@/lib/workspace/state";
import { entryPreview, previewAttrs } from "@/lib/preview";
import { openPreview } from "@/components/PreviewLayer";
import { LoadBanner } from "./TakeTile";
import { ReleaseTake } from "./ReleaseTake";

/**
 * The Inspector for an asset (FINAL_SPEC §1 step 1, §6 › Inspector): a fixed
 * 180px preview card, provenance — where it came from, what it cost, what it
 * is — and the actions the right-click menu offers, as buttons. Every action
 * is the shell's own (the context-menu command path), so the two never drift.
 */
const bytesLabel = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const when = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function AssetInspector({ scope, project, id }: { scope: string; project: Project | null; id: string }) {
  const shell = useShell();
  const { dispatch, state, toast } = useWorkspace();
  const recreate = useRecreate();
  const library = useProjectLibrary(scope, project?.id ?? null);
  const entry = library.items.find((item) => item.take.id === id) ?? null;
  /* "Settled" is the usage ledger's own row for the take, in the unit the route says this workspace pays in (idea 25). */
  const made = entry?.asset.origin === "generation" ? entry.asset.value : null;
  const quote = made ? providerCreditQuote(made.providerCreditQuote) : null;
  const settled = useLedgerEntry(made && !quote ? made.id : null, entry?.take.status);
  if (!entry) {
    const failed = library.state.status === "error";
    return (
      <div className="gx-insp-asset"><span className="gx-eyebrow">Output</span><div className="gx-insp-card" aria-hidden="true" />
        {failed
          ? <LoadBanner banner={{ tone: "error", message: library.state.error ?? "The project library could not be loaded." }} onRetry={library.refresh} testId="inspector-library-error" compact />
          : <p className="gx-empty">{library.state.status === "ready" && !library.state.moreBusy ? "This asset is no longer in the project." : "Reading this project…"}</p>}
      </div>
    );
  }
  const { take, asset } = entry;
  const generation = asset.origin === "generation" ? asset.value : null;
  const upload = asset.origin === "upload" ? asset.value : null;
  const role = referenceRole(entry.media);
  /* Draft mode (lib/draftFinal.ts): a draft offers its final here too; a final names the draft it was made from. */
  const pair = generation ? entryDraft(entry) : null;
  const finals = pair?.draft ? library.items.filter((item) => entryDraft(item)?.finalOf === pair.id).map((item) => item.asset.value as Generation) : [];
  const madeFrom = pair?.finalOf ? library.items.find((item) => item.asset.origin === "generation" && item.asset.value.id === pair.finalOf)?.take.name ?? "Its draft" : null;
  const facts: [string, string][] = [
    ...(madeFrom ? [["Made from", `${madeFrom} · draft`] as [string, string]] : []),
    ["Kind", generation ? "Generation" : "Upload"],
    /* A take held at zero has reserved nothing: the ledger has no row for it until Release charges it at admission (then "Held · N cr"). */
    ...(generation ? [["Engine", generation.model] as [string, string], ["Prompt", generation.prompt ? generation.prompt.slice(0, 160) : "—"] as [string, string], ["Made", when(generation.createdAt)] as [string, string], ["Settled", take.status === "held" ? "Nothing charged yet" : settledFact(settled.page, quote ? formatProviderCreditQuote(quote) : null, settled.failed)] as [string, string]] : []),
    ...(upload ? [["File", upload.filename] as [string, string], ["Type", upload.mime] as [string, string], ["Size", bytesLabel(upload.bytes)] as [string, string], ...(upload.width && upload.height ? [["Pixels", `${upload.width}×${upload.height}`] as [string, string]] : []), ["Uploaded", when(upload.createdAt)] as [string, string], ["Integrity", upload.sha256 ? "sha256 ✓" : "—"] as [string, string]] : []),
    ...(generation && typeof generation.params.enhancedPrompt === "string" && generation.params.enhancedPrompt ? [["Enhanced", `${generation.params.enhancedPrompt.slice(0, 160)} · on the account`] as [string, string]] : []),
    ...(take.meta ? [["Detail", take.meta] as [string, string]] : []),
    ["Status", takeStatusWord(take)],
    /* Why it failed or waits, in the row's own words when they say more. */
    ...(take.reason ? [["Reason", take.detail ? `${take.reason} · ${take.detail}` : take.reason] as [string, string]] : []),
    /* What its provider did with the charge, where it billed the workspace's own key or account (Particl's own charge is "Settled" above), and the next step. */
    ...(take.failure ? failureFacts(take.failure, take.cancelled === true) : []),
  ];
  const download = generation ? `/api/media/${encodeURIComponent(generation.id)}?download=1` : `/api/uploads/${encodeURIComponent(upload!.id)}?download=1`;
  const downloadable = upload || (generation?.status === "succeeded" && generation.storedUrl);
  const command = (cmd: "use-as-reference" | "retry" | "move" | "delete" | "copy" | "cut") => shell.runCommand?.(cmd, { kind: "asset", id: take.id });
  /* Recreate's companions: the words alone, or the model and its settings alone. */
  const noRecreate = generation ? recreateBlock(generation) : null;
  const words = generation ? recipePrompt(generation) : "";
  const copyPrompt = async () => {
    try { await navigator.clipboard.writeText(words); toast(SAY.promptCopied); } catch { toast(SAY.copyBlocked); }
  };
  return (
    <div className="gx-insp-asset" data-testid="asset-inspector">
      <div className="gx-insp-row"><span className="gx-eyebrow">Output</span><span className="gx-eyebrow">{take.version}</span></div>
      <Preview key={take.id} entry={entry} />
      <div className="gx-insp-title" data-testid="inspector-title">{take.name}</div>
      <div className="gx-insp-sub">{[take.version, take.meta].filter(Boolean).join(" · ")}</div>
      <span className="gx-eyebrow">Provenance</span>
      <dl className="gx-facts" data-testid="asset-facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd title={v}>{v}</dd></div>)}
      </dl>
      {settled.failed ? <button type="button" className="gx-hbtn" style={{ alignSelf: "flex-start" }} onClick={settled.retry} data-testid="inspector-settled-retry">Try again</button> : null}
      {pair?.draft && generation ? (
        <>
          <span className="gx-eyebrow">Draft</span>
          <DraftFinalBar key={generation.id} scope={scope} projectId={project?.id ?? null} draft={generation} finals={finals} />
        </>
      ) : null}
      <span className="gx-eyebrow">Actions</span>
      {take.status === "held" ? <div className="gx-insp-actions" data-testid="inspector-release"><ReleaseTake key={take.id} entry={entry} onReleased={library.refresh} place="inspector" /></div> : null}
      {generation ? (
        <div className="gx-insp-actions" data-testid="inspector-recipe">
          <button type="button" className="gx-primary" disabled={Boolean(noRecreate)} onClick={() => command("retry")} data-testid="inspector-recreate">Recreate</button>
          <button type="button" className="gx-hbtn" disabled={Boolean(noRecreate)} title="The model and its settings; the prompt in Gen stays" onClick={() => recreate(entry, true)} data-testid="inspector-settings-only">Use settings only</button>
          <button type="button" className="gx-hbtn" disabled={!words} onClick={() => void copyPrompt()} data-testid="inspector-copy-prompt">Copy prompt</button>
          {noRecreate ? <p className="gx-reason gx-insp-why" data-testid="inspector-recreate-why">{noRecreate}</p> : null}
        </div>
      ) : null}
      <div className="gx-insp-actions">
        <button type="button" className="gx-hbtn" disabled={!role} title={role ? undefined : "References are images and videos."} onClick={() => command("use-as-reference")}>Use as reference</button>
        {entryPreview(entry) ? <button type="button" className="gx-hbtn" onClick={() => openPreview([entryPreview(entry)!])} data-testid="inspector-open-preview">Preview</button> : null}
        {downloadable ? <a className="gx-hbtn" href={download} download={upload ? upload.filename : true}>Download original</a> : null}
        <button type="button" className="gx-hbtn" title="The asset itself, to paste into another project" onClick={() => command("copy")} data-testid="inspector-copy-asset">Copy asset</button>
        <button type="button" className="gx-hbtn" onClick={() => command("move")}>Move to…</button>
        <button type="button" className="gx-hbtn gx-hbtn--danger" onClick={() => { command("delete"); dispatch({ type: "patch", patch: { selKind: "page", selId: state.page } }); }}>Delete</button>
      </div>
    </div>
  );
}

/**
 * A failed take's facts after its Reason: what the provider did with the
 * charge (only where it billed the workspace's own key or account — Particl's
 * own charge is "Settled" above), and the next step.
 */
function failureFacts(failure: TakeFailure, cancelled: boolean): [string, string][] {
  const line = failureLine({ ...failure, charge: null }, { cancelled });
  return [
    ...(failure.billing ? [["Provider", billingSentence(failure.billing, failure.provider)] as [string, string]] : []),
    ["Next", line.next],
  ];
}

/** A fixed 180px card (an aspect-ratio box collapsed inside the flex column). Play/pause for anything with time. */
function Preview({ entry }: { entry: LibraryEntry }) {
  const player = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const timed = Boolean(entry.url) && (entry.media === "video" || entry.media === "audio");
  const toggle = () => { const el = player.current; if (!el) return; if (el.paused) void el.play().catch(() => setPlaying(false)); else el.pause(); };
  return (
    <div className="gx-insp-card" data-testid="inspector-preview" {...previewAttrs(entryPreview(entry))}>
      {entry.url && entry.media === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- workspace-scoped media route, as the workbench library
        <img src={entry.url} alt={entry.take.name} />
      ) : entry.url && entry.media === "video" ? (
        <video ref={player} src={entry.url} playsInline preload="metadata" aria-label={entry.take.name} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      ) : entry.url && entry.media === "audio" ? (
        <><audio ref={player} src={entry.url} preload="metadata" aria-label={entry.take.name} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} /><span className="gx-badge">AUDIO</span></>
      ) : <span className="gx-badge">{entry.take.status === "rendering" || entry.take.status === "held" ? takeStatusWord(entry.take).toUpperCase() : entry.take.status === "failed" ? (entry.take.cancelled ? "CANCELLED" : "FAILED") : entryFace(entry) === "unavailable" ? "PREVIEW UNAVAILABLE" : entryPreview(entry) ? "DOCUMENT" : "NO PREVIEW"}</span>}
      {timed ? <button type="button" className="gx-play" aria-pressed={playing} onClick={toggle}>{playing ? "Pause" : "Play"}</button> : null}
    </div>
  );
}
