/**
 * A statement's browser chrome.
 *
 * The statement renders on the app's dark ground (`.statement` in globals.css
 * reads var(--color-desk)) and turns white only for print. Its status bar says
 * the same ground: a light bar over a dark page reads as a rendering bug.
 *
 * A layout rather than the page's own export: the page is a client component,
 * and `viewport` may only be exported from a server one.
 */
export const viewport = { themeColor: "#000000" };

export default function StatementLayout({ children }: { children: React.ReactNode }) {
  return children;
}
