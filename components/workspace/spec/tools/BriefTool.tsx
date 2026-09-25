"use client";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { DevelopmentPanel } from "@/components/workbench/DevelopmentPanel";
import { ScriptPanel } from "@/components/workbench/ScriptPanel";
import { suiteHref } from "@/lib/suites";
import { applyDevelopment } from "@/lib/workbench/development-apply";
import { developmentSourceHash } from "@/lib/workbench/development-client";
import { sourceCanonical, type DevelopmentJob } from "@/lib/workbench/development-types";
import type { ScreenplayImport, ScriptScene } from "@/lib/workbench/screenplay";
import { buildScreenplayNodes } from "@/lib/workbench/screenplay-nodes";
import type { Asset, Project } from "@/lib/workbench/studio";
import { uploadWorkbench } from "@/lib/workbench/upload";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import "./studio-css";
import { DraftGate, DraftStatus } from "./DraftStatus";

type Field = "brief" | "audience" | "deliverables" | "direction";
const FIELDS: { id: Field; label: string; rows: number; placeholder?: string }[] = [
  { id: "brief", label: "What are we making?", rows: 5, placeholder: "Start with a thought, a script or a client brief…" },
  { id: "audience", label: "Audience", rows: 3 },
  { id: "deliverables", label: "Deliverables", rows: 3 },
  { id: "direction", label: "Creative direction", rows: 4 },
];

/**
 * Brief & Script's working tools: the brief fields with idea development,
 * and the existing ScriptPanel with script development. Every callback is
 * the Studio's own (components/workbench/Studio.tsx), over the same libs,
 * against a draft editor that saves with the draft's revision.
 */
