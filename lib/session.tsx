"use client";

import { createContext, useContext, useEffect } from "react";
import { usePathname } from "next/navigation";

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

export type SessionWorkspace = { id: string; name: string; slug: string };
export type Session = {
  signedIn: boolean;
  name: string | null;
  email: string | null;
  /** The workspace this session is in, and the account's standing there. */
  workspace: SessionWorkspace | null;
  role: "owner" | "admin" | "member" | null;
  owner: boolean;
  /** The platform's owner — the one account that administers sign-ups. */
  superAdmin: boolean;
  workspaces: (SessionWorkspace & { role: "owner" | "admin" | "member" })[];
};

const SessionContext = createContext<Session>({ signedIn: false, name: null, email: null, workspace: null, role: null, owner: false, superAdmin: false, workspaces: [] });

/**
 * What the browser must not keep once nobody is signed in.
 *
 * The app caches poster frames of renders in localStorage as base64 JPEGs —
 * tens of them, tens of kilobytes each — so a wall of clips does not
 * re-download every time it is scrolled. It also keeps the unsent prompt,
 * the seed, the shot spec and the last project id, so a reload does not
 * lose someone's work in progress.
 *
 * Every one of those is the studio's private work sitting on a disk. That
 * was defensible while the app was unreachable without a session; it is not
 * now the interface is public, because the next person to open the browser
 * on a shared machine is a visitor. The unsent prompt was the visible half
 * of it — it rendered straight into the composer for whoever came next —
 * and the poster cache was the larger, quieter half.
 *
 * Preferences deliberately survive: theme, composer defaults, whether the
 * chat dock was open. Those are about the browser, not about the work.
 */
const PRIVATE_PREFIXES = ["aw_poster:", "aw_draft:"];
const PRIVATE_KEYS = ["aw_posters:index", "aw_project", "aw_compose_seed", "aw_compose_spec"];

export function clearPrivateLocal(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (PRIVATE_KEYS.includes(k) || PRIVATE_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch { /* private mode, or storage disabled — nothing to clear */ }
}

export function SessionProvider({ value, children }: {
  value: Session; children: React.ReactNode;
}) {
  /* Cleared whenever the app loads without a session, not only on the click
     of a sign-out button. A session that simply expired, a cookie cleared by
     hand, or a browser someone walked away from all reach this and none of
     them reach a logout handler. */
  const { signedIn } = value;
  useEffect(() => { if (!signedIn) clearPrivateLocal(); }, [signedIn]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  return useContext(SessionContext);
}

/**
 * Where a visitor goes to get in, carrying where they were.
 *
 * A hook, and built on usePathname rather than window.location, because the
 * server has no window and rendered a bare "/login" while the client then
 * rendered "/login?next=/team" — a different attribute on the same anchor,
 * which React reports as a hydration mismatch on every screen a visitor can
 * see. usePathname answers identically on both sides.
 */
export function useSignInHref(): string {
  const path = usePathname();
  return signInHrefFor(path);
}

/** The pure form, for anything that is not a component. */
export function signInHrefFor(path: string | null): string {
  return path && path !== "/" ? `/login?next=${encodeURIComponent(path)}` : "/login";
}

/* There is deliberately no contact address in this file, or in any other
   file that reaches a browser. Asking for an invitation goes through
   /api/access-request, which reads the administrator's address on the
   server and sets reply-to to whoever asked. A mailto: link would have put
   that address in the page source of every visitor — which is exactly what
   a public interface must not do with a private inbox. */
