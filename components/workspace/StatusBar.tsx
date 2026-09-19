"use client";
import { legend, SHELL_BINDINGS, type KeyBinding } from "@/lib/workspace/keys";
import { getSuite, pageDef, PAGES } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import { Keycap } from "./ui";

/** 28px. Project · suite · page, then the legend of keys that work today. */
export function StatusBar({ projectName, bindings = SHELL_BINDINGS }: { projectName: string; bindings?: KeyBinding<unknown>[] }) {
  const { state } = useWorkspace();
  const hints = legend(bindings, { state, pageCount: PAGES[state.suite].length });
  return (
    <div className="pxw-statusbar" data-row="status">
      <span className="pxw-status-text" data-testid="status-text">
        {[projectName, getSuite(state.suite).short, pageDef(state.page).title].filter(Boolean).join(" · ")}
      </span>
      <span style={{ flex: 1 }} />
      {hints.map((hint) => (
        <span className="pxw-status-hint" key={hint.key}>
          <Keycap>{hint.key}</Keycap>
          <span className="pxw-status-hint-label">{hint.label}</span>
        </span>
      ))}
    </div>
  );
}
