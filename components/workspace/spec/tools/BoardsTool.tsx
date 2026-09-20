"use client";
import { useEffect } from "react";
import { StoryboardPanel } from "@/components/workbench/production-crew";
import { suiteHref } from "@/lib/suites";
import type { Project } from "@/lib/workbench/studio";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import "./studio-css";
import { DraftGate, DraftStatus } from "./DraftStatus";

/**
 * Boards: the look references above the existing StoryboardPanel, as in
 * Studio's Boards stage. Frame names and direction save to the draft; adding
 * a frame and opening a source go to Takes, opening a frame goes to Edit —
 * the pages that now hold those flows.
 */
export default function BoardsTool({
  projectId,
  scope,
  onProject,
  onPage,
}: {
  projectId: string;
  scope: string;
  onProject: (project: Project) => void;
  onPage: (page: "takes" | "edit") => void;
}) {
  const editor = useDraftEditor(scope, projectId);
  useEffect(() => {
    if (editor.project) onProject(editor.project);
  }, [editor.project, onProject]);
  if (editor.status !== "ready" || !editor.project) return <DraftGate editor={editor} label="the boards" />;
  const p = editor.project;
  const look = p.assets.filter((a) => ["image", "link", "document"].includes(a.kind));
  return (
    <div className="pxw-tool pxw-tool--boards" data-tool-body="boards">
      <DraftStatus editor={editor} />
      <details className="pxw-look" open>
        <summary>
          <span className="pxw-look-title">Look</span>
          <span className="pxw-look-sub">Define the visual world · {look.length.toLocaleString("en-US")} {look.length === 1 ? "reference" : "references"}</span>
        </summary>
        {look.length ? (
          <div className="pxw-look-grid">
            {look.filter((a) => a.kind === "image" && a.url).slice(0, 24).map((a) => (
              <figure className="pxw-look-item" key={a.id} title={a.name}>
                {/* eslint-disable-next-line @next/next/no-img-element -- workspace-scoped media URLs, as in the Studio library */}
                <img src={a.url} alt={a.name} loading="lazy" />
                <figcaption>{a.name}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <p className="pxw-look-empty">No look references yet.</p>
        )}
        <a className="pxw-btn pxw-btn--control pxw-look-edit" href={suiteHref("particl", p.id, "storyboard")}>Edit the look in Studio</a>
      </details>
      <div className="ps">
        <StoryboardPanel
          embedded
          project={p}
          onEdit={() => void editor.ensureSaved().then(() => onPage("edit"))}
          onAsset={() => void editor.ensureSaved().then(() => onPage("takes"))}
          onAdd={() => void editor.ensureSaved().then(() => onPage("takes"))}
          onField={(shots) => editor.change((old) => ({ ...old, shots }))}
        />
      </div>
    </div>
  );
}
