/**
 * A statement's browser chrome.
 *
 * Same reason as atomik's (`app/(app)/atomik/layout.tsx`): particl is dark and
 * says so document-wide, but a statement renders inside `.theme-light` because
 * it is a document before it is a screen — printed, or sent to the person who
 * pays. A dark status bar sitting on a white page reads as a rendering bug.
 *
 * A layout rather than the page's own export: the page is a client component,
 * and `viewport` may only be exported from a server one.
 */
export const viewport = { themeColor: "#ECEDEF" };

export default function StatementLayout({ children }: { children: React.ReactNode }) {
  return children;
}
