"use client";
import { useState } from "react";
import { MovieExport } from "@/components/workbench/MovieExport";
import "@/components/workspace/spec/tools/studio-css";
import { Price } from "@/components/graphite/Price";
import { FREE } from "@/lib/shell/price-words";
import { makeFCPXML, makeXMEML } from "@/lib/workbench/editorial-xml";
import { withExportNames } from "@/lib/workbench/export-names";
import { downloadFile, exportPackage } from "@/lib/workbench/studio-export";
import { makeEDL, safeName } from "@/lib/workbench/studio";
import { useSession } from "@/lib/session";
import { deliverRows, type CutCardData } from "../cards/cut/cut-model";
import { SpecRowView } from "../cards/deliver/SpecRow";
import { useLoudnessInput } from "../edit/loudness-store";
import type { CardProps } from "../cards/types";

/*
 * The Inspector on the Deliver card: the spec and its checks, the existing browser export (Export the cut: free,
 * with its progress and Download), and, folded under Advanced, the exports the frame does not draw: the editorial
 * package, EDL, FCPXML and Premiere XML. Nothing here is paid and nothing is sent anywhere.
 */

export const EXPORTS = [
  ["EDL", ".edl", "text/plain", makeEDL, "insp-export-edl"],
  ["FCPXML · Final Cut, Resolve", ".fcpxml", "application/xml", makeFCPXML, "insp-export-fcpxml"],
  ["XML · Premiere", ".xml", "application/xml", makeXMEML, "insp-export-xml"],
] as const;

export function DeliverBody({ data, ctx }: CardProps<CutCardData>) {
  const { signedIn } = useSession();
  const { cut } = data;
  const [advanced, setAdvanced] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  const act = signedIn && !ctx.offline;
  const loudness = useLoudnessInput(ctx.project);
  const project = ctx.project;
  const run = async (label: string, work: () => Promise<void> | void) => {
    setNote(null);
    try { await work(); setNote({ error: false, text: `${label} downloaded.` }); }
    catch (error) { setNote({ error: true, text: error instanceof Error ? error.message : "Could not export." }); }
  };
  return (
    <div className="gx-insp-take" data-testid="insp-deliver">
      <div>
        <div className="gx-insp-title">Deliver</div>
        <div className="gx-insp-meta">{cut.aspect} · {cut.fps} fps</div>
      </div>
      <div className="gx-insp-rows-plain">{deliverRows(cut, loudness).map((r) => <SpecRowView key={r.key} row={r} />)}</div>
      {act ? (
        <section data-testid="insp-render">
          <div className="gx-insp-eyebrow-row"><span className="gx-insp-eyebrow">Export the cut</span><Price value={FREE} /></div>
          {cut.problem && cut.clips.length === 0 ? <p className="gx-insp-quiet">{cut.problem}</p> : <div className="ps"><MovieExport project={project} scope={ctx.scope} /></div>}
        </section>
      ) : null}
      {act ? (
        <section>
          <button type="button" className="gx-insp-fold" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)} data-testid="insp-advanced">
            <span className="gx-insp-eyebrow">Advanced</span><span>{advanced ? "Hide" : "Show"}</span>
          </button>
          {advanced ? (
            <div className="gx-insp-actions" data-testid="insp-exports">
              <button type="button" className="gx-insp-act" disabled={!project.shots.length} onClick={() => void run("The editorial package", () => exportPackage(project))} data-testid="insp-export-package">Download package</button>
              {EXPORTS.map(([label, ext, type, make, testid]) => (
                <button key={ext} type="button" className="gx-insp-act" disabled={!project.shots.length} data-testid={testid}
                  onClick={() => void run(label.split(" ·")[0], async () => downloadFile(new Blob([make(await withExportNames(project))], { type }), safeName(project.name) + ext))}>
                  {label}
                </button>
              ))}
              {note ? <span className={note.error ? "gx-insp-hint" : "gx-insp-quiet"} role={note.error ? "alert" : "status"}>{note.text}</span> : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
