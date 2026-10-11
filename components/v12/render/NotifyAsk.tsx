"use client";
import "./render.css";

/**
 * "Tell me when it's done" (redesign P3; prototype README A): offered once, on the first take that runs past a minute. The
 * browser is asked for permission only when the person presses it. The notice is the page's own (the Notification API);
 * nothing is sent from the server and nothing is stored but that it was offered.
 */
export function NotifyAsk({ onTell, onNotNow }: { onTell: () => void; onNotNow: () => void }) {
  return (
    <div className="v12-notify" role="group" aria-label="Notification" data-testid="v12-notify-ask">
      <span className="v12-notify-text">This one takes a few minutes.</span>
      <button type="button" className="v12-notify-btn v12-notify-btn--go" onClick={onTell} data-testid="v12-notify-tell">Tell me when it’s done</button>
      <button type="button" className="v12-notify-btn" onClick={onNotNow} data-testid="v12-notify-not-now">Not now</button>
    </div>
  );
}
