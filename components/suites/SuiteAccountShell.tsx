"use client";

import { useEffect, useState, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import StudioNavigation from "@/components/studio/StudioNavigation";
import type { WorkbenchAccount } from "@/components/workbench/WorkspaceMenu";
import { useMobileViewport } from "@/components/workbench/mobile-ui";
import { withPageLeaveGuard } from "@/lib/usePageLeaveGuard";
import { RoomRail, SuiteDock, SuiteSwitcher } from "./SuiteNavigation";

/** Account pages outside the app providers retain the same captured account scope. */
export default function SuiteAccountShell({
  initialAccount,
  requestScope,
  children,
}: {
  initialAccount: WorkbenchAccount | null;
  requestScope: string | null;
  children: ReactNode;
}) {
  useMobileViewport();
  const query = useSearchParams();
  const explicitProject = query.get("project");
  const router = useRouter();
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Capture account and explicit URL changes without following another tab's selection.
    setRemembered((before) => ({
      scope: requestScope ?? "",
      id: explicitProject || (before.scope === requestScope ? before.id : id),
    }));
  }, [requestScope, explicitProject]);
  const projectId =
    explicitProject ||
    (remembered.scope === requestScope ? remembered.id : "") ||
    undefined;
  return (
    <div
      className="shell studio-application suite-application"
      data-suite="particl"
    >
      <header className="suite-header suite-account-header">
        <StudioNavigation
          compact
          hideSections
          initialAccount={initialAccount}
          requestScope={requestScope}
        >
          <Link
            href="/"
            className="suite-wordmark"
            aria-label="Particl home"
            onNavigate={(event) => {
              event.preventDefault();
              void withPageLeaveGuard(() => router.push("/"));
            }}
          >
            <Image
              src="/brand/particl-wordmark-on-dark@4x.png"
              alt="particl"
              width={68}
              height={21}
              priority
            />
          </Link>
          <SuiteSwitcher suite="particl" projectId={projectId} />
          <span className="suite-account-context">Workspace</span>
        </StudioNavigation>
      </header>
      <div className="shell-body">
        <RoomRail active="workspace" projectId={projectId} />
        <div className="shell-page">{children}</div>
      </div>
      <SuiteDock suite="particl" projectId={projectId} />
    </div>
  );
}
