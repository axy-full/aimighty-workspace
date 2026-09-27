"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useSession } from "@/lib/session";
import {
  bindAtomikRail,
  setAtomikRail,
  toggleAtomikRail,
  useAtomikRail,
} from "@/lib/atomikRail";
import { AtomikProvider } from "@/components/atomik/AtomikProvider";
import AtomikRail from "@/components/atomik/AtomikRail";
import AtomikSheet from "@/components/atomik/AtomikSheet";
import { RoomRail } from "@/components/suites/SuiteNavigation";
import { SuiteProjectProvider } from "@/components/suites/SuiteProjectContext";
import { PAGES, roomForRoute, suiteForRoute } from "@/lib/suites";
import Header from "./Header";
import { useMobileViewport } from "@/components/workbench/mobile-ui";
import Dock from "./Dock";
import SuspendedBar from "./SuspendedBar";

/**
 * The (app) shell, with the page inside it and NO Suspense boundary round the
 * two. A boundary here put every page's server work in a streamed hole: a page
 * that answers with redirect() — /, /atomik and /subatomik switching a signed-in
 * person to Suites, /images, /make/… — had already sent 200 and the shell by
 * the time it ran, so the redirect went out as a meta refresh and a second
 * document. Outside any boundary it is the response itself: a 307.
 *
 * useSearchParams needs no boundary here: the (app) layout reads the session
 * cookie, so every route under it renders per request and is never prerendered
 * (the only render in which the hook would bail out to the client).
 */
export default function Shell({ children }: { children: React.ReactNode }) {
  return <SuiteShell>{children}</SuiteShell>;
}
function SuiteShell({ children }: { children: React.ReactNode }) {
  useMobileViewport();
  const { email, requestScope } = useSession();
  const path = usePathname(),
    query = useSearchParams();
  const explicitProject = query.get("project");
  const [remembered, setRemembered] = useState({ scope: "", id: "" });
  useEffect(() => {
    let id = explicitProject || "";
    try {
      if (requestScope) {
        id = explicitProject || localStorage.getItem(requestScope) || "";
        if (explicitProject)
          localStorage.setItem(requestScope, explicitProject);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Capture only this account and explicit URL changes; other tabs cannot retarget the current view.
    setRemembered((before) => ({
      scope: requestScope ?? "",
      id: explicitProject || (before.scope === requestScope ? before.id : id),
    }));
  }, [requestScope, explicitProject]);
  const projectId =
    explicitProject ||
    (remembered.scope === requestScope ? remembered.id : "") ||
    undefined;
  const projectReady =
    !!explicitProject || !requestScope || remembered.scope === requestScope;
  const suite = suiteForRoute(path, query),
    room = roomForRoute(path);
  const activePage =
    suite === "particl"
      ? (query.get("stage") ?? undefined)
      : (query.get("page") ?? PAGES[suite][0].id);
  const rail = useAtomikRail();
  const focusedSection = /^\/(settings|team|usage|statements)(\/|$)/.test(path);
  useEffect(() => {
    bindAtomikRail(email ?? "visitor");
  }, [email]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleAtomikRail();
      } else if (e.key === "Escape") setAtomikRail("closed");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <SuiteProjectProvider projectId={projectId} ready={projectReady}>
      <AtomikProvider>
        <div
          className="shell studio-application suite-application"
          data-suite={suite}
        >
          <Header suite={suite} projectId={projectId} />
          <SuspendedBar />
          <div className="shell-body">
            {suite === "particl" && (
              <RoomRail active={room} projectId={projectId} />
            )}
            <div className="shell-page">{children}</div>
            {!focusedSection && (
              <>
                <div className="suite-desktop-atomik">
                  {rail.open && <AtomikRail />}
                </div>
                <div className="suite-phone-atomik">
                  <AtomikSheet />
                </div>
              </>
            )}
          </div>
          <Dock suite={suite} activePage={activePage} projectId={projectId} />
        </div>
      </AtomikProvider>
    </SuiteProjectProvider>
  );
}
