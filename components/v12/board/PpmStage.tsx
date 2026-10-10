"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { downloadFile } from "@/lib/workbench/studio-export";
import { nameStem } from "@/lib/v12/deliver";
import { CELL_MAX, DECK_EXPORTS, SHOT_COLUMNS, deckFacts, deckSections, shotListCsv, shotListFile, shotListTitle, shotRows, withShotEdit, type ShotField, type ShotRow } from "@/lib/v12/ppm";
import { FREE_QUOTE } from "@/lib/v12/quote";
import { Price } from "@/components/v12/ui/Price";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import "./stage-pages.css";

/**
 * The PPM deck (Pre-vis; docs/redesign/inventory.md § 6.7; prototype L604, L587): the deck's eight sections, each saying what
 * this board holds for it, and the shot list as an editable table kept in the board's draft (lib/v12/ppm.ts: `boardShotList`,
 * saved as you edit, with no table of its own). The cover carries the workspace's own logo when it has one.
 *
 * Exports are free. The shot list CSV is made in the browser; the deck and shot list PDFs and the animatic MP4 are not built
 * (Particl has no PDF writer and no animatic renderer), and say so.
 */
export function PpmStage({ ctx }: { ctx: BoardCtx }) {
  const project = ctx.project;
  const fetcher = useScopedFetch(ctx.scope);
  const [logo, setLogo] = useState<string | null>(null);
  /* The workspace's own mark, if it set one (Settings: brandLogoUploadId): read once for the cover. */
  useEffect(() => {
    let live = true;
    void fetcher("/api/settings", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((body: { settings?: Record<string, unknown> } | null) => {
      const id = body?.settings?.brandLogoUploadId;
      if (live) setLogo(typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? `/api/uploads/${id}` : null);
    }).catch(() => { if (live) setLogo(null); });
    return () => { live = false; };
  }, [fetcher]);

  const rows = useMemo(() => shotRows(project.production?.beats, project.boardShotList), [project.production?.beats, project.boardShotList]);
  const sections = useMemo(() => deckSections({ ...deckFacts(project), shots: rows.length }, Boolean(logo)), [project, rows.length, logo]);
  const stem = nameStem(project.name);
  const canEdit = !ctx.offline && !ctx.readOnly;
  const [note, setNote] = useState<string | null>(null);

  const edit = (row: ShotRow, field: ShotField, value: string) => {
    if (value === row[field]) return;
    const refused = ctx.rig.apply((p) => ({ ...p, boardShotList: withShotEdit(p.boardShotList, row.id, field, value) }));
    if (refused) ctx.toast(refused);
  };

  return (
    <div className="v12-sp v12-ppm" data-testid="v12-ppm-stage">
      <section className="v12-sp-card v12-ppm-cover" aria-labelledby="v12-ppm-h" data-testid="v12-ppm-deck">
        <header className="v12-sp-head"><span className="v12-sp-eyebrow">PPM deck · cover</span></header>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- the workspace's own upload, served by its own route
          <img className="v12-ppm-logo" src={logo} alt="Your logo" data-testid="v12-ppm-logo" onError={() => setLogo(null)} />
        ) : null}
        <h2 className="v12-sp-title" id="v12-ppm-h">{project.name || "Untitled board"} · PPM</h2>
        <ol className="v12-ppm-sections">
          {sections.map((s) => (
            <li key={s.n} className="v12-ppm-section" data-empty={s.empty || undefined} data-testid="v12-ppm-section">
              <span className="v12-ppm-n" aria-hidden="true">{s.n}</span>
              <span className="v12-ppm-stitle">{s.title}</span>
              <span className="v12-ppm-line">{s.line}</span>
            </li>
          ))}
        </ol>
        <div className="v12-sp-acts" data-testid="v12-ppm-exports">
          {DECK_EXPORTS.map((x) => (
            <button key={x.id} type="button" className={x.id === "deck" ? "v12-sp-btn v12-sp-primary" : "v12-sp-btn"} disabled={!x.built || rows.length === 0} title={x.built ? (rows.length ? "Free: made in your browser." : "There are no shots to list yet.") : x.why ?? ""}
              data-testid={`v12-ppm-export-${x.id}`}
              onClick={() => { if (x.id === "csv") { downloadFile(new Blob([shotListCsv(rows)], { type: "text/csv;charset=utf-8" }), shotListFile(stem)); setNote("Shot list CSV downloaded."); } }}>
              {x.label} · <Price quote={FREE_QUOTE} />
            </button>
          ))}
        </div>
        <p className="v12-sp-why">The CSV is made in your browser. Particl doesn’t make PDFs or the animatic MP4 yet.</p>
        {note ? <p className="v12-sp-why" role="status">{note}</p> : null}
      </section>

      <section className="v12-sp-card v12-ppm-list" aria-labelledby="v12-ppm-list-h" data-testid="v12-ppm-shotlist">
        <header className="v12-sp-head"><h2 className="v12-sp-title" id="v12-ppm-list-h">Shot list · {shotListTitle(rows)}</h2><span className="v12-sp-state">{canEdit ? "Click a cell to edit · saves as you type" : "Read only"}</span></header>
        {rows.length === 0 ? (
          <p className="v12-sp-why" data-testid="v12-ppm-shotlist-empty">No shots yet. They come from the script’s beat sheet.</p>
        ) : (
          <div className="v12-ppm-scroll">
            <table className="v12-ppm-table">
              <thead><tr>{SHOT_COLUMNS.map((c) => <th key={c.field} scope="col" data-col={c.field}>{c.label}</th>)}</tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-testid="v12-ppm-row" data-shot={row.id}>
                    {SHOT_COLUMNS.map((c) => c.field === "shot" ? <th key="shot" scope="row" className="v12-ppm-num">{row.index}</th> : (
                      <td key={c.field} data-col={c.field}>
                        <Cell value={row[c.field]} label={`${c.label} of shot ${row.index}`} disabled={!canEdit} onCommit={(v) => edit(row, c.field as ShotField, v)} testId={`v12-ppm-cell-${c.field}`} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** A cell that is its own field: typing shows at once, and the draft saves when the field is left or Enter is pressed. */
function Cell({ value, label, disabled, onCommit, testId }: { value: string; label: string; disabled: boolean; onCommit: (value: string) => void; testId: string }) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  /* What the draft holds now (another window, Undo) replaces what was typed once it differs. */
  if (value !== seen) { setSeen(value); setText(value); }
  /* Saved as you type: a moment after the last key. Leaving the field saves at once. */
  const commit = useRef(onCommit);
  useEffect(() => { commit.current = onCommit; });
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => commit.current(text), 600);
    return () => clearTimeout(timer);
  }, [text, value]);
  return (
    <input className="v12-ppm-cell" value={text} aria-label={label} maxLength={CELL_MAX} disabled={disabled} data-testid={testId}
      onChange={(e) => setText(e.target.value)} onBlur={() => onCommit(text)}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onCommit(text); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") { setText(value); (e.target as HTMLInputElement).blur(); } }} />
  );
}
