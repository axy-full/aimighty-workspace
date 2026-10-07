"use client";
import "./phone-screens.css";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { QueueItem } from "@/lib/control-room/queue";
import { useApprovals } from "@/lib/control-room/use-approvals";
import { moving } from "@/lib/jobsTray";
import { isMakeTool } from "@/lib/shell/make";
import { openAtomikChat, type OpenChat } from "@/lib/shell/use-skills";
import { useShell } from "@/lib/shell/state";
import { refreshProjectLibrary } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { useJobsTray } from "@/lib/shell/use-jobs-tray";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import type { LibraryEntry, ProjectLibrary } from "@/lib/workspace/library";
import type { Project } from "@/lib/workbench/studio";
import type { ProjectActions } from "../FirstRun";
import type { CreateFromSeed, OpenBoard } from "../home/use-home-start";
import { PhoneHeader, PhoneTabs, PhoneToast, type PhoneTab } from "./PhoneChrome";
import { HomeScreen } from "./HomeScreen";
import { ReviewScreen } from "./ReviewScreen";
import { PlanScreen } from "./PlanScreen";
import { RecordScreen } from "./RecordScreen";
import { MakeScreen } from "./MakeScreen";
import { AtomikSheet } from "./AtomikSheet";
import { StatesScreen } from "./StatesScreen";
import { PhoneCutScreen } from "./PhoneCutScreen";
import { LargerScreen } from "./LargerScreen";
import { StartBrief } from "./StartBrief";
import { DRAWN_SCREENS, LARGER_TITLES, phoneSearch, readPhone, reviewQueue, type PhoneRoute, type PhoneScreen } from "./phone-model";
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
  /** Today's create path with a seed's fields set (SuitesShell › createFromSeed): what Home's templates and Start use, here too. */
  onCreate: CreateFromSeed;
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

