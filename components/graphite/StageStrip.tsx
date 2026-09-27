"use client";
import { Fragment } from "react";
import { useShell } from "@/lib/shell/state";

/** 46px. The active suite's pages as `01 Label`, a hairline before each group. Hidden in Gen and Workspace. */
export function StageStrip({ redesign = false }: { redesign?: boolean }) {
  const shell = useShell();
  /* The phone's Home and Studio grid stand outside the strip (GLASS_SPEC §3): nothing else on those screens.
     On a desktop the Studio home keeps the strip, with no stage lit, so every stage stays one click away. */
  if (shell.view !== "suite" || (shell.page.phoneOnly && !(shell.wide && shell.page.id === "stages"))) return null;
  return (
    <nav className="gx-strip gx-scroll" aria-label="Pages" data-row="strip">
      {shell.suite.pages.filter((p) => !p.phoneOnly && !(redesign && shell.suite.id === "studio" && ["beats", "environment"].includes(p.id))).map((p, index) => (
        <Fragment key={p.id}>
          {p.gapBefore ? <span className="gx-strip-gap" aria-hidden="true" data-testid="strip-gap" /> : null}
          <button type="button" className="gx-tab" aria-current={p.id === shell.page.id ? "page" : undefined} title={p.title} onClick={() => shell.goSuite(shell.suite.id, p.id)}>
            <span className="gx-tab-dot" aria-hidden="true" />
            <span className="gx-tab-n">{redesign && shell.suite.id === "studio" ? String(index + 1).padStart(2, "0") : p.n}</span>
            <span>{redesign && p.id === "boards" ? "Boards" : redesign && p.id === "edit" ? "Edit" : p.label}</span>
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
