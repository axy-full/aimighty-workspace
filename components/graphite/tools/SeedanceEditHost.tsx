"use client";
import { useState } from "react";
import SeedanceEdit from "@/components/make/SeedanceEdit";
import { ToastHost } from "@/components/ui/Toast";
import type { Project } from "@/lib/workbench/studio";
import { refreshProjectLibrary } from "@/lib/workspace/library";

/** The Seedance engines that take the edit task (lib/models.ts › supportsTasks). */
export const SEEDANCE_EDIT_MODELS = [
  { id: "dreamina-seedance-2-5-260628", label: "Seedance 2.5", note: "Highest fidelity, native audio." },
  { id: "dreamina-seedance-2-0-260128", label: "Seedance 2.0", note: "Cheaper per token. Edit on 2.0 follows the vendor guide; qualified on production 23 September — a 4 s edit quoted $0.74, settled $0.75." },
] as const;
export type SeedanceEditModelId = (typeof SEEDANCE_EDIT_MODELS)[number]["id"];

/**
 * Gen › Edit: the existing Seedance Edit panel (a source clip, references, a
 * prompt with the vendor's trigger words; quoted, then run on this workspace's
 * credits) inside the shell's frame, with the engine picked above it. Nothing
 * here prices anything; the panel's own quote does.
 */
/** `initialSource` (`generation:<id>` / `upload:<id>`) opens the panel on that clip — Studio › Edit's chosen take. */
export function SeedanceEditHost({ scope, project, onBack, initialSource }: { scope: string; project: Project | null; onBack: () => void; initialSource?: string | null }) {
  const [model, setModel] = useState<SeedanceEditModelId>(SEEDANCE_EDIT_MODELS[0].id);
  const picked = SEEDANCE_EDIT_MODELS.find((m) => m.id === model)!;
  const target = project?.productionProjectId ? { id: project.id, name: project.name, productionProjectId: project.productionProjectId } : null;
  return (
    <section className="gx-gen-card gx-workflow" aria-label="Edit" data-testid="gen-edit">
      <div className="gx-gen-row">
        <span className="gx-eyebrow" data-functional-label="">Edit · this workspace’s credits</span>
        <h2 className="gx-workflow-title">Change something inside an existing shot</h2>
        <p className="gx-hint">A subject, an object, the background, the audio — everything else stays. The output is as long as the clip it works on.</p>
      </div>
      <div className="gx-gen-row">
        <span className="gx-eyebrow" data-functional-label="">Engine</span>
        <div className="gx-seg gx-seg--sm" role="tablist" aria-label="Edit engine">
          {SEEDANCE_EDIT_MODELS.map((m) => (
            <button key={m.id} type="button" role="tab" className="gx-seg-btn" aria-selected={model === m.id} onClick={() => setModel(m.id)} data-testid={`gen-edit-model-${m.id.includes("2-5") ? "25" : "20"}`}><span>{m.label}</span></button>
          ))}
        </div>
        <p className="gx-hint">{picked.note}</p>
      </div>
      {target ? (
        <div className="pxw gx-legacy pxw-embed" data-testid="gen-edit-panel">
          <ToastHost>
            <SeedanceEdit key={`${scope}:${target.id}:${model}:${initialSource ?? ""}`} project={target} model={model} initialSource={initialSource} onBack={onBack} onMade={() => void refreshProjectLibrary(scope, target.id)} />
          </ToastHost>
        </div>
      ) : (
        <p className="gx-reason" role="status">Save your project first.</p>
      )}
    </section>
  );
}
