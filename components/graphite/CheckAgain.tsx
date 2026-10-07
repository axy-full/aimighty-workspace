"use client";
import { useSampleCheck } from "@/lib/demo/use-sample";

/** The free "Try again" beside CHECK_LINE (the workspace could not be checked): it reads the check again and spends nothing. */
export function CheckAgain({ className }: { className?: string }) {
  const { retry } = useSampleCheck();
  return <button type="button" className={className} onClick={retry} data-testid="sample-check-retry">Try again</button>;
}
