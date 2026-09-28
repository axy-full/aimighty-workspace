/**
 * Bring something just revealed (a refusal under a button, a confirmation
 * below a list) into view clear of the phone's floating tab bar. The Suites
 * pane's bottom padding keeps its own end clear, but scrollIntoView knows
 * nothing of the bar, so a line revealed near the bottom of the screen would
 * land under it. Wider screens have no bar and the least scroll is taken.
 */
export function revealClear(el: Element | null, gap = 12): void {
  if (!el || typeof window === "undefined") return;
  const bar = document.querySelector<HTMLElement>(".gx-tabbar");
  const barTop = bar && bar.getClientRects().length && getComputedStyle(bar).position === "fixed" ? bar.getBoundingClientRect().top : window.innerHeight;
  const box = el.getBoundingClientRect();
  const below = box.bottom + gap - barTop;
  if (below <= 0) return;
  /* The pane that really scrolls: the nearest ancestor whose content is taller than it. */
  let pane = el.parentElement;
  while (pane && !(["auto", "scroll"].includes(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight + 1)) pane = pane.parentElement;
  /* Never so far that its top leaves the screen. */
  const room = Math.max(0, box.top - gap);
  (pane ?? document.scrollingElement)?.scrollBy({ top: Math.min(below, room) });
}
