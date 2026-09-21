"use client";
import { Fragment } from "react";
import { useShell } from "@/lib/shell/state";

/** 46px. The active suite's pages as `01 Label`, a hairline before each group. Hidden in Gen and Workspace. */
export function StageStrip() {
  const shell = useShell();
  if (shell.view !== "suite") return null;
  return (
    <nav className="gx-strip gx-scroll" aria-label="Pages" data-row="strip">
      {shell.suite.pages.map((p) => (
        <Fragment key={p.id}>
          {p.gapBefore ? <span className="gx-strip-gap" aria-hidden="true" data-testid="strip-gap" /> : null}
          <button type="button" className="gx-tab" aria-current={p.id === shell.page.id ? "page" : undefined} title={p.title} onClick={() => shell.goSuite(shell.suite.id, p.id)}>
            <span className="gx-tab-dot" aria-hidden="true" />
            <span className="gx-tab-n">{p.n}</span>
            <span>{p.label}</span>
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
