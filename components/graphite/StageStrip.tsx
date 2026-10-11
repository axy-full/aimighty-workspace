"use client";
import { Fragment, useEffect, useRef } from "react";
import { isOwnerRunSuite } from "@/lib/shell/connected-capability";
import { useConnectedCapability } from "@/lib/shell/use-connected-capability";
import { useShell } from "@/lib/shell/state";

/** 46px. The active suite's pages as `01 Label`, 14px of space before each group (the master's strip). Hidden in Studio (the board), Gen and Workspace, and in an owner-run suite for a member. */
export function StageStrip() {
  const shell = useShell();
  const { owner } = useConnectedCapability(undefined, { read: false });
  /* A strip wider than its row (a phone) scrolls the current page to its middle, so the page it names is in sight. */
  const nav = useRef<HTMLElement>(null);
  const current = `${shell.suite.id}:${shell.page.id}`;
  /* Every page of a suite the owner runs on the connected account is the same owner-run card for a member
     (idea 19), so a member is shown no tabs there. A strip drawn again on the same page (back from Gen) is
     observed again too. */
  /* Studio has no stage pages any more (the board is the whole production): its overview and the phone's Home have no strip. */
  const hidden = shell.view !== "suite" || shell.suite.id === "studio" || Boolean(shell.page.phoneOnly) || Boolean(shell.page.stripHidden) || (!owner && isOwnerRunSuite(shell.suite.id));
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
    /* Rotation keeps this component mounted, but changes the space beside the project. The strip's own box
       can keep its size while its row is laid out again, so the window's resize is watched too, and each
       reveal is run once more on the next frame, after that layout has settled. */
    let frame = 0;
    const settle = () => { reveal(); cancelAnimationFrame(frame); frame = requestAnimationFrame(reveal); };
    const resize = new ResizeObserver(settle);
    resize.observe(strip);
    window.addEventListener("resize", settle);
    return () => { resize.disconnect(); window.removeEventListener("resize", settle); cancelAnimationFrame(frame); };
  }, [current, hidden]);
  if (hidden) return null;
  return (
    <nav className="gx-strip gx-scroll" aria-label="Pages" data-row="strip" ref={nav}>
      {shell.suite.pages.filter((p) => !p.phoneOnly && !p.stripHidden).map((p) => (
        <Fragment key={p.id}>
          {p.gapBefore ? <span className="gx-strip-gap" aria-hidden="true" data-testid="strip-gap" /> : null}
          <button type="button" className="gx-tab" aria-current={p.id === shell.page.id ? "page" : undefined} title={p.title} onClick={() => shell.goSuite(shell.suite.id, p.id)}>
            {p.n ? <span className="gx-tab-n">{p.n}</span> : null}
            <span>{p.label}</span>
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
