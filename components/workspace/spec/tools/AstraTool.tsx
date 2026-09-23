"use client";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import { useEffect, useRef } from "react";
import { AstraStudio } from "@/components/astra-blender/AstraStudio";
import { astraNativeDigest, serializeAstraNative, validateAstraNativeBindings } from "@/lib/astra-blender/native";
import { astraSceneDigest, serializeAstraScene, validateAstraBindings } from "@/lib/astra-blender/proposal";
import { createAstraScene } from "@/lib/astra-blender/scene";
import type { Plan, Project } from "@/lib/workbench/studio";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import "./studio-css";
import { DraftGate, DraftStatus } from "./DraftStatus";

/**
 * Astra 3D: the existing AstraStudio (scene, native source, proposals, render
 * and export panels), loaded only when this page opens. The callbacks are
 * Studio's own (components/workbench/Studio.tsx) over the same libs.
 */
export default function AstraTool({ projectId, scope, onProject }: { projectId: string; scope: string; onProject: (project: Project) => void }) {
  const editor = useDraftEditor(scope, projectId);
  const latest = useRef<Project | null>(null);
  useEffect(() => {
    latest.current = editor.project;
    if (editor.project) onProject(editor.project);
  }, [editor.project, onProject]);
  if (editor.status !== "ready" || !editor.project) return <DraftGate editor={editor} label="the 3D scene" />;
  const p = editor.project;
  const { change } = editor;

  /* Studio.tsx AstraStudio onApply: a proposal applies only to the scene it was made from. */
  async function apply(plan: Plan) {
    const proposal = plan.astraBlender, native = plan.astraNative;
    if (!proposal && !native) throw new Error("This proposal has no 3D scene.");
    const current = latest.current;
    if (!current || current.id !== p.id) throw new Error("Return to the project that created this proposal.");
    const source = current.astraBlender ?? createAstraScene("product");
    if ((await astraSceneDigest(source)) !== (native ?? proposal)!.baseSceneDigest)
      throw new Error("The scene changed after this proposal was requested. Preserve your edits and request a new proposal.");
    if (native && (await astraNativeDigest(current.astraNative)) !== native.baseNativeDigest)
      throw new Error("The native source changed after this proposal was requested. Review a new proposal.");
    change((old) => {
      if (old.id !== current.id || serializeAstraScene(old.astraBlender ?? createAstraScene("product")) !== serializeAstraScene(source))
        throw new Error("The scene changed. Review a new proposal.");
      if (native) {
        if (serializeAstraNative(old.astraNative) !== serializeAstraNative(current.astraNative)) throw new Error("The native source changed. Review a new proposal.");
        validateAstraNativeBindings(native.source, [...old.assets, ...(old.sharedAssets ?? [])]);
      } else validateAstraBindings(proposal!.scene, [...old.assets, ...(old.sharedAssets ?? [])]);
      return {
        ...old,
        ...(native ? { astraNative: native.source } : { astraBlender: proposal!.scene }),
        plans: [{ ...plan, astraNative: undefined, astraBlender: undefined, role: "Astra", applied: true }, ...old.plans.filter((item) => item.id !== plan.id)].slice(0, 100),
      };
    });
  }

  return (
    <div className="pxw-tool pxw-tool--astra" data-tool-body="astra">
      <DraftStatus editor={editor} />
      <div className="ps pxw-astra-host">
        <AstraStudio
          key={scope + p.id}
          project={p}
          scope={scope}
          enabled
          onSave={editor.ensureSaved}
          onRefreshProject={async () => {
            await editor.refresh();
          }}
          onAsset={(asset) =>
            change((old) => {
              if (old.id !== p.id) throw new Error("The project changed. Your upload is preserved in All assets.");
              if (old.assets.length >= PROJECT_LIMITS.assets) throw new Error("The project asset limit was reached. Your upload is preserved in All assets.");
              return { ...old, assets: [...old.assets.filter((item) => item.id !== asset.id), asset] };
            })
          }
          onChange={(patch) =>
            change((old) => {
              if (old.id !== p.id) throw new Error("The project changed. Return to the original project.");
              return { ...old, ...patch };
            })
          }
          onApply={apply}
        />
      </div>
    </div>
  );
}
