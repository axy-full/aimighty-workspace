"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { catchError, type ErrorInfo } from "next/error";
import { asError, attemptsFor, countTry, faultMessage, faultRef, throwIfArmed, type Tries } from "@/lib/shell/fault";

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
 * sheets, and in the Suites shell every stage body, the Library, the
 * Inspector and the Gen results. One of them failing costs you that panel,
 * not the session, and the work carries on at the vendor either way.
 *
 * Built on Next's own `catchError` (next/error), not a hand-rolled class, so
 * it behaves like the error.tsx pages: Try again is its `retry()` — the
 * route's server data fetched again and the panel re-rendered inside a
 * transition, the card staying put until the answer lands — `notFound()` and
 * `redirect()` thrown inside still reach Next, and moving to another path
 * clears the failure. What this adds: `resetKey` (the Suites shell moves
 * between pages by query string, which catchError does not watch), the count
 * of Try agains, the quotable ref, and the cards.
 */

/** What a custom fallback is handed: the failure, its quotable ref, and the way to try again. */
export type Fault = {
  error: Error;
  ref: string;
  what: string;
  /** How many times Try again has already been pressed for this failure. */
  attempts: number;
  /** Try again: fetch and render the panel afresh. */
  retry: () => void;
  /** True while a Try again is on its way — the button says so and cannot be pressed twice. */
  pending: boolean;
};

type Props = {
  children: ReactNode;
  /** What this boundary guards, in the app's words: "the wall", "this render". */
  what?: string;
  /** Inline one-liner instead of a panel — for small things inside a layout. */
  compact?: boolean;
  /** Changing this resets the boundary: pass the id whose change should retry. */
  resetKey?: string | number | null;
  /** Draw the failure yourself — the Suites shell keeps each panel's own frame. */
  fallback?: (fault: Fault) => ReactNode;
  /**
   * Development only: a name the browser specs arm (lib/shell/fault.ts ›
   * probeArmed) to make this boundary's children throw. Inert in production.
   */
  probe?: string;
};

type WallProps = Omit<Props, "children" | "probe"> & { attempts: number; onRetry: () => void };

/**
 * The failing side of the wall. catchError renders this as a component, so it
 * may hold hooks — and it is mounted afresh each time the panel fails again.
 */
function Caught({ what = "This panel", compact, resetKey, fallback, attempts, onRetry }: WallProps, { error: thrown, retry, reset }: ErrorInfo) {
  const error = useMemo(() => asError(thrown), [thrown]);
  const ref = faultRef(error);
  const [pending, startRetry] = useTransition();

  /* The failure was about the page, project or take on screen when it was
     caught; moving to another gives the panel a fresh go. Before paint, so
     the old card never flashes over the new page. */
  const [caught] = useState(() => ({ key: resetKey, what }));
  useLayoutEffect(() => {
    if (!Object.is(caught.key, resetKey)) reset();
  }, [caught, resetKey, reset]);

  /* Next already logs the error and where it happened; this line ties it to
     the ref on the card, so a screenshot and the console can be matched.
     Once per failure, under the name it had when it failed — not the next
     page's, which arrives a commit before the reset above. */
  useEffect(() => {
    const message = faultMessage(error);
    console.error(`[particl] ${caught.what} stopped (ref ${ref})${message ? `: ${message}` : ""}`);
  }, [caught, ref, error]);

  const again = useCallback(() => startRetry(() => { onRetry(); retry(); }), [onRetry, retry]);
  const fault: Fault = { error, ref, what, attempts, retry: again, pending };
  return fallback ? fallback(fault) : <DefaultFault fault={fault} compact={compact} />;
}

const Wall = catchError(Caught);

/** The card for a boundary without a fallback of its own: a panel, or one inline line (`compact`). */
export function DefaultFault({ fault, compact = false }: { fault: Fault; compact?: boolean }) {
  if (compact) {
    return (
      <span role="alert" className="inline-flex items-center gap-2 rounded-[10px] bg-lift/8 px-2.5 py-1.5 text-[12.5px] text-lift">
        {fault.what} couldn&rsquo;t be shown
        <button type="button" onClick={() => { if (!fault.pending) fault.retry(); }} aria-disabled={fault.pending || undefined} className="font-medium underline underline-offset-2">
          {fault.pending ? "Trying…" : "Try again"}
        </button>
      </span>
    );
  }
  const message = faultMessage(fault.error);
  return (
    <div role="alert" className="grid min-h-[160px] place-items-center rounded-[var(--r)] bg-panel2 p-6">
      <div className="max-w-[46ch] text-center">
        <p className="text-[15px] font-semibold tracking-[-0.01em]">{fault.what} couldn&rsquo;t be shown</p>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-dim">
          The rest of the screen still works, and takes in progress keep generating.
        </p>
        <p className="mt-2 break-words font-mono text-[12px] text-dim">
          ref {fault.ref}{message ? ` · ${message}` : ""}
        </p>
        <button type="button" onClick={() => { if (!fault.pending) fault.retry(); }} aria-disabled={fault.pending || undefined} className="chip mt-4 min-h-[44px] !text-blue">
          {fault.pending ? "Trying…" : "Try again"}
        </button>
      </div>
    </div>
  );
}

/* Development only: throws while the spec has armed this boundary's name. */
function Probe({ name, children }: { name: string; children: ReactNode }) {
  throwIfArmed(name);
  return children;
}

export default function Boundary({ children, probe, ...wall }: Props) {
  /* Counted out here: the fallback is remounted by every failure, so it cannot keep count itself. */
  const [tries, setTries] = useState<Tries>({ key: wall.resetKey, count: 0 });
  const { resetKey } = wall;
  const onRetry = useCallback(() => setTries((current) => countTry(current, resetKey)), [resetKey]);
  const guarded = probe && process.env.NODE_ENV !== "production" ? <Probe name={probe}>{children}</Probe> : children;
  return <Wall {...wall} attempts={attemptsFor(tries, resetKey)} onRetry={onRetry}>{guarded}</Wall>;
}
