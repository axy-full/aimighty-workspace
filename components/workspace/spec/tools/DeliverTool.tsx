"use client";
import { useEffect, useState } from "react";
import { MovieExport } from "@/components/workbench/MovieExport";
import { suiteHref } from "@/lib/suites";
import { downloadFile, exportPackage } from "@/lib/workbench/studio-export";
import { makeEDL, safeName, type Project } from "@/lib/workbench/studio";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import "./studio-css";
import { DraftGate } from "./DraftStatus";

/**
 * Deliver: Studio's editorial package and EDL (lib/workbench/studio-export)
 * and the existing MovieExport, both against the saved draft. The delivery
 * spec itself (frame rate, aspect) is edited in Studio, which retimes the
 * sequence when the frame rate changes.
 */
export default function DeliverTool({ tool, projectId, scope, onProject }: { tool: string; projectId: string; scope: string; onProject: (project: Project) => void }) {
  const editor = useDraftEditor(scope, projectId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "status"; text: string } | null>(null);
  useEffect(() => {
    if (editor.project) onProject(editor.project);
  }, [editor.project, onProject]);
  if (editor.status !== "ready" || !editor.project) return <DraftGate editor={editor} label="the delivery" />;
  const p = editor.project;
  const frames = p.shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (tool === "movie")
    return (
      <div className="pxw-tool pxw-tool--movie ps" data-tool-body="movie">
        <MovieExport project={p} scope={scope} />
      </div>
    );
  return (
    <div className="pxw-tool pxw-tool--package" data-tool-body="package">
      <div className="pxw-package">
        <div className="pxw-package-facts">
          <div><span>Sequence events</span><strong>{p.shots.length.toLocaleString("en-US")}</strong></div>
          <div><span>Runtime</span><strong>{(p.fps ? frames / p.fps : 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} s</strong></div>
          <div><span>Frame rate</span><strong>{p.fps} fps · non-drop</strong></div>
          <div><span>Aspect</span><strong>{p.aspect}</strong></div>
        </div>
        <p className="pxw-package-note">
          Editorial package: CMX3600 EDL, source media, shot list and provenance. Aspect ratio is a delivery note, not a reframe.
        </p>
        <div className="pxw-package-actions">
          <button
            type="button"
            className="pxw-btn pxw-btn--primary"
            disabled={busy || !p.shots.length}
            onClick={async () => {
              setBusy(true);
              setMessage(null);
              try {
                await exportPackage(p);
                setMessage({ kind: "status", text: "Editorial package downloaded." });
              } catch (error) {
                setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not export." });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Preparing package…" : "Download package"}
          </button>
          <button
            type="button"
            className="pxw-btn pxw-btn--control"
            disabled={!p.shots.length}
            onClick={() => {
              try {
                downloadFile(new Blob([makeEDL(p)], { type: "text/plain" }), safeName(p.name) + ".edl");
                setMessage(null);
              } catch (error) {
                setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not export EDL." });
              }
            }}
          >
            EDL only
          </button>
          <a className="pxw-btn pxw-btn--control" href={suiteHref("particl", p.id, "export")}>Change the spec in Studio</a>
        </div>
        {!p.shots.length ? <p className="pxw-package-note">Add a shot to the sequence before packaging.</p> : null}
        {message ? <p className={message.kind === "error" ? "pxw-package-error" : "pxw-package-note"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p> : null}
      </div>
    </div>
  );
}
