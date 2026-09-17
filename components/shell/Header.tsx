"use client";

import { useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Plus, FolderOpen } from "lucide-react";
import { useSession } from "@/lib/session";
import { useProject } from "@/lib/projectContext";
import { useApi } from "@/lib/useApi";
import { withPageLeaveGuard } from "@/lib/usePageLeaveGuard";
import { toggleAtomikRail, useAtomikRail } from "@/lib/atomikRail";
import { AtomikMark } from "@/components/AtomikMark";
import StudioNavigation from "@/components/studio/StudioNavigation";
import { SuiteSwitcher } from "@/components/suites/SuiteNavigation";
import { roomHref, suiteHref, type SuiteId } from "@/lib/suites";
import type { Project } from "@/lib/workbench/studio";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/workbench/ui/dropdown-menu";

export default function Header({
  suite,
  projectId,
}: {
  suite: SuiteId;
  projectId?: string;
}) {
  const session = useSession(),
    router = useRouter(),
    path = usePathname(),
    query = useSearchParams();
  const { setSelection } = useProject();
  const rail = useAtomikRail();
  const { data, error } = useApi<{
    project: Project | null;
    projects: { id: string; name: string }[];
  }>(
    session.workspace && session.requestScope
      ? `/api/workbench/projects${projectId ? `?id=${encodeURIComponent(projectId)}` : ""}`
      : null,
    0,
    session.requestScope,
  );
  const project = data?.project;
  useEffect(() => {
    if (project?.productionProjectId) setSelection(project.productionProjectId);
  }, [project?.productionProjectId, setSelection]);
  const go = async (href: string) => {
    await withPageLeaveGuard(() => router.push(href));
  };
  function projectHref(id: string) {
    if (/^\/(generate|library|make)(\/|$)/.test(path)) {
      const params = new URLSearchParams(query);
      params.set("project", id);
      return `${path}?${params}`;
    }
    return suiteHref(suite, id, query.get("page") ?? undefined);
  }
  return (
    <header className="suite-header">
      <StudioNavigation
        compact
        hideSections
        requestScope={session.requestScope}
        initialAccount={
          session.signedIn
            ? {
                name: session.name ?? "Your account",
                workspace: session.workspace,
                workspaces: session.workspaces,
                credits: session.credits,
              }
            : null
        }
      >
        <Link
          href="/"
          className="suite-wordmark"
          aria-label="Particl home"
          onNavigate={(event) => {
            event.preventDefault();
            void go("/");
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
        <SuiteSwitcher suite={suite} projectId={projectId} />
        <div className="suite-project-context">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="suite-project-picker"
                type="button"
                aria-label="Select project"
              >
                <span>
                  {project?.name ??
                    (projectId && !error
                      ? "Loading project…"
                      : "Choose a project")}
                </span>
                {project && (
                  <small>
                    {project.aspect} · {project.fps} fps
                  </small>
                )}
                <ChevronDown size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="suite-switcher-menu" align="center">
              {(data?.projects ?? []).map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  onSelect={() => void go(projectHref(item.id))}
                >
                  {item.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => void go("/workbench?new=1")}>
                <Plus size={14} />
                New project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Link href={roomHref('library',projectId)} prefetch={false} className="suite-assets-toggle" aria-label="All assets" title="All assets" onNavigate={event=>{event.preventDefault();void go(roomHref('library',projectId));}}><FolderOpen size={18}/></Link>
        <button
          className="suite-agent-toggle"
          type="button"
          aria-label="Toggle Atomik creative engine"
          aria-expanded={rail.open}
          onClick={toggleAtomikRail}
        >
          <AtomikMark size={18} />
        </button>
      </StudioNavigation>
      {error && (
        <p className="suite-header-error" role="alert">
          Could not load the project selector. Your current work stays open.
        </p>
      )}
    </header>
  );
}
