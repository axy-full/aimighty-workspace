"use client";
import { isShotNode } from "@/lib/workspace/shots";
import { runPageAction } from "@/lib/workspace/page-actions";
import { useWorkspace } from "@/lib/workspace/state";
import { Button, Kicker } from "../ui";
import { trainingQuote, useCast } from "../pages/CastPage";
import { mediaBands } from "@/lib/workspace/format";
import { MediaPreview } from "./MediaPreview";
import type { InspectorBodyProps } from "./registry";

type Row = { label: string; value: string; tone?: "green" | "blue" | "primary" };

const LOCK_LABEL = { ready: "Locked", submitting: "Training", training: "Training", failed: "Failed", uncertain: "Needs review" } as const;

/** One cast member or element: its identity, what we know about its consistency, its references. */
export function CastInspector({ state, scope, project: shellProject }: InspectorBodyProps) {
  const { dispatch, go } = useWorkspace();
  const { project, cards, terms } = useCast(scope, shellProject);
  const card = cards.find((c) => c.id === state.selId) ?? null;
  if (!card || !project) {
    return (
      <div data-inspector-body="cast">
        <Kicker>Output</Kicker>
        <div className="pxw-preview" style={{ marginTop: 10 }} aria-hidden="true" />
        <p className="pxw-inspector-note">{project ? "Select a cast member or element to see its identity and references." : "Loading cast and elements…"}</p>
      </div>
    );
  }
  const { identity, asset } = card;
  const [top, bottom] = mediaBands(card.id);
  const mark = identity ? LOCK_LABEL[identity.status] : asset?.soulIdentityId ? "Attached" : "Draft";
  const markTone = identity?.status === "ready" ? "var(--pxw-green)" : identity?.status === "failed" ? "var(--pxw-red)" : identity ? "var(--pxw-blue-ink)" : "var(--pxw-dimmer)";
  /* Only facts the records back: no face/wardrobe/build scores exist, so none are shown. */
  const rows: Row[] = [
    ...(identity ? [{ label: "Identity", value: LOCK_LABEL[identity.status], tone: identity.status === "ready" ? ("green" as const) : undefined }] : []),
    { label: "References", value: card.references.length.toLocaleString("en-US") },
    ...(card.needs ? [{ label: "Needed to lock", value: `${card.needs.toLocaleString("en-US")} more` }] : []),
    { label: "Cited by", value: `${card.citedBy.length.toLocaleString("en-US")} ${card.citedBy.length === 1 ? "shot" : "shots"}`, tone: "primary" },
    ...(asset ? [{ label: "Version", value: `v${asset.version}` }, { label: "Asset", value: asset.locked ? "Locked" : "Editable" }] : []),
    ...(identity?.creditsBilled != null ? [{ label: "Training billed", value: `${identity.creditsBilled.toLocaleString("en-US")} cr`, tone: "blue" as const }] : []),
  ];
  const shots = project.nodes.filter(isShotNode);
  const target = card.citedBy[0] ?? shots[0]?.id ?? null;
  const openInRig = () => {
    if (target) dispatch({ type: "patch", patch: { selKind: "shot", selId: target } });
    go("particl", "rig");
  };
  const quote = trainingQuote(terms);
  const canLock = card.group === "cast" && !identity && !!asset && !asset.locked;
  return (
    <div data-inspector-body="cast">
      <div className="pxw-insp-row">
        <Kicker>Output</Kicker>
        <span className="pxw-insp-aside">Reference</span>
      </div>
      <MediaPreview key={card.id} url={card.url} media={card.url ? "image" : null} label={card.name} fallback={
        <span className="pxw-flat" aria-hidden="true"><span style={{ background: top }} /><span style={{ background: bottom }} /></span>
      } />
      <div className="pxw-inspector-subject" data-testid="inspector-title">{card.name}</div>
      <div className="pxw-inspector-sub">{card.sub}</div>

      <Kicker className="pxw-insp-kicker">Identity</Kicker>
      <div className="pxw-identity-card" data-testid="identity-card">
        <div className="pxw-identity-head">
          <span>{identity?.status === "ready" ? "Locked identity" : "Identity"}</span>
          <span className="pxw-identity-mark" style={{ color: markTone }}>
            <span className="pxw-dot" style={{ background: markTone }} aria-hidden="true" />
            {mark}
          </span>
        </div>
        <p>Every shot citing this identity reuses the same reference set, byte-identical. Face, wardrobe and build hold across shots, engines and suites.</p>
        {canLock ? (
          <Button variant="control" className="pxw-identity-lock" onClick={() => runPageAction("cast", asset!.id)} disabled={!quote} title={quote ? undefined : "The training price has not loaded yet."}>
            {quote ? `Lock identity · ${quote}` : "Lock identity"}
          </Button>
        ) : null}
      </div>

      <Kicker className="pxw-insp-kicker">Consistency</Kicker>
      <dl className="pxw-facts pxw-facts--tight" data-testid="consistency">
        {rows.map((row) => (
          <div className="pxw-fact" key={row.label}>
            <dt>{row.label}</dt>
            <dd data-tone={row.tone}>{row.value}</dd>
          </div>
        ))}
      </dl>

      {card.references.length ? (
        <>
          <Kicker className="pxw-insp-kicker">References</Kicker>
          <div className="pxw-ref-grid" data-testid="reference-grid">
            {card.references.slice(0, 9).map((ref) => (
              // eslint-disable-next-line @next/next/no-img-element -- workspace-scoped originals, as the identity panel shows them
              <img key={ref.key} src={ref.url} alt="" loading="lazy" />
            ))}
          </div>
        </>
      ) : null}
      <Button variant="primary" className="pxw-insp-primary" onClick={openInRig} data-testid="use-in-rig">Use in Rig</Button>
    </div>
  );
}
