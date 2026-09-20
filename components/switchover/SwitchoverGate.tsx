"use client";
import { useEffect, useSyncExternalStore } from "react";
import { useSession } from "@/lib/session";
import {
  LEGACY_SHELL,
  NEW_SHELL,
  PHONE_QUERY,
  SHELL_COOKIE,
  SHELL_COOKIE_MAX_AGE,
  SHELL_PARAM,
} from "@/lib/workspace/switchover";
import "./switchover.css";

/* ──────────────────────────────────────────────────────────────────────────
   The device half of the switch-over.

   A server cannot see how wide a window is, so the old entry points render
   with this gate wrapped round the old shell. On a desktop it replaces the
   URL with the workspace one it was given; on a phone it renders the old
   shell and never touches the URL.

   Until the browser answers, the attribute is `pending` and switchover.css
   decides from the same media query — so a desktop never flashes the old
   studio and a phone never flashes the hand-off note.
   ────────────────────────────────────────────────────────────────────────── */

const subscribe = (update: () => void) => {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
};
const snapshot = () => (window.matchMedia(PHONE_QUERY).matches ? "phone" : "desktop");
const serverSnapshot = () => "pending" as const;

/** Remember, or forget, that this browser asked for the old shell. */
export function rememberShellChoice(search: string) {
  const asked = new URLSearchParams(search).get(SHELL_PARAM);
  if (asked !== LEGACY_SHELL && asked !== NEW_SHELL) return;
  try {
    document.cookie =
      asked === LEGACY_SHELL
        ? `${SHELL_COOKIE}=${LEGACY_SHELL}; path=/; max-age=${SHELL_COOKIE_MAX_AGE}; samesite=lax`
        : `${SHELL_COOKIE}=; path=/; max-age=0; samesite=lax`;
  } catch {
    /* Cookies disabled: the `shell` param still works for this page load. */
  }
}

/**
 * `target` is the workspace URL this old URL means, or null to leave the old
 * shell alone (phones, `?shell=legacy`, a legacy-only param, the flag off).
 *
 * `hasWorkspace` is the loop guard. /workspace sends anyone without a
 * workspace back to /workbench, so switching a visitor would bounce them
 * between the two routes forever. Routes inside the (app) layout leave it
 * undefined and the session answers; /workbench renders outside that
 * provider and passes its own.
 */
export default function SwitchoverGate({
  target,
  search,
  hasWorkspace,
  children,
}: {
  target: string | null;
  search: string;
  hasWorkspace?: boolean;
  children: React.ReactNode;
}) {
  const session = useSession();
  const device = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const scoped = hasWorkspace ?? Boolean(session.workspace);
  const switching = Boolean(target) && scoped;

  useEffect(() => {
    rememberShellChoice(search);
  }, [search]);

  useEffect(() => {
    /* replace, not push: the old URL must not become a history entry, or the
       back button would bounce the person straight forward again.

       location.replace, not router.replace: the old shell renders for the one
       hydration pass before the browser answers the media query, and its own
       effects write the URL with history.replaceState (Studio.tsx). A soft
       navigation races that; a document replacement does not. It is also what
       /workspace already does when it hands a phone back. */
    if (switching && device === "desktop") window.location.replace(target!);
  }, [switching, target, device]);

  if (!switching) return children;
  if (device === "desktop") return <SwitchNote target={target!} />;
  if (device === "phone") return children;
  return (
    <div data-pxw-switch="pending">
      <SwitchNote target={target!} />
      <div className="pxw-switch-legacy">{children}</div>
    </div>
  );
}

function SwitchNote({ target }: { target: string }) {
  return (
    <div className="pxw-switch-note" role="status" data-testid="switchover-note">
      <p className="pxw-switch-note-line">Opening the workspace…</p>
      <a className="pxw-switch-note-link" href={target}>
        Continue
      </a>
    </div>
  );
}
