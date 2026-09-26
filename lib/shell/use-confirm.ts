"use client";
import { useCallback, useEffect, useRef } from "react";
import { useWorkspace } from "@/lib/workspace/state";
import { isHere, openLabel, type Confirmation, type Destination, type Here } from "./confirmations";
import { useShell, type Shell } from "./state";

/**
 * Confirmations in the shell (lib/shell/confirmations): the toast says what
 * was done, and carries an Open to where it is — unless the person is already
 * there. `go` is for an action whose own button says it opens somewhere
 * (Open in Gen, Build scene nodes): it goes, then confirms there.
 */
export function useConfirm() {
  const { live } = useShell();
  const ws = useWorkspace();
  /* A confirmation can arrive after an await, and its Open can be pressed after the page that raised it has gone:
     both read the shell as it is then (the provider's, which outlives this component), never a snapshot from here. */
  const latest = useRef(ws);
  useEffect(() => { latest.current = ws; });

  const open = useCallback((to: Destination) => {
    const shell = live(), ws = latest.current;
    if (to.to === "gen") { shell.goGen(); return; }
    if (to.to === "library") { shell.openLibrary("assets"); return; }
    shell.goSuite(to.suite, to.page);
    if (to.select) {
      ws.dispatch({ type: "patch", patch: { selKind: to.select.kind, selId: to.select.id, ...(to.select.kind === "shot" ? { inspector: true } : {}) } });
      ws.syncUrl();
      /* The shot, in view: the Rig lists it once it has read the saved draft; centred, so a phone's floating tab bar never covers it. */
      if (to.select.kind === "shot") reveal(`.pxw-rig-row[data-shot-id="${CSS.escape(to.select.id)}"], .pxw-graph-node[data-node-id="${CSS.escape(to.select.id)}"]`);
    }
  }, [live]);

  const confirm = useCallback((c: Confirmation, options: { go?: boolean } = {}) => {
    const ws = latest.current;
    const to = c.open && !isHere(c.open, hereOf(live())) ? c.open : null;
    /* Already there: nothing moves, and no history entry is added. */
    if (options.go) { if (to) open(to); ws.toast(c.text); return; }
    ws.toast(c.text, to ? { label: openLabel(to), run: () => open(to) } : undefined);
  }, [open, live]);

  return { confirm, open };
}

/** Where the person is, and whether the Library's assets are already on screen there. */
function hereOf(shell: Shell): Here {
  return { view: shell.view, suite: shell.suite.id, page: shell.page.id, library: (shell.view === "suite" || shell.view === "gen") && (shell.wide || shell.libOpen) && shell.libTab === "assets" };
}

/**
 * Scroll the first match to the middle of what can be seen of the list that
 * scrolls it, once it is on the page — for a few seconds at most, then let it
 * be. What can be seen ends where the fixed foot of the page begins (a phone's
 * tab bar, the Uploads chip), which floats over the list. Only vertically: a
 * phone's shot table is wider than the screen, and must not be slid sideways.
 */
function reveal(selector: string, within = 3000) {
  const until = performance.now() + within;
  const look = () => {
    const found = document.querySelector<HTMLElement>(selector);
    if (!found) { if (performance.now() < until) requestAnimationFrame(look); return; }
    centre(found);
    /* A page still animating in moves under that measurement: once it has landed (or at the deadline), a row it carried out of the clear is put back. */
    const entering = document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity);
    if (!entering.length) return;
    void Promise.race([
      Promise.all(entering.map((a) => a.finished.catch(() => undefined))),
      new Promise((done) => setTimeout(done, Math.max(0, until - performance.now()))),
    ]).then(() => requestAnimationFrame(() => centre(found, true)));
  };
  requestAnimationFrame(look);
}

/** Centre the row in the clear part of its scroller (`onlyIfOut`: leave it where it is when it is already wholly in the clear). */
function centre(found: HTMLElement, onlyIfOut = false) {
  if (!found.isConnected) return;
  let scroller: HTMLElement | null = found.parentElement;
  while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
  const box = found.getBoundingClientRect(), frame = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
  const top = Math.max(frame.top, 0);
  let bottom = Math.min(frame.bottom, window.innerHeight);
  /* The fixed foot covers the list's end: what can be seen stops at it. */
  for (const over of footOver()) {
    const at = over.getBoundingClientRect().top;
    if (at > top && at < bottom) bottom = at;
  }
  if (onlyIfOut && box.top >= top && box.bottom <= bottom) return;
  /* In the middle of what can be seen; a row taller than that goes to its top, so as much of it as can be is in the clear. */
  const by = box.top - top - Math.max(0, (bottom - top - box.height) / 2);
  if (scroller) scroller.scrollBy({ top: by }); else window.scrollBy({ top: by });
}

/** What floats, fixed, over the foot of the page when shown: a phone's tab bar, and the Uploads chip once anything was uploaded (components/UploadRecovery). */
function footOver(): HTMLElement[] {
  const chip = document.querySelector('section[aria-label="Upload recovery"]')?.closest("details") ?? null;
  return [document.querySelector<HTMLElement>(".gx-tabbar"), chip].filter((el): el is HTMLElement => el instanceof HTMLElement && el.getClientRects().length > 0);
}
