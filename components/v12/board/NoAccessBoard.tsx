"use client";
import { NO_ACCESS } from "@/lib/v12/visitor";
import "./noaccess.css";

/**
 * "You don't have access" for a signed-in person who opened a link to a board that is not in their workspace
 * (docs/redesign/inventory.md § 8.7): the words the visitor sees, and nothing of the board. The page asked the server for
 * the board by its id, and the server answered with nothing, so there is nothing to show; this says so instead of an empty
 * screen. The way on is their own Home.
 */
export function NoAccessBoard({ onHome }: { onHome: () => void }) {
  return (
    <div className="v12-noaccess" data-testid="v12-no-access">
      <span className="v12-noaccess-lock" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
      </span>
      <h1 className="v12-noaccess-title">{NO_ACCESS.title}</h1>
      <p className="v12-noaccess-line">{NO_ACCESS.line}</p>
      <div className="v12-noaccess-actions">
        <button type="button" className="v12-nbtn v12-nbtn-primary" onClick={onHome} data-testid="v12-no-access-home">Go to Home</button>
      </div>
    </div>
  );
}
