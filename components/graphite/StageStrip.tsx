"use client";
import { Fragment, useEffect, useRef } from "react";
import { useShell } from "@/lib/shell/state";

/** 46px. The active suite's pages as `01 Label`, a hairline before each group. Hidden in Gen and Workspace. */
export function StageStrip() {
  const shell = useShell();
  /* A strip wider than its row (a phone) scrolls the current page to its middle, so the page it names is in sight. */
  const nav = useRef<HTMLElement>(null);
  const current = `${shell.suite.id}:${shell.page.id}`;
  /* The phone's Home and Studio grid stand outside the strip (GLASS_SPEC §3): nothing else on those screens.
     On a desktop the Studio home keeps the strip, with no stage lit, so every stage stays one click away.
     A strip drawn again on the same page (back from Gen) is observed again too. */
  const hidden = shell.view !== "suite" || Boolean(shell.page.phoneOnly && !(shell.wide && shell.page.id === "stages"));
  useEffect(() => {
    const strip = nav.current;
    if (!strip) return;
    const reveal = () => {
      const tab = strip.querySelector<HTMLElement>('[aria-current="page"]');
      if (!tab || strip.scrollWidth <= strip.clientWidth) return;
      const box = strip.getBoundingClientRect(), at = tab.getBoundingClientRect();
      strip.scrollLeft += at.left - box.left - (box.width - at.width) / 2;
    };
    reveal();
    /* Rotation keeps this component mounted, but changes the space beside the project. */
    const resize = new ResizeObserver(reveal);
    resize.observe(strip);
    return () => resize.disconnect();
  }, [current, hidden]);
  if (hidden) return null;
  return (
    <nav className="gx-strip gx-scroll" aria-label="Pages" data-row="strip" ref={nav}>
      {shell.suite.pages.filter((p) => !p.phoneOnly).map((p) => (
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
