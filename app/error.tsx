"use client";

import { useEffect } from "react";

/**
 * A page OUTSIDE the app shell threw — the login, the setup screen, the
 * public front door. There is no nav to fall back to here, so this stands on
 * its own and offers the two things that ever help: go again, or start over
 * at the front.
 */
export default function RootError({
  error, reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[particl] page failed:", error);
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center bg-page p-6 text-ink">
      <div className="max-w-[46ch] text-center">
        <p className="text-[20px] font-semibold tracking-[-0.02em]">This page stopped</p>
        <p className="mt-2.5 text-[15px] leading-relaxed text-dim">
          Something threw before the page could finish. Trying again usually
          settles it; if it doesn&rsquo;t, the deployment needs a look.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={reset} className="btn-render h-[38px] px-5 text-[14px]">
            Try again
          </button>
          {/* A hard load on purpose: reset() above is the soft retry, so this
              one exists to fetch a clean document when the soft one keeps
              failing. next/link would only re-enter the same broken tree. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" className="chip">Start over</a>
        </div>

        <p className="mt-5 break-words font-mono text-[11.5px] leading-relaxed text-mute">
          {error.message}
          {error.digest && <><br />ref {error.digest}</>}
        </p>
      </div>
    </main>
  );
}
