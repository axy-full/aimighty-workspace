"use client";
import { useEffect, useSyncExternalStore } from "react";
import { useSession } from "@/lib/session";
import { createDeviceLatch, windowDeviceRecord } from "@/lib/workspace/device";
import {
  LEGACY_SHELL,
  NEW_SHELL,
  PHONE_QUERY,
  SHELL_COOKIE,
  SHELL_COOKIE_MAX_AGE,
  SHELL_PARAM,
  shellCookieScript,
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

   The answer is LATCHED (lib/workspace/device.ts): taken once per document and
   never re-taken. The phone half of PHONE_QUERY matches a touch phone held
   landscape on `max-height: 500px`, and that height moves within one document
   — a keyboard closing, browser chrome collapsing, a dev overlay — so a live
   re-decide would redirect somebody out of the phone surface they were using.
   A rotation that reloads the document still decides freshly.

   It is taken while the document PARSES, by `DeviceProbe`, which the ROOT LAYOUT
   mounts — not this component, because React never executes a <script> it
   creates during a client render and this component re-renders. The reason for
   parse time is that hydration is not a fixed point: a cold dev compile lands it
   seconds after the document was readable, so a decision taken then is taken
   from whatever the viewport has become rather than from what the person opened.
   Parse time is also exactly when switchover.css decides the first paint from
   the same query, so the two halves cannot disagree.
   ────────────────────────────────────────────────────────────────────────── */

const latch = createDeviceLatch(() => window.matchMedia(PHONE_QUERY), windowDeviceRecord());
/* The bundle may load before hydration but after the parse script; deciding
   here too makes the answer no later than the moment this module runs, which
   is the fallback for a soft navigation whose script never executed. */
if (typeof window !== "undefined") latch.snapshot();

/**
 * The same write as shellCookieScript, for a navigation that never re-parsed
 * the document (a soft navigation into one of these routes). Harmless when the
 * script has already run: it writes the same value.
 */
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
  const device = useSyncExternalStore(latch.subscribe, latch.snapshot, latch.serverSnapshot);
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

  const cookie = <ShellCookie search={search} />;
  if (!switching) return <>{cookie}{children}</>;
  if (device === "desktop") return <><SwitchNote target={target!} />{cookie}</>;
  if (device === "phone") return <>{cookie}{children}</>;
  return (
    <div data-pxw-switch="pending">
      <SwitchNote target={target!} />
      <div className="pxw-switch-legacy">{children}</div>
    </div>
  );
}

/**
 * The cookie, written while the document parses rather than after hydration,
 * so a `?shell=` choice is already remembered by the time anything can act on
 * it. Constant strings only (lib/workspace/switchover.ts).
 */
function ShellCookie({ search }: { search: string }) {
  const script = shellCookieScript(search);
  if (!script) return null;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
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
