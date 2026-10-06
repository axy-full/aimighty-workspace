"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { MODELS, displayModelName, isOffered } from "@/lib/models";
import { Glyph } from "./icons";
import { newPaletteIndex, searchNewPalette, type PaletteRow, type PaletteRun } from "@/lib/shell/palette";
import { useShell } from "@/lib/shell/state";
import { useWorkspace } from "@/lib/workspace/state";
import { STUDIO_RAIL } from "@/lib/board/regions";
import { atomikIntent, matchPlace, takePaletteQuery } from "@/lib/shell/atomik-panel";
import type { LibraryEntry } from "@/lib/workspace/library";
import type { Project } from "@/lib/workbench/studio";
import { usePlaces } from "./atomik/panel/use-places";
import { PaletteAskCard, PaletteMakeCard } from "./atomik/panel/PaletteCards";
import { PaletteApproveCard } from "./atomik/panel/PaletteApprove";
import "./atomik/panel/panel.css";
import "./palette.css";

/**
 * ⌘K (README § 3.4): search and Atomik in one box — Home, the board's places, Make, Atomik and its control room, Settings,
 * models and assets, and under them Atomik's card for what was typed ("go to …", "make …", "approve everything under N cr",
 * a question, a request). Enter runs the top hit; Esc closes.
 */
export function Palette(props: { items: LibraryEntry[]; onAsk: (text: string) => void; project?: Project | null }) {
  const shell = useShell();
  /* Mounted only while open, so every opening starts from an empty query (or the one it was opened with). */
  if (!shell.palette) return null;
  return <AtomikPalette items={props.items} project={props.project ?? null} />;
}

function AtomikPalette({ items, project }: { items: LibraryEntry[]; project: Project | null }) {
  const shell = useShell();
  const { dispatch } = useWorkspace();
  const places = usePlaces();
  const [query, setQuery] = useState(takePaletteQuery);
  /* The words came in the address (`&q=`): they leave it, so a reload does not type them again. */
  const { live } = shell;
  useEffect(() => {
    /* After the shell's own landing write, which would put them back, and from the shell as it is by then. */
    const later = setTimeout(() => live().setScreenParams({ q: null }, "replace"), 0);
    return () => clearTimeout(later);
  }, [live]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const intent = useMemo(() => atomikIntent(query), [query]);
  const index = useMemo(() => newPaletteIndex({
    rail: STUDIO_RAIL,
    models: MODELS.filter((m) => isOffered(m) && !m.hidden).map((m) => ({ id: m.id, name: displayModelName(m.id), kind: m.kind === "video" ? "Video" : "Image" })),
    assets: items.map((i) => ({ id: i.take.id, name: i.take.name, kind: i.media ?? "file" })),
  }), [items]);
  const goTo = intent.kind === "go" ? matchPlace(intent.place, STUDIO_RAIL) : null;
  /* A command answers in its card alone; a question or a request lists what it also finds. */
  const rows: PaletteRow[] = useMemo(() => intent.kind === "approve" || intent.kind === "make" || intent.kind === "memory" ? [] : searchNewPalette(index, query, { goTo, board: "Studio" }), [index, intent.kind, query, goTo]);
  const close = () => shell.setPalette(false);
  const run = (r: PaletteRun) => {
    close();
    switch (r.type) {
      case "home": places.home(); return;
      case "region": places.region(r.region); return;
      case "board": shell.goBoard({ kind: r.kind }); return;
      case "atomik": shell.openAtomik("panel"); return;
      case "control": places.control(r.page); return;
      case "settings": places.settings(r.section); return;
      case "gen": shell.openMake(r.tool); return;
      case "model": {
        const model = MODELS.find((m) => m.id === r.id && isOffered(m));
        if (model) shell.openMake({ prompt: "", model: model.id, type: model.kind, billing: "workspace" });
        else shell.openMake();
        return;
      }
      case "asset": dispatch({ type: "patch", patch: { selKind: "take", selId: r.id } }); shell.openInspector(); return;
      default: return;
    }
  };
  /* Enter: the row picked, else the card's free action. A priced card's words go to Atomik's panel unsent. */
  const enterRef = useRef<(() => void) | null>(null);
  return (
    <div className="gx-veil gx-palette-veil" onClick={close} data-testid="palette-veil">
      <div className="gx-palette ak-palette" role="dialog" aria-label="Search" onClick={(e) => e.stopPropagation()} data-testid="atomik-palette">
        <div className="gx-palette-input-row">
          <Glyph name="search" size={15} className="gx-glyph gx-palette-glyph" />
          <input ref={input} className="gx-palette-input" aria-label="Search" placeholder="Search, or tell Atomik what to do" value={query}
            onChange={(e) => { setQuery(e.target.value); setAt(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(Math.max(0, rows.length - 1), i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter") {
                e.preventDefault();
                const hit = rows[at] ?? null;
                if (hit && (intent.kind !== "ask" && intent.kind !== "how" ? true : at > 0 || goTo !== null)) run(hit.run);
                else enterRef.current?.();
              }
            }} />
          <span className="gx-key">Esc</span>
        </div>
        <div className="gx-palette-list" role="listbox" aria-label="Results">
          {rows.map((r, i) => (
            <button key={r.group + r.label + i} type="button" role="option" aria-selected={i === at} className="gx-palette-row" onMouseEnter={() => setAt(i)} onClick={() => run(r.run)} data-testid="palette-row">
              <span className="gx-palette-group">{r.group}</span>
              <span className="gx-palette-label">{r.label}</span>
              {r.hint ? <span className="gx-palette-hint">{r.hint}</span> : null}
            </button>
          ))}
          {intent.kind === "approve" ? <PaletteApproveCard under={intent.under} onDone={close} enterRef={enterRef} />
            : intent.kind === "make" ? <PaletteMakeCard words={intent.words} onOpen={() => { close(); places.make({ prompt: intent.words }); }} enterRef={enterRef} />
            : intent.kind === "how" || intent.kind === "ask" || intent.kind === "memory" ? <PaletteAskCard intent={intent} project={project} onClose={close} enterRef={enterRef} />
            : null}
        </div>
      </div>
    </div>
  );
}
