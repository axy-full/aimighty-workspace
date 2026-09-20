import { cookies } from "next/headers";
import {
  legacyShellRequested,
  searchStringOf,
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
