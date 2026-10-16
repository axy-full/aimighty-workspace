"use client";
import { useEffect, useState } from "react";
import { dubbingLanguageLabel } from "@/lib/workbench/dubbing-options";
import { BASE_LANGUAGE, voiceOf, type BoardCut, type CutCaptions } from "@/lib/v12/board/cut-data";
import { FREE_QUOTE } from "@/lib/v12/quote";
import { Price } from "@/components/v12/ui/Price";
import { CutCard } from "@/components/graphite/board/cards/cut/CutCard";
import type { CutCardData } from "@/components/graphite/board/cards/cut/cut-model";
import type { BoardCard } from "@/lib/board/types";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import { useFilmExport } from "./film-export";
import "./stage-pages.css";

/**
 * The Edit stage (v25 plan, PR 22/23-lite): the cut as it is, how it is dressed, and one finished MP4 for each language the board
 * holds. "Export MP4" asks `export_film` for the board's own saved draft in that language (lib/exports/film.ts): the shots, that
 * language's voice lines (their words as captions and subtitle files), the music, the title and end cards. Free, queued like any
 * export, and said so in words as it goes. What a version needs (Hindi voice lines, lip-synced shots) is made on its own tools
 * and written to the draft (`boardVoice`, lib/v12/board/cut-data.ts); this page only places and exports it.
 */
const CAPTION_CHOICES: { value: Exclude<CutCaptions, null> | "off"; label: string }[] = [
  { value: "off", label: "Off" }, { value: "clean", label: "Clean" }, { value: "bold", label: "Bold" }, { value: "karaoke", label: "Karaoke" },
];

