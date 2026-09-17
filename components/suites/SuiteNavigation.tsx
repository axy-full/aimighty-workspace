"use client";

import { useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Building2,
  Clapperboard,
  FolderOpen,
  PanelsTopLeft,
  ScanLine,
} from "lucide-react";
import { withPageLeaveGuard } from "@/lib/usePageLeaveGuard";
import {
  PAGES,
  SUITES,
  roomHref,
  suiteHref,
  type RoomId,
  type SuiteId,
} from "@/lib/suites";
import "./suite-navigation.css";

export type SuiteNavigate = (href: string) => void | Promise<unknown>;
function useFollow(onNavigate?: SuiteNavigate) {
  const router = useRouter();
  const [error, setError] = useState("");
  function follow(
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
    onPage?: () => void | Promise<unknown>,
  ) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    setError("");
    void Promise.resolve()
      .then(() =>
        onPage
          ? onPage()
          : onNavigate
            ? onNavigate(href)
            : withPageLeaveGuard(() => router.push(href)),
      )
      .catch(() =>
        setError("Could not open this page. Your current work is still here."),
      );
  }
  return { follow, error };
}

export function SuiteSwitcher({
  suite,
  projectId,
  onNavigate,
}: {
  suite: SuiteId;
  projectId?: string;
  onNavigate?: SuiteNavigate;
}) {
  const { follow, error } = useFollow(onNavigate);
  return <div className="suite-switcher">
    <nav className="suite-top-tabs" aria-label="Suites">
      {SUITES.map(item => <Link key={item.id} href={suiteHref(item.id, projectId)} prefetch={false}
        onClick={event => follow(event, suiteHref(item.id, projectId))}
        aria-current={suite === item.id ? "page" : undefined}
        style={{ '--suite-tab-color': item.color } as import('react').CSSProperties}>
        <span className="suite-dot" style={{ backgroundColor: item.color }} aria-hidden="true" />
        <span>{item.name}</span>
      </Link>)}
    </nav>
    {error && <p className="suite-navigation-error" role="alert">{error}</p>}
  </div>;
}

const ROOMS = [
  { id: "projects", label: "Projects", icon: PanelsTopLeft },
  { id: "production", label: "Production", icon: Clapperboard },
  { id: "make", label: "Make", icon: ScanLine },
  { id: "library", label: "Library", icon: FolderOpen },
  { id: "workspace", label: "Workspace", icon: Building2 },
] as const;
export function RoomRail({
  active,
  projectId,
  onNavigate,
}: {
  active: RoomId;
  projectId?: string;
  onNavigate?: SuiteNavigate;
}) {
  const { follow, error } = useFollow(onNavigate);
  return (
    <nav className="suite-room-rail" aria-label="Rooms">
      {ROOMS.map(({ id, label, icon: Icon }) => (
        <Link
          key={id}
          href={roomHref(id, projectId)}
          aria-label={label}
          title={label}
          prefetch={false}
          onClick={(event) => follow(event, roomHref(id, projectId))}
          aria-current={id === active ? "page" : undefined}
        >
          <Icon size={19} strokeWidth={1.6} />
          <span>{label}</span>
        </Link>
      ))}
      {error && (
        <p className="suite-navigation-error" role="alert">
          {error}
        </p>
      )}
    </nav>
  );
}

export function SuiteDock({
  suite,
  activePage,
  projectId,
  onNavigate,
  onPage,
  disabled = false,
}: {
  suite: SuiteId;
  activePage?: string;
  projectId?: string;
  onNavigate?: SuiteNavigate;
  onPage?: (page: string) => void | Promise<unknown>;
  disabled?: boolean;
}) {
  const { follow, error } = useFollow(onNavigate);
  const numbered = suite === "particl" || suite === "moleculr";
  return (
    <nav
      className="suite-page-dock"
      aria-label={`${SUITES.find((item) => item.id === suite)!.name} pages`}
    >
      {PAGES[suite].map((page, index) => {
        const label = (
          <>
            {numbered && (
              <small aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </small>
            )}
            <span>{page.label}</span>
          </>
        );
        return disabled ? (
          <a
            key={page.id}
            role="link"
            aria-label={page.label}
            aria-disabled="true"
            tabIndex={-1}
            aria-current={activePage === page.id ? "page" : undefined}
          >
            {label}
          </a>
        ) : (
          <Link
            key={page.id}
            href={suiteHref(suite, projectId, page.id)}
            prefetch={false}
            aria-label={page.label}
            aria-current={activePage === page.id ? "page" : undefined}
            onClick={(event) =>
              follow(
                event,
                suiteHref(suite, projectId, page.id),
                onPage ? () => onPage(page.id) : undefined,
              )
            }
          >
            {label}
          </Link>
        );
      })}
      {error && (
        <p className="suite-navigation-error" role="alert">
          {error}
        </p>
      )}
    </nav>
  );
}
