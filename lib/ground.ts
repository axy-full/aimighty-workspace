/**
 * Which ground a route is on.
 *
 * particl is dark and there is no appearance setting (SOW §4). The paper
 * ground is not a preference, then, but a short list of routes — and this is
 * the list. `.theme-light` re-tokens whatever it is put on, so the only
 * question anywhere in the app is which routes get it.
 *
 * Two callers, which is exactly why it is written down once: `Shell`, which
 * puts the class on the shell, and `CommandPalette`, which renders outside
 * the shell and has to re-apply it by hand. When those two disagreed, the
 * palette opened dark over a paper page.
 *
 * Deliberately not the same question as "is this atomik". atomik is a brand —
 * it decides the header, the rail, the tabs and the mark. A statement is
 * particl's own screen and still paper, because it is a document before it is
 * a screen: printed, or sent to whoever pays the bill.
 */
export function onPaper(path: string | null | undefined): boolean {
  const p = path ?? "";
  return p.startsWith("/atomik") || p.startsWith("/statements");
}