function Row({ board, language, lines, swaps, ready, why, saving }: { board: string; language: string; lines: number; swaps: number; ready: boolean; why: string | null; saving: boolean }) {
  const { state, start, reset } = useFilmExport(board, language);
  const label = language === BASE_LANGUAGE ? "English" : dubbingLanguageLabel(language);
  const busy = state.phase === "starting" || state.phase === "working";
  const facts = [lines ? `${lines} voice ${lines === 1 ? "line" : "lines"}` : language === BASE_LANGUAGE ? "the shots' own sound" : "no voice lines yet", swaps ? `${swaps} ${swaps === 1 ? "shot" : "shots"} replaced` : null].filter(Boolean).join(" · ");
  const blocked = !ready ? why : language !== BASE_LANGUAGE && !lines && !swaps ? `There is no ${label} version yet: it needs ${label} voice lines.` : null;
  return (
    <div className="v12-es-row" data-testid="v12-edit-language" data-code={language} data-phase={state.phase}>
      <div className="v12-es-who"><span className="v12-es-name">{label}</span><span className="v12-es-facts">{facts}</span></div>
      <div className="v12-es-act">
        {state.phase === "ready" ? (
          <span className="v12-es-done" role="status" data-testid="v12-edit-ready">
            {state.files.map((file) => <a key={file.url} className="v12-es-link" href={file.url} download={file.filename} data-kind={file.kind}>{file.kind === "video" ? "Download MP4" : file.filename.split(".").pop()?.toUpperCase()}</a>)}
            <button type="button" className="v12-sp-btn" onClick={reset}>Start again</button>
          </span>
        ) : state.phase === "failed" ? (
          <span className="v12-es-fail" role="alert" data-testid="v12-edit-failed">
            <span className="v12-sp-problem">{state.error}</span>
            <button type="button" className="v12-sp-btn" onClick={start}>Retry</button>
          </span>
        ) : (
          <>
            {state.phase === "working" ? <span className="v12-es-line" role="status" data-testid="v12-edit-working">{state.line}</span> : null}
            <button type="button" className="v12-sp-btn v12-sp-primary" disabled={busy || saving || Boolean(blocked)} title={blocked ?? (saving ? "Saving the board first" : "Free: nothing is charged.")} onClick={start} data-testid="v12-edit-export">
              {busy ? "Making…" : <>Export MP4 · <Price quote={FREE_QUOTE} /></>}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, placeholder, onCommit, disabled, testId }: { label: string; value: string; placeholder: string; onCommit: (next: string) => void; disabled: boolean; testId: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="v12-es-field"><span>{label}</span>
      <input className="v12-es-input" value={text} placeholder={placeholder} disabled={disabled} maxLength={160} data-testid={testId}
        onChange={(e) => setText(e.target.value)} onBlur={() => { if (text.trim() !== value) onCommit(text.trim()); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

export function EditStage({ cutCard, ctx, languages }: { cutCard: BoardCard<CutCardData>; ctx: BoardCtx; languages: readonly string[] }) {
  const project = ctx.project;
  const cut = (cutCard.data as CutCardData).cut;
  const act = !ctx.offline && !ctx.readOnly;
  const draft: BoardCut = project.boardCut ?? {};
  const codes = [BASE_LANGUAGE, ...[...new Set([...languages, ...Object.keys(project.boardVoice ?? {})])].filter((c) => c !== BASE_LANGUAGE)];
  const write = (next: BoardCut) => { const refused = ctx.rig.apply((p) => ({ ...p, boardCut: next })); if (refused) ctx.toast(refused); };
  const without = <K extends keyof BoardCut>(key: K): BoardCut => { const { [key]: _gone, ...rest } = draft; return rest; };
  const ready = cut.clips.length > 0;
  const why = ready ? null : "Add takes to the cut first.";
  const saving = ctx.rig.saveState === "saving";
  const captions = draft.captions ?? "off";
  return (
    <div className="v12-sp v12-es" data-testid="v12-edit-stage">
      <section className="v12-sp-card v12-es-cut" aria-label="The cut" data-testid="v12-edit-cut">
        <CutCard card={cutCard} data={cutCard.data as CutCardData} selected={false} ctx={ctx} />
      </section>
      <section className="v12-sp-card" aria-labelledby="v12-es-film-h" data-testid="v12-edit-film">
        <header className="v12-sp-head">
          <h2 className="v12-sp-title" id="v12-es-film-h">Film</h2>
          <button type="button" className="v12-sp-btn" onClick={() => ctx.askAtomik("For the Edit stage: ")} data-testid="v12-edit-ask">Ask Atomik</button>
        </header>
        <div className="v12-es-fields">
          <label className="v12-es-field"><span>Captions</span>
            <select className="v12-sp-select" value={captions} disabled={!act} data-testid="v12-edit-captions"
              onChange={(e) => (e.target.value === "off" ? write({ ...draft, captions: null }) : write({ ...draft, captions: e.target.value as Exclude<CutCaptions, null> }))}>
              {CAPTION_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <Field label="Title card" value={draft.title?.title ?? ""} placeholder="None" disabled={!act} testId="v12-edit-title"
            onCommit={(text) => write(text ? { ...draft, title: { ...draft.title, title: text } } : without("title"))} />
          <Field label="End card" value={draft.end?.headline ?? ""} placeholder="None" disabled={!act} testId="v12-edit-end"
            onCommit={(text) => write(text ? { ...draft, end: { ...draft.end, headline: text } } : without("end"))} />
        </div>
      </section>
      <section className="v12-sp-card" aria-labelledby="v12-es-lang-h" data-testid="v12-edit-languages">
        <header className="v12-sp-head"><h2 className="v12-sp-title" id="v12-es-lang-h">Export</h2><span className="v12-sp-state">{codes.length === 1 ? "One version" : `${codes.length} versions`}</span></header>
        <div className="v12-es-rows">
          {codes.map((code) => { const voice = voiceOf(project.boardVoice, code); return <Row key={code} board={project.id} language={code} lines={voice.lines.length} swaps={Object.keys(voice.swap ?? {}).length} ready={ready} why={why} saving={saving} />; })}
        </div>
        {!ctx.offline ? null : <p className="v12-sp-why">Offline · exports start when you are back online.</p>}
      </section>
    </div>
  );
}
