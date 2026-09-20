"use client";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { generateAvailability } from "@/lib/workspace/navigation";
import { filterPalette, paletteCommands, type PaletteAction } from "@/lib/workspace/palette";
import { useWorkspace } from "@/lib/workspace/state";
import type { MobileSheetBodyProps } from "./registry";

/**
 * Search (05-mobile: "the desktop ⌘K palette as a list"). The phone has no
 * keyboard layer, so the header's search button is what ⌘K was — and the
 * rows are the same commands, from the same lib/workspace/palette.ts, so the
 * two surfaces cannot drift apart. Every row navigates through `go`.
 */
export function SearchSheet({ onGenerate }: MobileSheetBodyProps) {
  const ws = useWorkspace();
  const { state, dispatch } = ws;
  const atomik = useAtomik();
  const rows = filterPalette(paletteCommands({ shots: state.lists.shots }), state.query);

  const perform = (action: PaletteAction) => {
    switch (action.type) {
      case "go":
        ws.go(action.suite, action.page);
        return;
      case "runPage":
        ws.setSheet("atomik");
        atomik.start(state.page);
        return;
      case "runPlan": {
        const page = action.page;
        ws.go(action.suite, page);
        /* Navigate first, then start: the run belongs to the page just opened. */
        setTimeout(() => atomik.start(page), 40);
        return;
      }
      case "generate": {
        const availability = generateAvailability(state, Boolean(onGenerate));
        ws.setSheet(null);
        if (availability.enabled) onGenerate?.();
        else ws.toast(availability.reason);
        return;
      }
      case "toggleInspector":
        /* The Inspector is a sheet on a phone; the toggle opens it. */
        ws.setSheet("inspector");
        return;
      case "shot":
        dispatch({ type: "patch", patch: { selKind: "shot", selId: action.id } });
        ws.go("particl", "rig");
        return;
      case "home":
        ws.home();
        return;
    }
  };

  return (
    <div className="pxm-search">
      <input
        className="pxm-field"
        autoFocus
        value={state.query}
        placeholder="Search suites, stages and actions"
        aria-label="Search suites, stages and actions"
        onChange={(event) => dispatch({ type: "patch", patch: { query: event.target.value } })}
      />
      <div className="pxm-search-list" role="listbox" aria-label="Commands">
        {rows.length ? (
          rows.map((row) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={false}
              className="pxm-search-row"
              data-testid="mobile-search-row"
              onClick={() => perform(row.action)}
            >
              <span className="pxm-search-group" data-functional-label="">{row.group}</span>
              <span className="pxm-search-label">{row.label}</span>
              <span className="pxm-chevron" aria-hidden="true">›</span>
            </button>
          ))
        ) : (
          <div className="pxm-empty">Nothing matches “{state.query.trim()}”.</div>
        )}
      </div>
    </div>
  );
}
