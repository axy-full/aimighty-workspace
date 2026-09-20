"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import type { Project } from "@/lib/workbench/studio";
import { AtomikHost, useAtomik, type PlanBridge } from "@/lib/workspace/atomik-host";
import { useAccount, useProjects, type WorkspaceAccount } from "@/lib/workspace/data";
import { primaryAction } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import { primaryAvailability, type GenerateStatus } from "../PageHeader";
import { ToastHost } from "../ui";
import { MobileActionBar, type MobilePrimary } from "./MobileActionBar";
import { MobileDock } from "./MobileDock";
import { MobileHeader } from "./MobileHeader";
import { MobileSheet } from "./MobileSheet";
import { MOBILE_SHEETS, SHEET_PENDING } from "./sheets/registry";
import { PageScreen } from "./screens/PageScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { SuiteScreen } from "./screens/SuiteScreen";
import { MakeScreen, SettingsScreen } from "./screens/SiblingScreens";
import { MOBILE_PAGES } from "./screens/registry";
import { SuiteMenu } from "./SuiteMenu";

/**
 * The phone shell (05-mobile, "Shell"). 54px header, one scrolling screen, a
 * pinned action bar and the 60px dock, in a column that caps at 440px and
 * centres. It is a different shell over the same machine: the same
 * WorkspaceProvider state, the same `go(suite, page)` with its selection
 * repair, the same Atomik host and plans as the desktop. There is no keyboard
 * layer — stage rows replace 1–8, the primary replaces G, the Inspector sheet
 * replaces I, the dock replaces A and the header search replaces ⌘K.
 */
export type MobileSeams = {
  /** Generate the selected shot. Absent: the primary says why it cannot run. */
  onGenerate?: () => void;
  /** The live quote on Generate and anything blocking it. */
  generate?: GenerateStatus;
};

export function MobileShell({
  scope,
  initialAccount,
  planBridge,
  seams = {},
}: {
  scope: string;
  initialAccount: WorkspaceAccount | null;
  planBridge?: PlanBridge;
  seams?: MobileSeams;
}) {
  const ws = useWorkspace();
  const { state, selectProject } = ws;
  const account = useAccount(initialAccount);
  const data = useProjects(scope, state.projectId, (id) => selectProject(id, { replace: true }));
  const project = data.project;
  const [suiteMenu, setSuiteMenu] = useState(false);

  const openProject = (id: string) => {
    try { localStorage.setItem(scope, id); } catch { /* The URL still carries the project. */ }
    /* Opening a project drills down one level, into that suite's stage list. */
    if (id !== state.projectId) selectProject(id);
    ws.setLevel("suite");
  };

  return (
    <AtomikHost scope={scope} project={project} bridge={planBridge}>
      <div className="pxw pxw-phone" data-view={state.view} data-level={state.mobile}>
        <div className="pxm-shell" data-testid="phone-shell">
          <MobileHeader
            account={account}
            projectName={project?.name ?? ""}
            suiteMenuOpen={suiteMenu}
            onOpenSuiteMenu={() => setSuiteMenu((open) => !open)}
          />
          <SuspendedNotice />
          <div className="pxm-scroll" data-testid="mobile-scroll">
            {state.mobile === "projects" ? (
              <ProjectsScreen
                projects={data.projects}
                project={project}
                status={data.status}
                error={data.error}
                onOpenProject={openProject}
              />
            ) : state.mobile === "suite" ? (
              <SuiteScreen project={project} />
            ) : state.mobile === "make" ? (
              <MakeScreen />
            ) : state.mobile === "settings" ? (
              <SettingsScreen account={account} />
            ) : (
              <PageScreen project={project} scope={scope} />
            )}
          </div>
          <ActionBarForLevel seams={seams} />
          <MobileDock gateWaiting={gateWaiting(ws.state)} />
          {suiteMenu ? <SuiteMenu onClose={() => setSuiteMenu(false)} /> : null}
          <SheetHost scope={scope} project={project} onGenerate={seams.onGenerate} />
          <ToastHost />
        </div>
      </div>
    </AtomikHost>
  );
}

