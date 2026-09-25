"use client";
import { useRef, useState } from "react";
import { referenceRole } from "@/lib/shell/assets";
import { useShell } from "@/lib/shell/state";
import type { Project } from "@/lib/workbench/studio";
import { useProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { entryPreview, previewAttrs } from "@/lib/preview";
import { openPreview } from "@/components/PreviewLayer";

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
  const { dispatch, state } = useWorkspace();
  const library = useProjectLibrary(scope, project?.id ?? null);
  const entry = library.items.find((item) => item.take.id === id) ?? null;
  if (!entry) {
    return <div className="gx-insp-asset"><span className="gx-eyebrow">Output</span><div className="gx-insp-card" aria-hidden="true" /><p className="gx-empty">{library.state.status === "ready" ? "This asset is no longer in the project." : "Reading this project…"}</p></div>;
  }
  const { take, asset } = entry;
  const generation = asset.origin === "generation" ? asset.value : null;
  const upload = asset.origin === "upload" ? asset.value : null;
  const role = referenceRole(entry.media);
  const facts: [string, string][] = [
    ["Kind", generation ? "Generation" : "Upload"],
    ...(generation ? [["Engine", generation.model] as [string, string], ["Prompt", generation.prompt ? generation.prompt.slice(0, 160) : "—"] as [string, string], ["Made", when(generation.createdAt)] as [string, string], ["Settled", take.status === "rendering" ? "Not settled" : take.failedUnbilled ? "Not billed" : take.credits != null ? `${take.credits.toLocaleString("en-US")} cr` : generation.costUsd != null ? `$${generation.costUsd.toFixed(3)}` : "—"] as [string, string]] : []),
    ...(upload ? [["File", upload.filename] as [string, string], ["Type", upload.mime] as [string, string], ["Size", bytesLabel(upload.bytes)] as [string, string], ...(upload.width && upload.height ? [["Pixels", `${upload.width}×${upload.height}`] as [string, string]] : []), ["Uploaded", when(upload.createdAt)] as [string, string], ["Integrity", upload.sha256 ? "sha256 ✓" : "—"] as [string, string]] : []),
    ...(generation && typeof generation.params.enhancedPrompt === "string" && generation.params.enhancedPrompt ? [["Enhanced", `${generation.params.enhancedPrompt.slice(0, 160)} · on the account`] as [string, string]] : []),
    ...(take.meta ? [["Detail", take.meta] as [string, string]] : []),
    ["Status", take.status],
  ];
  const download = generation ? `/api/media/${encodeURIComponent(generation.id)}?download=1` : `/api/uploads/${encodeURIComponent(upload!.id)}?download=1`;
  const downloadable = upload || (generation?.status === "succeeded" && generation.storedUrl);
  const command = (cmd: "use-as-reference" | "retry" | "move" | "delete" | "copy" | "cut") => shell.runCommand?.(cmd, { kind: "asset", id: take.id });
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
      <span className="gx-eyebrow">Actions</span>
      <div className="gx-insp-actions">
        <button type="button" className="gx-hbtn" disabled={!role} title={role ? undefined : "References are images and videos."} onClick={() => command("use-as-reference")}>Use as reference</button>
        {generation ? <button type="button" className="gx-hbtn" onClick={() => command("retry")}>Retry generation</button> : null}
        {entryPreview(entry) ? <button type="button" className="gx-hbtn" onClick={() => openPreview([entryPreview(entry)!])} data-testid="inspector-open-preview">Preview</button> : null}
        {downloadable ? <a className="gx-hbtn" href={download} download={upload ? upload.filename : true}>Download original</a> : null}
        <button type="button" className="gx-hbtn" onClick={() => command("copy")}>Copy</button>
        <button type="button" className="gx-hbtn" onClick={() => command("move")}>Move to…</button>
        <button type="button" className="gx-hbtn gx-hbtn--danger" onClick={() => { command("delete"); dispatch({ type: "patch", patch: { selKind: "page", selId: state.page } }); }}>Delete</button>
      </div>
    </div>
  );
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
      ) : <span className="gx-badge">{entry.take.status === "rendering" ? "RENDERING" : entryPreview(entry) ? "DOCUMENT" : "NO PREVIEW"}</span>}
      {timed ? <button type="button" className="gx-play" aria-pressed={playing} onClick={toggle}>{playing ? "Pause" : "Play"}</button> : null}
    </div>
  );
}
