"use client";
import LazyMedia from "@/components/LazyMedia";
import { assetPreview, previewAttrs } from "@/lib/preview";
import { sendToRig } from "@/lib/production/rig-build";
import { useShell } from "@/lib/shell/state";
import type { Asset } from "@/lib/workbench/studio";
import { usePublishedProject } from "@/lib/workspace/spec-store";

/**
 * Production › Astra 3D (owner's brief, 23 September): every render the 3D
 * scene has made, downloadable, and sent on — to the Rig as a new shot that
 * starts on the render, or to the Timeline via Edit. Reads the live draft the
 * Astra tool publishes, so a render appears as soon as it is registered.
 */
export function AstraOutputs() {
  const shell = useShell();
  const project = usePublishedProject();
  const outputs = (project?.assets ?? []).filter((a) => a.category === "Astra");
  if (!project) return null;
  const images = outputs.filter((a) => a.kind === "image");
  const files = outputs.filter((a) => a.kind !== "image");
  const send = (asset: Asset) => { sendToRig({ projectId: project.id, asset }); shell.goSuite("studio", "rig"); };
  return (
    <section className="gx-gen-card" aria-label="Astra outputs" data-testid="astra-outputs" data-section="outputs">
      <div className="pd-row-head">
        <span className="gx-eyebrow" data-functional-label="">Renders & files</span>
        <span className="gx-spacer" />
        <span className="gx-hint">{images.length} renders · {files.length} scene files</span>
      </div>
      {outputs.length ? (
        <div className="pd-take-grid">
          {images.map((a) => (
            <div key={a.id} className="pd-take" data-testid="astra-output">
              <LazyMedia url={a.url} kind="image" alt={a.name} className="gx-lazy" />
              <span className="pd-take-name">{a.name}</span>
              <div className="gx-gen-enhance">
                <button type="button" className="gx-hbtn" onClick={() => send(a)} data-testid="astra-to-rig">Send to Rig</button>
                <a className="gx-hbtn" href={a.url} download={a.name}>Download</a>
              </div>
            </div>
          ))}
          {files.map((a) => (
            <div key={a.id} className="pd-take" data-testid="astra-file" {...previewAttrs(assetPreview(a))}>
              <span className="pd-take-name">{a.name}</span>
              <span className="gx-hint">{a.description}</span>
              <a className="gx-hbtn" href={a.url} download={a.name}>Download</a>
            </div>
          ))}
        </div>
      ) : <p className="gx-hint">Renders from the 3D scene land here — download them, or send one to the Rig as the first frame of a new shot. Export the whole scene below.</p>}
    </section>
  );
}
