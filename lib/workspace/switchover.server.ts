import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { currentContext } from "@/lib/auth";
import {
  legacyShellRequested,
  searchStringOf,
  serverSwitchTarget,
  SHELL_COOKIE,
  workspaceUrlFor,
  type RawSearch,
} from "./switchover";

export type { RawSearch };

/**
 * The workspace URL this old entry point means, or null when the old shell
 * should render. Reads the remembered `shell` choice so a person who asked
 * for the old shell never sees the hand-off note again.
 *
 * The device is not decided here — a server cannot see a window's width.
 * SwitchoverGate does that half.
 */
export async function switchoverTargetFor(
  pathname: string,
  params: RawSearch,
): Promise<{ target: string | null; search: string }> {
  const search = searchStringOf(params);
  const cookie = (await cookies()).get(SHELL_COOKIE)?.value ?? null;
  if (legacyShellRequested(search, cookie)) return { target: null, search };
  return { target: workspaceUrlFor(pathname, search), search };
}

/**
 * switchoverTargetFor, and when the server can already decide
 * (serverSwitchTarget) the redirect itself. `hasWorkspace` is passed by a page
 * that has read the session already; otherwise it is read here, and only when
 * there is a target to go to.
 */
export async function switchNowOrGate(
  pathname: string,
  params: RawSearch,
  hasWorkspace?: boolean,
): Promise<{ target: string | null; search: string }> {
  const found = await switchoverTargetFor(pathname, params);
  if (serverSwitchTarget(found.target, found.search, true)) {
    const scoped = hasWorkspace ?? Boolean((await currentContext())?.workspace);
    const now = serverSwitchTarget(found.target, found.search, scoped);
    if (now) redirect(now);
  }
  return found;
}
