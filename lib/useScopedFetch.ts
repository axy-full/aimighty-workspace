"use client";

import { useCallback } from "react";
import { useSession } from "./session";

/** Bind a browser action to the identity that rendered its controls, including
 * callbacks resumed after a dialog. Never look up a newer cookie identity here. */
export function useScopedFetch(capturedScope?: string | null) {
  const session = useSession();
  // Auth-only pages pass their server-rendered scope without loading the app's
  // full SessionProvider. Explicit null must never fall back to another scope.
  const requestScope =
    capturedScope === undefined
      ? session.signedIn
        ? session.requestScope
        : null
      : capturedScope;
  return useCallback(
    (url: string, init: RequestInit = {}): Promise<Response> => {
      if (!requestScope)
        return Promise.reject(
          new Error(
            "Reload this page in the intended account and workspace before making changes.",
          ),
        );
      const headers = new Headers(init.headers);
      headers.set("X-Workbench-Scope", requestScope);
      return fetch(url, { ...init, headers });
    },
    [requestScope],
  );
}
