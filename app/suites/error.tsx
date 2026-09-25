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
export default function SuitesError({
  error, retry, reset,
}: { error: Error & { digest?: string }; retry?: () => void; reset: () => void }) {
  useEffect(() => {
    console.error(`[particl] the Suites shell failed (ref ${faultRef(error)}):`, error);
  }, [error]);
  return <FaultPage kind="error" error={error} onRetry={() => (retry ?? reset)()} />;
}
