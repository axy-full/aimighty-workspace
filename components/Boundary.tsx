"use client";

import React from "react";

/**
 * A wall around one part of a screen.
 *
 * React unmounts the WHOLE tree when a render throws, so without a boundary
 * a single bad row — a render made by a model that has since been retired,
 * a params blob that won't parse — takes the entire page to white. That is
 * the failure a person calls a crash, and it is the one thing about this app
 * that no amount of server-side care can prevent.
 *
 * So the risky islands get their own boundary: the wall, the theatre, the
 * sheets. One of them failing costs you that panel, not the session, and the
 * work carries on at the vendor either way.
 *
 * Class component because getDerivedStateFromError has no hook equivalent —
 * still true in React 19.
 */

type Props = {
  children: React.ReactNode;
  /** What this boundary guards, in the app's words: "the wall", "this render". */
  what?: string;
  /** Inline one-liner instead of a panel — for small things inside a layout. */
  compact?: boolean;
  /** Changing this resets the boundary: pass the id whose change should retry. */
  resetKey?: string | number | null;
};

type State = { error: Error | null };

export default class Boundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Moving to a different render (or project) should give the panel a fresh
    // go: the previous failure was about the previous thing.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // No error service is wired up, so the console is the record. Keep the
    // component stack: it is the only thing that says WHERE.
    console.error(`[particl] ${this.props.what ?? "a panel"} failed:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const what = this.props.what ?? "This panel";
    const retry = () => this.setState({ error: null });

    if (this.props.compact) {
      return (
        <span className="inline-flex items-center gap-2 rounded-[10px] bg-lift/8 px-2.5 py-1.5 text-[12.5px] text-lift">
          {what} couldn&rsquo;t be shown
          <button type="button" onClick={retry} className="font-medium underline underline-offset-2">
            Try again
          </button>
        </span>
      );
    }

    return (
      <div className="grid min-h-[160px] place-items-center rounded-[var(--r)] bg-panel2 p-6">
        <div className="max-w-[46ch] text-center">
          <p className="text-[15px] font-semibold tracking-[-0.01em]">{what} couldn&rsquo;t be shown</p>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-dim">
            The rest of the screen still works, and anything rendering carries on.
          </p>
          <p className="mt-2 break-words font-mono text-[11.5px] text-mute">{error.message}</p>
          <button type="button" onClick={retry} className="chip mt-4 !text-blue">Try again</button>
        </div>
      </div>
    );
  }
}