const TITLES: Partial<Record<PhoneScreen, string>> = { home: "Particl", plan: "Plan approval", make: "Make", fix: "Review", cut: "Cut" };

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
export function PhoneApp({ scope, account, data, project, items, projectActions, onCreate, page = null }: PhoneAppProps) {
  const shell = useShell();
  const { toast } = useWorkspace();
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
  /* An Atomik plan's step opens its thread in Atomik's sheet, on the project it belongs to (the desktop's Open does the same in the panel). */
  const [pendingChat, setPendingChat] = useState<OpenChat | null>(null);
  const openThread = (item: QueueItem) => {
    if (item.project.draftId && item.project.draftId !== project?.id) projectActions.onPick(item.project.draftId);
    if (item.open.kind === "thread") setPendingChat({ chatId: item.open.chatId, projectId: item.open.productionId });
    openAtomik();
  };
  const home = () => { if (page) shell.goSuite("studio", "home"); go({ screen: "home" }); };
  /* The screen under the Atomik sheet: the one the sheet was opened from (Home when it is the address itself). */
  const [under, setUnder] = useState<PhoneScreen>("home");
  if (!page && route.screen !== "atomik" && under !== route.screen) setUnder(route.screen);
  /* Words handed to the sheet: Plan's Change, or an address's `q`. */
  const [handed, setHanded] = useState<string | null>(null);
  const openAtomik = (words: string | null = null) => { setHanded(words); go({ screen: "atomik" }); };
  const onTab = (tab: PhoneTab) => {
    if (page) shell.goSuite("studio", "home");
    if (tab === "atomik") { openAtomik(); return; }
    go({ screen: tab });
  };
  /* An address or a link that opens the shell's Make panel or Atomik panel (`make=video`, `atomik=1&q=…`) opens the phone's own
     screens instead: the panel is the desktop's, and the phone has its own (DECISIONS 11). A quick tool and Recent stay the panel's. */
  const { make: shellMake, atomik: shellAtomik, atomikQuery } = shell;
  useEffect(() => {
    if (shellMake && !isMakeTool(shellMake) && shellMake !== "recent") { shell.closeMake(); go({ screen: "make" }, "replace"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the shell's close and the router's go are stable enough; only the address matters
  }, [shellMake]);
  const [seenAtomik, setSeenAtomik] = useState<string | null>(null);
  const addressed = shellAtomik ? `${shellAtomik}:${atomikQuery ?? ""}` : null;
  if (addressed && seenAtomik !== addressed) { setSeenAtomik(addressed); setHanded(atomikQuery); }
  useEffect(() => {
    if (shellAtomik) { shell.closeAtomik(); go({ screen: "atomik" }, "replace"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
  }, [shellAtomik]);

  /* Activity, Memory and Skills have no phone screen until after the demo: a plain page that says so, with a way Home. */
  const larger = !page && route.asked === "home" ? route.larger : null;
  const sheet = !page && route.screen === "atomik";
  /* Said once the sheet is mounted, so its conversation is listening (components/atomik/skills/useSkillRunOpens.ts). */
  // eslint-disable-next-line react-hooks/set-state-in-effect -- One-shot hand-off: the chat id is said once the sheet is mounted, then cleared.
  useEffect(() => { if (sheet && pendingChat) { openAtomikChat(pendingChat); setPendingChat(null); } }, [sheet, pendingChat]);
  /* Under the Atomik sheet the screen it was opened from still shows. */
  const screen = page ? null : sheet ? under : route.screen;
  /* The bar stays on every phone screen but the full-screen review and plan approval (SOW § 2); Change with words keeps it under its sheet. */
  const tabs = screen !== "review" && screen !== "plan";
  /* States is Home's own (the master lights Home there). */
  const active: PhoneTab | null = page || larger ? null : sheet ? "atomik" : screen === "record" ? "record" : screen === "make" ? "make" : screen === "home" || screen === "states" ? "home" : null;
  const inReview = screen === "review" || screen === "fix";
  /* A project is open (made on Home, or reused): the board is its Record on a phone. */
  const opened: OpenBoard = () => go({ screen: "record" });

  return (
    <div className="ph-app" data-framed={route.framed || undefined} data-screen={screen ?? "page"} data-online={online ? undefined : "off"} data-testid="phone-app">
      {/* Change with words keeps the review under its sheet, under a header with a way back (frame D). */}
      {screen === "fix" ? <PhoneHeader title="Review" account={account} onBack={() => go({ screen: "review" })} onTopUp={topUp} /> : null}
      {inReview ? (
        <ReviewScreen scope={scope} project={project} items={items} online={online} startTake={route.take}
          fixOpen={screen === "fix"} onFix={(take) => go({ screen: "fix", take })} onFixClose={() => go({ screen: "review" })}
          onFixed={(line) => { toast(line); void refreshProjectLibrary(scope, project?.id ?? ""); go({ screen: "home" }); }}
          onQueue={judgements.add} onDone={() => go({ screen: "home" })} />
      ) : (
        <>
          <PhoneHeader title={page ? page.title : larger ? LARGER_TITLES[larger] : screen === "record" && project ? project.name : screen === "states" ? `${project?.name ?? "Particl"} · states` : TITLES[screen ?? "home"] ?? "Particl"} account={account} onBack={page || larger || screen !== "home" ? home : null} onTopUp={topUp} />
          {larger ? (
            <LargerScreen page={larger} onHome={home} />
          ) : screen === "make" && !page ? (
            <MakeScreen scope={scope} project={project} items={items} workspaceName={account?.workspace?.name ?? null} balance={account?.credits?.balance ?? null}
              projects={data.status} onProject={(id) => projectActions.onPick(id)} online={online} onTopUp={topUp} />
          ) : screen === "cut" && !page ? (
            <main className="ph-scroll" data-testid="mobile-scroll"><PhoneCutScreen scope={scope} project={project} items={items} online={online} /></main>
          ) : screen === "states" ? (
            <StatesScreen scope={scope} project={project} items={items} online={online} now={now} balance={account?.credits?.balance ?? null} onTopUp={topUp} onQueue={judgements.add} />
          ) : screen === "plan" ? (
            <PlanScreen scope={scope} project={project} runId={route.run} online={online} onHome={home} onTopUp={topUp}
              onChange={() => openAtomik("Change the plan: ")} />
          ) : (
          <main className="ph-scroll" data-testid="mobile-scroll">
            {page ? <div className="ph-page">{page.body}</div> : screen === "record" ? (
              <RecordScreen scope={scope} project={project} items={items} queue={approvals.items} now={now} onPlan={openPlan} onReview={() => go({ screen: "review" })} onCut={() => go({ screen: "cut" })} />
            ) : (
              <HomeScreen scope={scope} approvals={approvals} projects={data.projects} projectsError={data.status === "error" ? data.error ?? "Projects could not be loaded." : null} onRetryProjects={data.retry} project={project} items={items} online={online} now={now}
                onReview={() => go({ screen: "review" })}
                onPlan={openPlan}
                onThread={openThread}
                onProject={(id) => { projectActions.onPick(id); if (DRAWN_SCREENS.has("record")) go({ screen: "record" }); }}
                onTopUp={topUp}
                start={<StartBrief scope={scope} projects={data.projects} online={online} onPick={projectActions.onPick} onCreate={onCreate} onOpened={opened} />} />
            )}
          </main>
          )}
        </>
      )}
      {tabs ? <PhoneTabs active={active} needs={needs} onTab={onTab} /> : null}
      {sheet ? (
        <AtomikSheet project={project} query={handed} online={online} onClose={() => go({ screen: under })}
          places={{ home, record: () => go({ screen: "record" }), make: () => go({ screen: "make" }) }} />
      ) : null}
      <PhoneToast />
    </div>
  );
}
