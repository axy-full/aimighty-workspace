import { redirect } from "next/navigation";
import type { Context } from "@/lib/auth";
import { searchStringOf, workspaceUrlFor, type RawSearch } from "./switchover";

export type { RawSearch };

/**
 * An old entry point (/, /workbench, /atomik, /subatomik) goes to the Suites
 * shell, for everyone: there is no way back to the old shell. A visitor is
 * sent on and /suites asks them to sign in.
 */
export function redirectToSuites(pathname: string, params: RawSearch): never {
  const target = workspaceUrlFor(pathname, searchStringOf(params));
  redirect(target ?? "/suites");
}

/**
 * /workbench, which is also where an account with NO workspace belongs:
 * /suites sends exactly that account here (lib/signIn.ts › shellEntryRedirect),
 * so redirecting it back would loop. It returns only for that account; the
 * caller has read the session already.
 */
export function enterSuites(pathname: string, params: RawSearch, ctx: Context | null): void {
  if (ctx && !ctx.workspace) return;
  redirectToSuites(pathname, params);
}