/** A gate waiting anywhere in the project badges the dock's Atomik tab. */
function gateWaiting(state: ReturnType<typeof useWorkspace>["state"]) {
  return state.run?.status === "waiting";
}

/**
 * The action bar belongs to the screens that have work to dispatch: a page
 * (through its plan or its own primary) and Make. Projects and the Suite list
 * choose; they do not spend.
 */
function ActionBarForLevel({ seams }: { seams: MobileSeams }) {
  const ws = useWorkspace();
  const { state } = ws;
  const atomik = useAtomik();
  const plan = ws.plans(state.page);

  const pagePrimary = (): MobilePrimary | null => {
    const registered = MOBILE_PAGES[state.page]?.primary;
    if (registered) {
      const own = registered({ page: state.page, project: null, scope: "", onGenerate: seams.onGenerate, quote: seams.generate?.quote ?? null, blocked: seams.generate?.blocked ?? null });
      if (own) return own;
    }
    const action = primaryAction(state.page);
    if (action.kind === "generate") {
      const availability = primaryAvailability(state, seams.onGenerate, seams.generate);
      return {
        label: action.label,
        cost: availability.enabled ? seams.generate?.quote ?? null : null,
        blocked: availability.reason,
        run: () => seams.onGenerate?.(),
      };
    }
    if (action.kind === "run-stage") {
      /* The plan's own price — the live quote once the run has one. Nothing
         paid dispatches here: the plan stops at its gate. */
      return {
        label: action.label,
        cost: plan?.price ?? null,
        blocked: plan?.runnable === false ? "Not runnable yet on this project." : null,
        run: () => {
          ws.setSheet("atomik");
          atomik.start(state.page);
        },
      };
    }
    /* Upload and Add cast run on their own page; they open with its template. */
    return {
      label: action.label,
      cost: null,
      blocked: action.kind === "upload" ? "Uploading opens with the Takes screen." : "Adding cast opens with the Cast screen.",
      run: () => {},
    };
  };

  if (state.mobile !== "page" && state.mobile !== "make") return null;
  if (state.mobile === "page" && !plan) return null;
  return <MobileActionBar primary={state.mobile === "page" ? pagePrimary() : null} />;
}

/** One chrome, four sheets: Search is wired, the other three register in M-C. */
function SheetHost({ scope, project, onGenerate }: { scope: string; project: Project | null; onGenerate?: () => void }) {
  const ws = useWorkspace();
  const atomik = useAtomik();
  const id = ws.state.sheet;
  if (!id) return null;
  const def = MOBILE_SHEETS[id];
  const run = atomik.runFor(ws.state.page);
  const Body = def.Body;
  return (
    <MobileSheet
      title={def.title}
      sub={def.sub?.(project)}
      dot={def.ring ? (run?.status === "waiting" ? "var(--pxw-amber)" : run?.status === "running" ? "var(--pxw-blue)" : "var(--pxw-atomik-gold)") : undefined}
      beating={def.ring && (run?.status === "running" || run?.status === "waiting")}
      onClose={() => ws.setSheet(null)}
    >
      {Body ? <Body scope={scope} project={project} onGenerate={onGenerate} /> : <p className="pxm-note">{SHEET_PENDING[id]}</p>}
    </MobileSheet>
  );
}

/** A suspended workspace says so on the phone too. */
function SuspendedNotice() {
  const { workspace } = useSession();
  if (!workspace?.suspended) return null;
  return (
    <div className="pxm-suspended" role="status" data-testid="workspace-suspended">
      This workspace is suspended{workspace.suspendedReason ? ` — ${workspace.suspendedReason}` : ""}. Rendering is paused;
      everything already made is still here.
    </div>
  );
}
