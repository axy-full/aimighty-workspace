/**
 * atomik's browser chrome.
 *
 * particl is dark and says so document-wide (app/layout.tsx). atomik's four
 * screens are paper — `.theme-light` on the shell re-tokens the subtree — and
 * a dark status bar sitting on top of a light page is the kind of small lie
 * that reads as a rendering bug. Next merges `viewport` down the tree, so the
 * deepest layout wins and these routes get the paper ground's own value.
 *
 * The colour is `--color-desk` under `.theme-light`, written out because a
 * meta tag cannot read a custom property.
 */
export const viewport = { themeColor: "#ECEDEF" };

export default function AtomikLayout({ children }: { children: React.ReactNode }) {
  return children;
}
