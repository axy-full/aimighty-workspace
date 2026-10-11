"use client";
import { useEffect, useState } from "react";

/**
 * Whether "Continue with Google" is on on this server (GET /api/auth/google/status: the client id, its secret and the public origin are set).
 * Asked once per page load; false until answered, and false if it cannot be asked, so the button is never drawn for a flow that is off.
 */
let answer: Promise<boolean> | null = null;
const ask = (): Promise<boolean> => (answer ??= fetch("/api/auth/google/status", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((body: { enabled?: unknown } | null) => body?.enabled === true)
  .catch(() => { answer = null; return false; }));

export function useGoogleSignIn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void ask().then((value) => { if (live) setOn(value); });
    return () => { live = false; };
  }, []);
  return on;
}
