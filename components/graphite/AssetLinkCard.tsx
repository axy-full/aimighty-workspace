"use client";
import type { LinkControl, LinkView } from "@/lib/shell/use-asset-link";

/**
 * What a link to a take says while it cannot show the take yet (idea 26,
 * lib/shell/use-asset-link.ts): being checked, another workspace's, a
 * production this person has not opened, or one that does not open here. It
 * never names or shows the take itself — until the link resolves in a project
 * this person may open, nothing about the take is on screen. "Go to my
 * projects" drops the link and opens the project this person would otherwise
 * have landed on.
 */
export function AssetLinkCard({ link, view }: { link: LinkControl; view: LinkView }) {
  if (view.phase === "none") return null;
  const leave = <button type="button" className="gx-hbtn" onClick={link.dismiss} data-testid="link-dismiss">Go to my projects</button>;
  if (view.phase === "checking" && !view.error) {
    return <section className="gx-first gx-link-card" aria-label="Linked take" data-testid="link-card" data-phase="checking"><p className="gx-first-lead" role="status">Opening the linked take…</p></section>;
  }
  const [lead, note, actions, error]: [string, string | null, React.ReactNode, string | null | undefined] =
    view.phase === "checking" ? ["This link could not be checked.", null, <button key="retry" type="button" className="gx-primary" onClick={link.retry} data-testid="link-retry">Try again</button>, view.error]
    : view.phase === "workspace" ? [
      view.switchTo ? `This take is in ${view.switchTo.name}, another of your workspaces.` : "This link is for a workspace you are not in.",
      null,
      view.switchTo ? <button key="switch" type="button" className="gx-primary" disabled={view.busy} onClick={() => void link.switchWorkspace()} data-testid="link-switch">{view.busy ? "Switching…" : "Switch workspace"}</button> : null,
      view.error,
    ]
    : view.phase === "no-draft" ? [
      view.name ? `This take is in ${view.name}, which you have not opened yet.` : "This take is in a production you have not opened yet.",
      "Opening it gives you your own copy of its shared work.",
      <button key="open" type="button" className="gx-primary" disabled={view.busy} onClick={() => void link.openProduction()} data-testid="link-open">{view.busy ? "Opening…" : "Open the production"}</button>,
      view.error,
    ]
    : [view.why === "broken" ? "This link is incomplete, so it does not open." : view.why === "project" ? "The project this link names is not one of yours." : "This link’s production could not be opened.", null, null, null];
  return (
    <section className="gx-first gx-link-card" aria-label="Linked take" data-testid="link-card" data-phase={view.phase}>
      <p className="gx-first-lead" data-testid="link-lead">{lead}</p>
      {note ? <p className="gx-first-note">{note}</p> : null}
      {error ? <p className="gx-gen-error" role="alert" data-testid="link-error">{error}</p> : null}
      <div className="gx-first-actions">{actions}{leave}</div>
    </section>
  );
}
