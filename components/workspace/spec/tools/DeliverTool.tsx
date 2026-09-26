"use client";
import { useEffect, useState } from "react";
import { MovieExport } from "@/components/workbench/MovieExport";
import { downloadFile, exportPackage } from "@/lib/workbench/studio-export";
import { withExportNames } from "@/lib/workbench/export-names";
import { makeEDL, safeName, type Project } from "@/lib/workbench/studio";
import { makeFCPXML, makeXMEML, retimeProject } from "@/lib/workbench/editorial-xml";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import "./studio-css";
import { DraftGate, DraftStatus } from "./DraftStatus";

/**
 * Deliver: Studio's editorial package and EDL (lib/workbench/studio-export)
 * and the existing MovieExport, both against the saved draft; the cut as
 * EDL, FCPXML (Final Cut Pro, Resolve) or Final Cut Pro 7 XML (Premiere). The
 * delivery spec is edited here: a new frame rate retimes the cut in real time.
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
      {/* A retime or a new aspect is a draft edit: its save state (and a refused save) shows here. */}
      <DraftStatus editor={editor} />
      <div className="pxw-package">
        <div className="pxw-package-facts">
          <div><span>Sequence events</span><strong>{p.shots.length.toLocaleString("en-US")}</strong></div>
          <div><span>Runtime</span><strong>{(p.fps ? frames / p.fps : 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} s</strong></div>
          <label><span>Frame rate</span>
            <select aria-label="Frame rate" value={p.fps} onChange={(e) => { const fps = Number(e.target.value) as 24 | 25 | 30; editor.change((old) => retimeProject(old, fps)); }} data-testid="deliver-fps">
              {[24, 25, 30].map((fps) => <option key={fps} value={fps}>{fps} fps · non-drop</option>)}
            </select>
          </label>
          <label><span>Aspect</span>
            <select aria-label="Aspect" value={p.aspect} onChange={(e) => { const aspect = e.target.value as Project["aspect"]; editor.change((old) => ({ ...old, aspect })); }} data-testid="deliver-aspect">
              {(["16:9", "9:16", "1:1", "4:5"] as const).map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
        </div>
        <p className="pxw-package-note">
          Editorial package: CMX3600 EDL, FCPXML and Final Cut Pro 7 XML, source media, shot list and provenance. Aspect ratio is a delivery note, not a reframe.
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
          {([
            ["EDL", ".edl", "text/plain", makeEDL, "deliver-edl"],
            ["FCPXML · Final Cut, Resolve", ".fcpxml", "application/xml", makeFCPXML, "deliver-fcpxml"],
            ["XML · Premiere", ".xml", "application/xml", makeXMEML, "deliver-xml"],
          ] as const).map(([label, ext, type, make, testid]) => (
            <button key={ext} type="button" className="pxw-btn pxw-btn--control" disabled={!p.shots.length} data-testid={testid}
              onClick={async () => {
                try {
                  downloadFile(new Blob([make(await withExportNames(p))], { type }), safeName(p.name) + ext);
                  setMessage({ kind: "status", text: `${label.split(" ·")[0]} downloaded. Its clips point at media/ in the package.` });
                } catch (error) {
                  setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not export." });
                }
              }}>
              {label}
            </button>
          ))}
        </div>
        {!p.shots.length ? <p className="pxw-package-note">Add a shot to the sequence before packaging.</p> : null}
        {message ? <p className={message.kind === "error" ? "pxw-package-error" : "pxw-package-note"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p> : null}
      </div>
    </div>
  );
}
