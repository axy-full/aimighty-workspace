"use client";
import "./phone-screens.css";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { QueueItem } from "@/lib/control-room/queue";
import { useApprovals } from "@/lib/control-room/use-approvals";
import { moving } from "@/lib/jobsTray";
import { useShell } from "@/lib/shell/state";
import { useJobsTray } from "@/lib/shell/use-jobs-tray";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import type { LibraryEntry, ProjectLibrary } from "@/lib/workspace/library";
import type { Project } from "@/lib/workbench/studio";
import type { ProjectActions } from "../FirstRun";
import { PhoneHeader, PhoneTabs, PhoneToast, type PhoneTab } from "./PhoneChrome";
import { HomeScreen } from "./HomeScreen";
import { ReviewScreen } from "./ReviewScreen";
import { PlanScreen } from "./PlanScreen";
import { RecordScreen } from "./RecordScreen";
import { DRAWN_SCREENS, phoneSearch, readPhone, reviewQueue, type PhoneRoute, type PhoneScreen } from "./phone-model";
import { useOnline, useQueuedJudgements } from "./use-online";

export type PhoneAppProps = {
  scope: string;
  account: WorkspaceAccount | null;
  /** The shell's projects read (lib/workspace/data › useProjects). */
  data: { status: "loading" | "ready" | "error"; projects: ProjectActions["projects"]; error: string | null; retry: () => void };
  project: Project | null;
  items: LibraryEntry[];
  library: ProjectLibrary;
  projectActions: ProjectActions;
  /**
   * The shell's own page for an address the phone has no screen for (Settings, an old page): drawn under the
   * phone's header with a back to Home (DECISIONS 11). Null on the phone's own screens.
   */
  page?: { title: string; body: ReactNode } | null;
};

/** The phone's address, read now: the shell and the browser's back and forward both move it. */
function useRoute(): [PhoneRoute, (patch: Parameters<typeof phoneSearch>[1], mode?: "push" | "replace") => void] {
  const [route, setRoute] = useState<PhoneRoute>(() => readPhone(window.location.search));
  useEffect(() => {
    const again = () => setRoute(readPhone(window.location.search));
    window.addEventListener("popstate", again);
    return () => window.removeEventListener("popstate", again);
  }, []);
  const go = useCallback((patch: Parameters<typeof phoneSearch>[1], mode: "push" | "replace" = "push") => {
    const search = phoneSearch(window.location.search, patch);
    const url = window.location.pathname + search + window.location.hash;
    if (mode === "push") window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
    setRoute(readPhone(search));
  }, []);
  return [route, go];
}

const TITLES: Partial<Record<PhoneScreen, string>> = { home: "Particl", plan: "Plan approval" };

/**
 * The phone (design/particl-graphite/README.md § 3.6; "Phone frames.dc.html"): it judges rather than makes.
 * Stream 1's shell mounts it in place of the header, strip, body and tab bar at phone widths (and for
 * `device=phone` at any width, in a centred 390 px frame), inside the same providers, so the jobs tray, the
 * Atomik host and the toasts are the shell's own.
 *
 * Flat Graphite: opaque fills, hairlines, no blur. Text 12 px and up; every target 44 px and up; the last row
 * and every pinned action sit clear of the tab bar and the home indicator.
 *
 * This build draws Home and the full-screen review. Make and Atomik open today's Make panel and ⌘K until
 * their phone screens land; the Record and plan approval follow in their own PRs (phone-model.ts ›
 * DRAWN_SCREENS).
 */
export function PhoneApp({ scope, account, data, project, items, projectActions, page = null }: PhoneAppProps) {
  const shell = useShell();
  const [route, go] = useRoute();
  const online = useOnline();
  const judgements = useQueuedJudgements(scope);
  const approvals = useApprovals();
  const tray = useJobsTray();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);

  const renders = (tray?.jobs ?? []).filter((job) => moving(job) || job.stage === "queued").length;
  const needs = approvals.items.length + renders + (reviewQueue(items).length ? 1 : 0);
  const topUp = () => shell.goWorkspace("credits");
  /* A plan opens its approval screen, on the project it belongs to. */
  const openPlan = (item: QueueItem) => {
    if (item.project.draftId && item.project.draftId !== project?.id) projectActions.onPick(item.project.draftId);
    go({ screen: "plan", run: item.approve?.kind === "board-approve" ? item.approve.runId : null });
  };
  const home = () => { if (page) shell.goSuite("studio", "home"); go({ screen: "home" }); };
  const onTab = (tab: PhoneTab) => {
    /* Make and Atomik open today's Make panel and ⌘K over the phone until their phone screens land. */
    if (tab === "make") { shell.openMake(); return; }
    if (tab === "atomik") { shell.setPalette(true); return; }
    if (page) shell.goSuite("studio", "home");
    go({ screen: tab });
  };

  const screen = page ? null : route.screen;
  const tabs = screen !== "review" && screen !== "plan";
  const active: PhoneTab | null = page ? null : route.asked === "record" ? "record" : screen === "home" ? "home" : null;

  return (
    <div className="ph-app" data-framed={route.framed || undefined} data-screen={screen ?? "page"} data-online={online ? undefined : "off"} data-testid="phone-app">
      {screen === "review" ? (
        <ReviewScreen scope={scope} project={project} items={items} online={online} startTake={route.take}
          onQueue={judgements.add} onDone={() => go({ screen: "home" })} />
      ) : (
        <>
          <PhoneHeader title={page ? page.title : screen === "record" && project ? project.name : TITLES[screen ?? "home"] ?? "Particl"} account={account} onBack={page || screen !== "home" ? home : null} onTopUp={topUp} />
          {screen === "plan" ? (
            <PlanScreen scope={scope} project={project} runId={route.run} online={online} onHome={home} onTopUp={topUp}
              onChange={() => go({ screen: "atomik" })} />
          ) : (
          <main className="ph-scroll" data-testid="mobile-scroll">
            {page ? <div className="ph-page">{page.body}</div> : screen === "record" ? (
              <RecordScreen scope={scope} project={project} items={items} queue={approvals.items} now={now} onPlan={openPlan} onReview={() => go({ screen: "review" })} />
            ) : (
              <HomeScreen scope={scope} approvals={approvals} projects={data.projects} project={project} items={items} online={online} now={now}
                onReview={() => go({ screen: "review" })}
                onPlan={openPlan}
                onProject={(id) => { projectActions.onPick(id); if (DRAWN_SCREENS.has("record")) go({ screen: "record" }); }}
                onTopUp={topUp} />
            )}
          </main>
          )}
        </>
      )}
      {tabs ? <PhoneTabs active={active} needs={needs} onTab={onTab} drawn={(tab) => tab !== "record" || DRAWN_SCREENS.has("record")} /> : null}
      <PhoneToast />
    </div>
  );
}
