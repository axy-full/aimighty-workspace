"use client";
import { useMemo, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { assetPreview, previewAttrs } from "@/lib/preview";
import { REF_KIND_LABELS, cardLabel, refKindChosen, refKindOf } from "@/lib/workbench/ref-kind";
import { REF_KINDS, type Asset, type CanvasNode, type Project } from "@/lib/workbench/studio";
import { mediaBands } from "@/lib/workspace/format";
import { cardSource, cardUsers, cardVersions } from "@/lib/workspace/rig";
import { RIG_NO_PROJECT, rigLoadState } from "@/lib/workspace/rig-load-state";
import { useWorkspace } from "@/lib/workspace/state";
import { Kicker } from "../ui";
import { useRig } from "./RigProvider";
import "./rig.css";

/**
 * The Inspector for a Rig card that is not a shot (a reference, a note, a look
 * board): what it is to the production — a reference's kind, which a person
 * sets here for everyone on the canvas — the source it holds, that source's
 * versions and the versions saved on the card, and the cards it feeds.
 */
export function RigCardInspector() {
  const rig = useRig();
  const { state } = useWorkspace();
  const { selectedCard, project } = rig;
  if (!project || !selectedCard) {
    const load = rigLoadState({ status: rig.status, hasProject: !!project, projectId: state.projectId });
    return (
      <div data-inspector-body="node">
        <Kicker>Card</Kicker>
        <p className="pxw-inspector-note">
          {load === "loading" ? "Loading the canvas…" : load === "error" ? rig.error : project ? "Select a card on the canvas to see it here." : RIG_NO_PROJECT}
        </p>
      </div>
    );
  }
  /* Keyed by card so nothing said about one card stays on the next. */
  return <CardInspector key={selectedCard.id} node={selectedCard} project={project} />;
}

function SourceWell({ id, asset }: { id: string; asset: Asset | null }) {
  const [c1, c2] = mediaBands(id);
  /* The 640px preview for a stored picture, as the card on the canvas draws it; the file itself only for anything else. */
  const image = asset?.kind !== "image" ? null
    : asset.generationId ? `/api/workbench/preview/generation/${encodeURIComponent(asset.generationId)}`
    : asset.uploadId ? `/api/workbench/preview/upload/${encodeURIComponent(asset.uploadId)}`
    : asset.url;
  return (
    <div className="pxw-insp-preview" data-testid="card-preview" {...previewAttrs(assetPreview(asset))}>
      {asset?.kind === "video" ? (
        <video src={asset.url} muted playsInline preload="metadata" aria-label={asset.name} />
      ) : image ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={image} alt={asset!.name} />
      ) : (
        <>
          <span style={{ flex: 1, background: c1 }} />
          <span style={{ flex: 1.1, background: c2 }} />
        </>
      )}
    </div>
  );
}

function CardInspector({ node, project }: { node: CanvasNode; project: Project }) {
  const rig = useRig();
  const kind = refKindOf(node, project);
  const chosen = refKindChosen(node);
  const source = useMemo(() => cardSource(project, node), [project, node]);
  const versions = useMemo(() => cardVersions(project, node), [project, node]);
  const users = useMemo(() => cardUsers(project, node.id), [project, node.id]);
  const [error, setError] = useState<string | null>(null);
  const locked = !!node.locked;
  const text = (node.text ?? "").trim();
  return (
    <div data-inspector-body="node" data-node-id={node.id} data-ref-kind={kind ?? undefined}>
      <div className="pxw-insp-output">
        <Kicker>{cardLabel(node, project)}</Kicker>
        <span className="pxw-insp-output-label">{source ? `v${source.asset.version} · ${source.kind}` : "No source yet"}</span>
      </div>
      <SourceWell id={node.id} asset={source?.asset ?? null} />
      <div className="pxw-inspector-subject" data-testid="inspector-title">{node.title}</div>
      {text ? <p className="pxw-card-text">{text}</p> : null}

      {kind ? (
        <div data-section="kind">
          <Kicker className="pxw-insp-section">Kind</Kicker>
          <div className="pxw-kind-picker" role="group" aria-label="Reference kind" data-testid="card-kind">
            {REF_KINDS.map((k) => (
              <button key={k} type="button" aria-pressed={k === kind} disabled={locked} data-kind={k}
                onClick={() => setError(rig.setRefKind(node.id, k))}>
                {REF_KIND_LABELS[k]}
              </button>
            ))}
          </div>
          <p className="pxw-inspector-note pxw-kind-note" data-testid="card-kind-note">
            {locked ? "Unlock this card to change its kind." : chosen ? "Set for everyone on this canvas." : "Read from the card until you choose one."}
          </p>
        </div>
      ) : null}

      <Kicker className="pxw-insp-section">Source</Kicker>
      {source ? (
        <div className="pxw-insp-row" data-testid="card-source">
          <span className="pxw-insp-row-thumb pxw-insp-row-thumb--media" aria-hidden="true">
            {source.asset.url && (source.asset.kind === "image" || source.asset.kind === "video")
              ? <LazyMedia url={source.asset.url} kind={source.asset.kind} alt="" name={source.asset.name} className="gx-lazy" />
              : <span {...previewAttrs(assetPreview(source.asset))} className="pxw-insp-row-glyph">▤</span>}
          </span>
          <span className="pxw-insp-row-text">
            <span className="pxw-insp-row-name">{source.asset.name}</span>
            <span className="pxw-insp-row-kind">{[source.kind, source.origin, source.asset.category, source.own ? null : "through its input"].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="pxw-insp-row-v" data-functional-label="">v{source.asset.version}</span>
        </div>
      ) : (
        <p className="pxw-inspector-note" style={{ marginTop: 0 }}>Nothing is attached to this card yet.</p>
      )}

      <Kicker className="pxw-insp-section">Versions</Kicker>
      <div data-testid="card-versions">
        {versions.length ? versions.map((row) => (
          <div className="pxw-insp-version" key={`${row.saved ? "saved" : "source"}:${row.id}`} data-current={row.current || undefined} data-saved={row.saved || undefined}>
            <span className="pxw-insp-version-v">{row.v}</span>
            <span className="pxw-insp-version-label">{row.label}</span>
            {row.meta ? <span className="pxw-insp-version-meta">{row.meta}</span> : null}
          </div>
        )) : <p className="pxw-inspector-note" style={{ marginTop: 0 }}>No versions yet.</p>}
      </div>

      {users.length ? (
        <div data-section="feeds">
          <Kicker className="pxw-insp-section">Feeds</Kicker>
          <div className="pxw-card-users">
            {users.map((user) => (
              <button key={user.id} type="button" className="pxw-link-button" onClick={() => rig.select(user.id)}>{user.name}</button>
            ))}
          </div>
        </div>
      ) : null}
      {error ? <p className="pxw-insp-error" role="alert">{error}</p> : null}
    </div>
  );
}
