"use client";
import { useProjectLibrary } from "@/lib/workspace/library";
import { Kicker } from "../ui";
import { TakeMedia, takeCost, takeStatus, versionLabel } from "../pages/TakesPage";
import { MediaPreview } from "./MediaPreview";
import type { InspectorBodyProps } from "./registry";

type Fact = { label: string; value: string; tone?: "primary" | "green" | "blue"; title?: string };

/** A take or upload: preview and play, then its facts. */
export function TakeInspector({ state, scope, project }: InspectorBodyProps) {
  const library = useProjectLibrary(scope, project?.id ?? null);
  const entry = library.items.find((item) => item.take.id === state.selId) ?? null;
  if (!entry) {
    return (
      <div data-inspector-body="take">
        <Kicker>Output</Kicker>
        <div className="pxw-preview" style={{ marginTop: 10 }} aria-hidden="true" />
        <p className="pxw-inspector-note">
          {library.state.status === "ready" ? "Select an upload or a generation to see its details." : "Loading the project library…"}
        </p>
      </div>
    );
  }
  const { take, asset } = entry;
  const upload = take.kind === "UPLOAD";
  const facts: Fact[] = [
    { label: "Kind", value: upload ? "Upload" : "Generation", tone: "primary" },
    { label: "Version", value: versionLabel(take) },
    ...(take.meta ? [{ label: "Detail", value: take.meta }] : []),
    ...(upload
      ? take.sha256 ? [{ label: "Integrity", value: "sha256 ✓", tone: "green" as const, title: take.sha256 }] : []
      : [{ label: "Settled cost", value: take.status === "rendering" ? "Not settled" : take.failedUnbilled ? "Not billed" : takeCost(take), tone: "blue" as const }]),
    { label: "Status", value: takeStatus(take).label },
  ];
  const download = asset.origin === "generation" ? `/api/media/${encodeURIComponent(asset.value.id)}?download=1` : `/api/uploads/${encodeURIComponent(asset.value.id)}?download=1`;
  return (
    <div data-inspector-body="take">
      <div className="pxw-insp-row">
        <Kicker>Output</Kicker>
        <span className="pxw-insp-aside">{versionLabel(take)}</span>
      </div>
      <MediaPreview key={take.id} url={entry.url} media={entry.media} label={take.name} fallback={<TakeMedia entry={entry} />} />
      <div className="pxw-inspector-subject" data-testid="inspector-title">{take.name}</div>
      <div className="pxw-inspector-sub">{[versionLabel(take), take.meta].filter(Boolean).join(" · ")}</div>
      <Kicker className="pxw-insp-kicker">Node settings</Kicker>
      <dl className="pxw-facts" data-testid="take-facts">
        {facts.map((fact) => (
          <div className="pxw-fact" key={fact.label}>
            <dt>{fact.label}</dt>
            <dd data-tone={fact.tone} title={fact.title}>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {asset.origin === "generation" && !(asset.value.status === "succeeded" && asset.value.storedUrl) ? null : (
        <a className="pxw-btn pxw-btn--control pxw-insp-action" href={download} download={asset.origin === "upload" ? asset.value.filename : true}>
          Download original
        </a>
      )}
    </div>
  );
}
