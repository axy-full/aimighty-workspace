"use client";

import { useEffect } from "react";
import { FaultPage } from "@/components/graphite/FaultPage";
import { faultRef } from "@/lib/shell/fault";

/**
 * The Suites shell itself threw — the header, the providers, or the server
 * bootstrap — so no panel boundary (components/Boundary.tsx) could hold it.
 * This keeps the header as plain links, offers Try again (retry re-fetches
 * and re-renders the segment), a clean load of Studio, and the ref that
 * matches the console line or, for a server failure, the server log.
 */
export default function SuitesError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  /* Next logs the error itself; this line ties it to the ref on the page. */
  useEffect(() => {
    console.error(`[particl] the Suites shell stopped (ref ${faultRef(error)})`);
  }, [error]);
  return <FaultPage kind="error" error={error} onRetry={retry} />;
}
