"use client";
import { useMemo, useState } from "react";
import { DUBBING_LANGUAGES, dubbingLanguageLabel, isDubbingLanguage } from "@/lib/workbench/dubbing-options";
import { makeEDL, safeName } from "@/lib/workbench/studio";
import { withExportNames } from "@/lib/workbench/export-names";
import { downloadFile, exportPackage } from "@/lib/workbench/studio-export";
import { makeFCPXML, makeXMEML } from "@/lib/workbench/editorial-xml";
import { ADAPT_WHY, EDIT_HAS, languageLimit, EDIT_LACKS, GRID_SECONDS, LANGUAGE_PARTS, LANGUAGE_WHY, MANDATORIES, MANDATORIES_WHY, PACK_ROWS, PACK_WHY, POST_DIRECTLY, deliverGrid, deliverLines, gridSummary, nameStem, type DeliverCell } from "@/lib/v12/deliver";
import { FREE_QUOTE } from "@/lib/v12/quote";
import { Price } from "@/components/v12/ui/Price";
import { deliverRows, type CutData } from "@/components/graphite/board/cards/cut/cut-model";
import { SpecRowView } from "@/components/graphite/board/cards/deliver/SpecRow";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import "./stage-pages.css";

/**
 * The Deliver stage (docs/redesign/inventory.md § 6.7; prototype L580, L591): what the cut is delivered as, in the
 * prototype's layout, drawn from today's data (lib/v12/deliver.ts says what is real and what is not built).
 *
 * Real: the cut's own checks, a free export of the cut in the browser (the Deliver card's Inspector), and the editorial
 * package (source media, EDL, Final Cut / Resolve XML, Premiere XML). Everything that needs another size, another length, a
 * dub, a lip-sync or a translated line is drawn and disabled with its reason, and its price reads "quoted": no route
 * quotes it, and no figure is written here. Nothing is sent anywhere, and posting is Later: every post is a person's.
 */
const XML = [
  ["Premiere XML", makeXMEML, ".xml", "application/xml", "deliver-xml-premiere"],
  ["Final Cut · Resolve XML", makeFCPXML, ".fcpxml", "application/xml", "deliver-xml-fcpxml"],
  ["EDL", makeEDL, ".edl", "text/plain", "deliver-edl"],
] as const;

