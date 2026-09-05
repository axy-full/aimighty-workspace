"use client";

import { createContext, useContext } from "react";

/**
 * Who is looking, and what that means for the rest of the app.
 *
 * The interface is public; the studio's work is not. Anyone can open
 * particlstudio.com and walk through the screens — the composer, the model
 * menu, the ledger's shape, Atomik's gate — because the point of the tool
 * is legible from the tool, and a product nobody can look at is a product
 * nobody asks for an invite to.
 *
 * What they cannot see is a single render, project, cast member or figure,
 * and what they cannot do is spend. Both of those are enforced on the
 * SERVER: every data route answers 401 to an anonymous caller, and every
 * spending route answers 401 before it reaches a vendor. Nothing here is a
 * security boundary — this is only so a visitor is shown a locked panel
 * rather than a spinner that never resolves, and a Sign in button rather
 * than an error.
 */

export type Session = {
  signedIn: boolean;
  name: string | null;
  email: string | null;
};

const SessionContext = createContext<Session>({ signedIn: false, name: null, email: null });

export function SessionProvider({ value, children }: {
  value: Session; children: React.ReactNode;
}) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  return useContext(SessionContext);
}

/** Where a visitor goes to get in, carrying where they were. */
export function signInHref(): string {
  if (typeof window === "undefined") return "/login";
  const here = window.location.pathname + window.location.search;
  return here && here !== "/" ? `/login?next=${encodeURIComponent(here)}` : "/login";
}

/** The address that hands out invitations. One place, so it cannot drift. */
export const INVITE_CONTACT = "axy@akshaypanchal.com";
