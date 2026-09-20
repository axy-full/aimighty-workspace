"use client";
import { useState } from "react";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { generateAvailability, generateTarget } from "@/lib/workspace/navigation";
import { filterPalette, moveHighlight, paletteCommands, type PaletteAction } from "@/lib/workspace/palette";
import { useWorkspace } from "@/lib/workspace/state";
import { Keycap } from "./ui";

/**
 * ⌘K (04 "Command palette"): centred at padding-top 14vh, min(560px, 92vw),
 * over rgba(0,0,0,.66). Autofocused input, up to eight rows, the first
 * highlighted; ↑ ↓ move, Enter runs the highlighted row, Esc closes.
 */
export function Palette({ onGenerate }: { onGenerate?: () => void }) {
  const ws = useWorkspace();
  const { state, dispatch } = ws;
  const atomik = useAtomik();
  /* The highlight belongs to one query: a new query starts at the top row. */
  const [highlight, setHighlight] = useState({ query: "", index: 0 });
  if (!state.palette) return null;

  const rows = filterPalette(paletteCommands({ shots: state.lists.shots }), state.query);
  const active = highlight.query === state.query ? Math.min(highlight.index, Math.max(0, rows.length - 1)) : 0;
  const close = () => dispatch({ type: "patch", patch: { palette: false, query: "" } });

  const perform = (action: PaletteAction) => {
    close();
    switch (action.type) {
      case "go":
        ws.go(action.suite, action.page);
        return;
      case "runPage":
        atomik.start(state.page);
        return;
      case "runPlan": {
        const page = action.page;
        ws.go(action.suite, page);
        /* Navigate first, then start: the run belongs to the page just opened (04, 40ms apart). */
        setTimeout(() => atomik.start(page), 40);
        return;
      }
      case "composer":
        dispatch({ type: "patch", patch: { composer: true } });
        return;
      case "generate": {
        /* The palette's shot row keeps the Rig's Generate; "Generate…" is the composer. */
        if (generateTarget(state, Boolean(onGenerate)) === "rig") onGenerate?.();
        else {
          const availability = generateAvailability(state, Boolean(onGenerate));
          ws.toast(availability.enabled ? "" : availability.reason);
        }
        return;
      }
      case "toggleInspector":
        dispatch({ type: "toggleInspector" });
        return;
      case "shot":
        /* Select first, then go: the selection repair keeps a shot that is in the list. */
        dispatch({ type: "patch", patch: { selKind: "shot", selId: action.id } });
        ws.go("particl", "rig");
        return;
      case "home":
        ws.home();
        return;
    }
  };

  return (
    <div className="pxw-palette" data-testid="palette">
      <div className="pxw-palette-catcher" onClick={close} aria-hidden="true" />
      <div className="pxw-palette-panel" role="dialog" aria-label="Command palette">
        <input
          className="pxw-palette-input"
          autoFocus
          value={state.query}
          placeholder="Search suites, tools and actions"
          aria-label="Search suites, tools and actions"
          aria-controls="pxw-palette-list"
          aria-activedescendant={rows[active] ? `pxw-cmd-${rows[active].id}` : undefined}
          onChange={(event) => dispatch({ type: "patch", patch: { query: event.target.value } })}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight({ query: state.query, index: moveHighlight(active, event.key === "ArrowDown" ? 1 : -1, rows.length) });
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (rows[active]) perform(rows[active].action);
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        />
        <div className="pxw-palette-list" id="pxw-palette-list" role="listbox" aria-label="Commands">
          {rows.length ? (
            rows.map((row, i) => (
              <button
                key={row.id}
                id={`pxw-cmd-${row.id}`}
                type="button"
                role="option"
                aria-selected={i === active}
                className="pxw-palette-row"
                data-testid="palette-row"
                tabIndex={-1}
                onMouseEnter={() => setHighlight({ query: state.query, index: i })}
                onClick={() => perform(row.action)}
              >
                <span className="pxw-palette-group" data-functional-label="">{row.group}</span>
                <span className="pxw-palette-label">{row.label}</span>
                {row.hint ? <Keycap className="pxw-palette-hint">{row.hint}</Keycap> : null}
              </button>
            ))
          ) : (
            <div className="pxw-palette-empty">Nothing matches “{state.query.trim()}”.</div>
          )}
        </div>
      </div>
    </div>
  );
}
