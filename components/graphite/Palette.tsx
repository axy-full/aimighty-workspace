"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Glyph } from "./icons";
import { paletteIndex, searchPalette, type PaletteRun } from "@/lib/shell/palette";
import { goSettings } from "@/lib/shell/settings-nav";
import { useShell } from "@/lib/shell/state";
import { useWorkspace } from "@/lib/workspace/state";
import type { LibraryEntry } from "@/lib/workspace/library";

/** ⌘K (lib/shell/palette.ts): what the design lists, then the person's assets and "Ask Atomik: …". Enter runs the top hit; Esc closes. */
export function Palette(props: { items: LibraryEntry[]; onAsk: (text: string) => void }) {
  const shell = useShell();
  /* Mounted only while open, so every opening starts from an empty query. */
  return shell.palette ? <PaletteDialog {...props} /> : null;
}

function PaletteDialog({ items, onAsk }: { items: LibraryEntry[]; onAsk: (text: string) => void }) {
  const shell = useShell();
  const { dispatch } = useWorkspace();
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const index = useMemo(() => paletteIndex({
    assets: items.map((i) => ({ id: i.take.id, name: i.take.name, kind: i.media ?? "file" })),
  }), [items]);
  const rows = useMemo(() => searchPalette(index, query), [index, query]);
  const run = (r: PaletteRun) => {
    shell.setPalette(false);
    switch (r.type) {
      case "home": shell.goSuite("studio", shell.wide ? "stages" : "home"); return;
      case "make":
        /* Make's panel over the page on screen, on the mode picked; Motion transfer and Object swap are its quick tools (D0 PR 5b) and open their pages until then. */
        if (r.mode === "motion" || r.mode === "swap") { shell.goSuite("viral", r.mode); return; }
        shell.openMake(r.mode ?? undefined);
        return;
      case "suite": shell.goSuite(r.suite); return;
      case "page": shell.goSuite(r.suite, r.page); return;
      case "settings": goSettings(shell, r.section); return;
      case "asset": dispatch({ type: "patch", patch: { selKind: "take", selId: r.id } }); shell.openInspector(); return;
      case "ask": onAsk(r.text); return;
    }
  };
  return (
    <div className="gx-veil gx-palette-veil" onClick={() => shell.setPalette(false)} data-testid="palette-veil">
      <div className="gx-palette" role="dialog" aria-label="Search" onClick={(e) => e.stopPropagation()}>
        <div className="gx-palette-input-row">
          <Glyph name="search" size={15} className="gx-glyph gx-palette-glyph" />
          <input ref={input} className="gx-palette-input" aria-label="Search" placeholder="Search, or tell Atomik what to do" value={query}
            onChange={(e) => { setQuery(e.target.value); setAt(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); const hit = rows[at] ?? rows[0]; if (hit) run(hit.run); }
            }} />
          <span className="gx-key">Esc</span>
        </div>
        <div className="gx-palette-list" role="listbox" aria-label="Results">
          {rows.map((r, i) => (
            <button key={r.group + r.label} type="button" role="option" aria-selected={i === at} className="gx-palette-row" onMouseEnter={() => setAt(i)} onClick={() => run(r.run)}>
              <span className="gx-palette-group">{r.group}</span>
              <span className="gx-palette-label">{r.label}</span>
              <span className="gx-palette-hint">{r.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
