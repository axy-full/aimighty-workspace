"use client";

import { useEffect } from "react";
import Link from "next/link";
import { STUDIO_HREF, faultMessage, faultRef } from "@/lib/shell/fault";

/**
 * A screen inside the app shell threw. The chrome survives — the nav, the
 * top bar and the chat are outside this boundary — so this replaces only the
 * screen's own body and a person is one tap from somewhere that works.
 *
 * The important thing it says is the true thing: a page failing here does not
 * touch a render. Generation happens on the server and is reconciled by the
 * cron; the wall picks it up whenever the screen comes back.
 */
export default function AppError({
  error, retry,
}: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(`[particl] screen failed (ref ${faultRef(error)}):`, error);
  }, [error]);

  return (
    <div className="screen grid place-items-center">
      <div className="max-w-[52ch] text-center">
        <p className="text-[20px] font-semibold tracking-[-0.02em]">This screen stopped</p>
        <p className="mt-2.5 text-[15px] leading-relaxed text-dim">
          Something on the page threw an error. Nothing you have made is affected:
          renders already in flight carry on at the engine and land in Takes
          as usual, and every cost stays on the ledger.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={() => retry()} className="btn-render h-[44px] px-5 text-[14px]">
            Try again
          </button>
          <Link href={STUDIO_HREF} className="chip min-h-[44px]">Back to Studio</Link>
          <button type="button" onClick={() => window.location.reload()} className="chip min-h-[44px]">
            Reload the page
          </button>
        </div>

        <p className="mt-5 break-words font-mono text-[12px] leading-relaxed text-dim">
          {faultMessage(error) ? <>{faultMessage(error)}<br /></> : null}
          ref {faultRef(error)}
        </p>
      </div>
    </div>
  );
}