export default function BriefTool({
  tool,
  projectId,
  scope,
  onProject,
  onRig,
}: {
  tool: string;
  projectId: string;
  scope: string;
  onProject: (project: Project) => void;
  onRig: () => void;
}) {
  const editor = useDraftEditor(scope, projectId);
  const router = useRouter();
  const latest = useRef<Project | null>(null);
  useEffect(() => {
    latest.current = editor.project;
    if (editor.project) onProject(editor.project);
  }, [editor.project, onProject]);

  if (editor.status !== "ready" || !editor.project) return <DraftGate editor={editor} label="the brief" />;
  const p = editor.project;
  const { change, ensureSaved } = editor;
  const studioAgent = async () => {
    await ensureSaved();
    /* Scene coverage and the crew run in Studio's agent, which owns those flows. */
    router.push(`${suiteHref("particl", p.id, "brief")}&atomik=open`);
  };

  /* Studio.tsx applyDevelopmentResult */
  async function applyResult(job: DevelopmentJob, choice: { idea: number } | { scenes: string[] }) {
    const current = latest.current;
    if (!current || job.projectId !== current.id) throw new Error("Return to the project that created this result.");
    const source = sourceCanonical(current, job.kind);
    if ((await developmentSourceHash(current, job.kind)) !== job.sourceHash)
      throw new Error("The source changed after this development run. Review the saved result or run development again.");
    if (!latest.current || latest.current.id !== current.id || sourceCanonical(latest.current, job.kind) !== source)
      throw new Error("The project changed while checking the result. Try again.");
    /* Worked out from the draft as the editor holds it now, never from a copy a render older. */
    change((p) => {
      if (p.id !== current.id || sourceCanonical(p, job.kind) !== source) throw new Error("The project changed while checking the result. Try again.");
      return applyDevelopment(p, job, choice);
    });
    if (!(await ensureSaved())) throw new Error("The result was added locally, but is not saved yet. Keep this project open and retry saving.");
    toast.success("idea" in choice ? "Idea added to creative direction." : "Scene breakdown added to the canvas.");
  }

  /* Studio.tsx importScreenplay */
  async function importScreenplay(file: File, result: ScreenplayImport) {
    const current = latest.current;
    if (!current) throw new Error("Create and save a project before importing.");
    const draftId = current.id;
    if (current.scriptSource?.sha256 === result.sha256 && current.script === result.text && JSON.stringify(current.scriptSource.ocr) === JSON.stringify(result.ocr)) {
      if (!(await ensureSaved())) throw new Error("The import is still unsaved. Retry when the connection returns.");
      return;
    }
    if (current.assets.length >= PROJECT_LIMITS.assets) throw new Error("The asset library is full. Make space for the original screenplay first.");
    const uploaded = await uploadWorkbench(file, undefined, scope);
    if (latest.current?.id !== draftId) throw new Error("The project changed. The uploaded original remains in your workspace.");
    const adfilm = latest.current.scriptFormat === "adfilm";
    const asset: Asset = {
      id: uploaded.id, uploadId: uploaded.id, name: file.name.slice(0, 200), kind: "document",
      category: adfilm ? "Ad-film script" : "Screenplay", url: uploaded.url, mime: uploaded.mime || file.type,
      description: adfilm ? "Original ad-film script source" : "Original screenplay source", prompt: "", status: "Draft", version: 1, locked: false, refs: [],
    };
    change((old) => ({
      ...old,
      script: result.text,
      scriptReviews: {},
      scriptSource: { assetId: asset.id, filename: asset.name, sha256: result.sha256, pages: result.pages, importedAt: new Date().toISOString(), edited: false, acknowledgedEmptyPages: result.emptyPages, ocr: result.ocr },
      assets: [...old.assets, asset],
    }));
    if (!(await ensureSaved())) throw new Error("The source uploaded, but the project is not saved yet. Retry this import to save it without uploading again.");
  }

  /* Studio.tsx buildScriptCanvas: scene nodes into Rig. */
  async function buildScenes(scenes: ScriptScene[]) {
    try {
      const nodes = buildScreenplayNodes(latest.current!, scenes);
      change((old) => ({ ...old, nodes: [...old.nodes, ...nodes] }));
      if (!(await ensureSaved())) throw new Error("The scene nodes were added locally, but are not saved yet.");
      toast.success(`${nodes.length} complete scene nodes added with source and beat notes.`);
      onRig();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build these scenes.");
    }
  }

  const development = (kind: "idea" | "screenplay" | "adfilm") => (
    <DevelopmentPanel key={p.id + "-" + kind} project={p} kind={kind} scope={scope} enabled models={[]} onSave={ensureSaved} onApply={applyResult} />
  );

  return (
    <div className="pxw-tool pxw-tool--brief" data-tool-body={tool}>
      <DraftStatus editor={editor} />
      {tool === "brief" ? (
        <div className="pxw-brief-form">
          {FIELDS.map((field) => (
            <label className="pxw-field-block" key={field.id}>
              <span className="pxw-field-label">{field.label}</span>
              <textarea
                className="pxw-textarea"
                rows={field.rows}
                value={p[field.id]}
                placeholder={field.placeholder}
                onChange={(event) => {
                  const value = event.target.value;
                  change((old) => ({ ...old, [field.id]: value }));
                }}
              />
            </label>
          ))}
          <div className="pxw-brief-actions">
            <button type="button" className="pxw-btn pxw-btn--control" onClick={() => void studioAgent()}>Open the Atomik conversation</button>
          </div>
          <div className="ps">{development("idea")}</div>
        </div>
      ) : (
        <div className="ps">
        <ScriptPanel
          embedded
          key={p.id}
          project={p}
          onScript={(value) => change((old) => ({ ...old, script: value, scriptSource: old.scriptSource ? { ...old.scriptSource, edited: true } : undefined }))}
          onFormat={(value) => change((old) => ({ ...old, scriptFormat: value }))}
          development={development(p.scriptFormat || "screenplay")}
          onImport={importScreenplay}
          onReview={(id, review) => change((old) => ({ ...old, scriptReviews: { ...old.scriptReviews, [id]: review } }))}
          onBuild={(scenes) => void buildScenes(scenes)}
          onDevelop={() => void studioAgent()}
          onCrew={() => void studioAgent()}
        />
        </div>
      )}
    </div>
  );
}