export function DeliverStage({ cut, cardId, ctx, languages, onLanguages }: {
  cut: CutData;
  cardId: string;
  ctx: BoardCtx;
  languages: readonly string[];
  /** Saves the list in the board's draft; the refusal, or null. */
  onLanguages: (next: string[]) => string | null;
}) {
  const project = ctx.project;
  const stem = nameStem(project.name);
  const grid = useMemo(() => deliverGrid(stem, { aspect: cut.aspect, seconds: cut.seconds, complete: cut.complete, empty: cut.clips.length === 0 }), [stem, cut.aspect, cut.seconds, cut.complete, cut.clips.length]);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  const act = !ctx.offline && !ctx.readOnly;
  const run = async (label: string, work: () => Promise<void> | void) => {
    setNote(null);
    try { await work(); setNote({ error: false, text: `${label} downloaded.` }); }
    catch (error) { setNote({ error: true, text: error instanceof Error ? error.message : "Could not export." }); }
  };
  const noShots = project.shots.length === 0;
  const full = languageLimit(languages.length);
  const add = (code: string) => { if (full || !isDubbingLanguage(code) || languages.includes(code)) return; const refused = onLanguages([...languages, code]); if (refused) ctx.toast(refused); };
  const left = (c: DeliverCell) => (c.state === "ready" ? "Ready" : c.state === "waiting" ? "Waiting" : "Not made");

  return (
    <div className="v12-sp v12-ds" data-testid="v12-deliver-stage">
      <section className="v12-sp-card v12-ds-grid" aria-labelledby="v12-ds-grid-h" data-testid="v12-deliver-grid-card">
        <header className="v12-sp-head"><h2 className="v12-sp-title" id="v12-ds-grid-h">Deliverables</h2><span className="v12-sp-state" data-testid="v12-deliver-summary">{gridSummary(grid)}</span></header>
        <div className="v12-ds-table" role="table" aria-label="Deliverables by size and length">
          <div className="v12-ds-row v12-ds-headrow" role="row">
            <span role="columnheader" className="v12-ds-corner" />
            <span role="columnheader">Master</span>
            {GRID_SECONDS.map((s) => <span role="columnheader" key={s}>{s} s</span>)}
          </div>
          {grid.map((row) => (
            <div className="v12-ds-row" role="row" key={row.aspect}>
              <span role="rowheader" className="v12-ds-aspect">{row.aspect}</span>
              {row.cells.map((cell) => (
                <span key={cell.seconds} role="cell" className="v12-ds-cell" data-state={cell.state} data-testid="v12-deliver-cell" title={cell.why ?? `${cell.name} · ready to export`} data-aspect={cell.aspect} data-seconds={cell.seconds}>
                  <span className="v12-ds-dot" aria-hidden="true" />
                  <span className="v12-ds-cell-state">{left(cell)}</span>
                  <span className="v12-ds-cell-name">{cell.name}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
        <dl className="v12-sp-lines">
          {deliverLines(stem).map(([k, v]) => <div key={k} className="v12-sp-line"><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        <div className="v12-sp-acts">
          <button type="button" className="v12-sp-btn v12-sp-primary" disabled={!act || cut.clips.length === 0} onClick={() => ctx.openInspector(cardId)}
            title={cut.clips.length === 0 ? "Add takes to the cut first" : "Encodes the cut into a video file in your browser. Free: nothing is charged."} data-testid="v12-deliver-export-cut">
            Export the cut · <Price quote={FREE_QUOTE} />
          </button>
          <button type="button" className="v12-sp-btn" disabled title={ADAPT_WHY} data-testid="v12-deliver-adapt-all">Adapt all · <Price quote={null} reason="adaptCut" /></button>
        </div>
        <p className="v12-sp-why" data-testid="v12-deliver-why">{ADAPT_WHY}</p>
      </section>

      <section className="v12-sp-card" aria-labelledby="v12-ds-spec-h" data-testid="v12-deliver-spec">
        <header className="v12-sp-head"><h2 className="v12-sp-title" id="v12-ds-spec-h">Spec check</h2><span className="v12-sp-state">{cut.aspect} · {cut.fps} fps</span></header>
        <div className="v12-ds-spec">{deliverRows(cut).map((r) => <SpecRowView key={r.key} row={r} />)}</div>
      </section>

      <section className="v12-sp-card" aria-labelledby="v12-ds-lang-h" data-testid="v12-deliver-languages">
        <header className="v12-sp-head"><h2 className="v12-sp-title" id="v12-ds-lang-h">Languages</h2><span className="v12-sp-state">{languages.length ? `${languages.length} added` : "Master only"}</span></header>
        <dl className="v12-sp-lines">
          <div className="v12-sp-line"><dt>Master</dt><dd>the cut’s own voice <span className="v12-sp-ok" aria-hidden="true">✓</span></dd></div>
          {languages.map((code) => (
            <div className="v12-sp-line" key={code} data-testid="v12-deliver-language" data-code={code}>
              <dt>{dubbingLanguageLabel(code)}</dt>
              <dd title={LANGUAGE_WHY}>{LANGUAGE_PARTS.join(" · ")} · <Price quote={null} reason="languageAdapt" />
                {act ? <button type="button" className="v12-sp-x" aria-label={`Remove ${dubbingLanguageLabel(code)}`} onClick={() => { const refused = onLanguages(languages.filter((c) => c !== code)); if (refused) ctx.toast(refused); }}>×</button> : null}
              </dd>
            </div>
          ))}
        </dl>
        <div className="v12-sp-acts">
          {act ? (
            <select className="v12-sp-select" aria-label="Add a language" value="" disabled={Boolean(full)} title={full ?? undefined} onChange={(e) => add(e.target.value)} data-testid="v12-deliver-add-language">
              <option value="">Add a language</option>
              {DUBBING_LANGUAGES.filter((l) => !languages.includes(l.code)).map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          ) : null}
          <button type="button" className="v12-sp-btn" disabled title={LANGUAGE_WHY} data-testid="v12-deliver-adapt-languages">Adapt all languages · <Price quote={null} reason="languageAdapt" /></button>
        </div>
        <p className="v12-sp-why">{LANGUAGE_WHY}</p>
      </section>

      <section className="v12-sp-card" aria-labelledby="v12-ds-mand-h" data-testid="v12-deliver-mandatories">
        <header className="v12-sp-head"><h2 className="v12-sp-title" id="v12-ds-mand-h">Mandatories check</h2><span className="v12-sp-state">Not checked</span></header>
        <dl className="v12-sp-lines">
          {MANDATORIES.map((m) => <div key={m} className="v12-sp-line"><dt>{m}</dt><dd>Not checked</dd></div>)}
        </dl>
        <p className="v12-sp-why" data-testid="v12-deliver-mandatories-why">{MANDATORIES_WHY}</p>
      </section>

      <section className="v12-sp-card" aria-labelledby="v12-ds-pack-h" data-testid="v12-deliver-pack">
        <header className="v12-sp-head"><h2 className="v12-sp-title" id="v12-ds-pack-h">Export pack</h2></header>
        <dl className="v12-sp-lines">
          {PACK_ROWS.map((r) => <div key={r.platform} className="v12-sp-line" data-testid="v12-deliver-platform" title={PACK_WHY}><dt>{r.platform}</dt><dd>{r.spec}</dd></div>)}
          <div className="v12-sp-line"><dt>Edit</dt><dd>{EDIT_HAS}</dd></div>
          <div className="v12-sp-line"><dt>{POST_DIRECTLY.label}</dt><dd data-testid="v12-deliver-post">{POST_DIRECTLY.value}</dd></div>
        </dl>
        <div className="v12-sp-acts">
          <button type="button" className="v12-sp-btn" disabled={!act || noShots} onClick={() => void run("The export pack", () => exportPackage(project))} data-testid="v12-deliver-export-pack"
            title="The cut’s source media with its EDL, Final Cut / Resolve XML and Premiere XML, in one file. Free: it is made in your browser.">
            Export pack · <Price quote={FREE_QUOTE} />
          </button>
          {XML.map(([label, make, ext, type, testId]) => (
            <button key={ext} type="button" className="v12-sp-btn" disabled={!act || noShots} data-testid={testId}
              onClick={() => void run(label, async () => downloadFile(new Blob([make(await withExportNames(project))], { type }), safeName(project.name) + ext))}>{label}</button>
          ))}
        </div>
        <p className="v12-sp-why">{PACK_WHY} {EDIT_LACKS}</p>
        {note ? <p className={note.error ? "v12-sp-why v12-sp-problem" : "v12-sp-why"} role={note.error ? "alert" : "status"}>{note.text}</p> : null}
      </section>
    </div>
  );
}
