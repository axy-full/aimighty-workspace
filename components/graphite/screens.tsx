"use client";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import Boundary, { type Fault } from "@/components/Boundary";
import { PanelFault } from "./PanelFault";
import type { WorkspaceAccount, useProjects } from "@/lib/workspace/data";
import type { LibraryEntry, ProjectLibrary } from "@/lib/workspace/library";
import type { Project } from "@/lib/workbench/studio";
import type { CreateSeed } from "@/lib/shell/create-project";
import type { Shell } from "@/lib/shell/state";
import type { BoardKindId, ScreenId } from "@/lib/shell/screens";
import { FirstRun, type ProjectActions } from "./FirstRun";
import { isControlRoomPage } from "./control-room/pages";

/**
 * The shell's mounts for the new interface's screens (lib/shell/screens.ts is the registry that says which exist).
 * Each entry is loaded lazily, in the browser only, so a screen's code (React Flow for the board, say) is fetched
 * only where it is shown, and a customer with the switch off never downloads any of it. Each mount sits in its own
 * Boundary: one that throws shows its own fault card and the rest of the shell keeps working.
 *
 * This is the one place a screen's props are adapted from the shell's, so a stream changing its entry's props changes
 * this file's adapter, never SuitesShell. Streams own their entry modules; this file is the shell's.
 */
const HomeEntry = dynamic(() => import("./home/HomeView").then((m) => m.HomeView), { ssr: false });
const BoardEntry = dynamic(() => import("./board/BoardView").then((m) => m.BoardView), { ssr: false });
const ControlRoomEntry = dynamic(() => import("./control-room/ControlRoom").then((m) => m.ControlRoom), { ssr: false });
const SettingsEntry = dynamic(() => import("./settings/SettingsView").then((m) => m.SettingsView), { ssr: false });
const PhoneEntry = dynamic(() => import("./phone/PhoneApp").then((m) => m.PhoneApp), { ssr: false });
const AtomikEntry = dynamic(() => import("./atomik/panel/AtomikPanel").then((m) => m.AtomikPanel), { ssr: false });

/** Everything a screen's adapter may need from the shell. */
export type ScreenContext = {
  shell: Shell;
  scope: string;
  account: WorkspaceAccount | null;
  project: Project | null;
  items: LibraryEntry[];
  library: ProjectLibrary;
  /** The shell's projects read (lib/workspace/data › useProjects). */
  data: ReturnType<typeof useProjects>;
  projectActions: ProjectActions;
  now: number;
  /** Today's create path with a seed's fields set (SuitesShell): the new project's id, or why it could not be made. */
  onCreate: (name: string, seed: CreateSeed) => Promise<{ id: string; productionId?: string | null } | { error: string }>;
};

function ScreenFault({ fault, name }: { fault: Fault; name: string }) {
  return <div className="gx-fault-view gx-scroll"><PanelFault fault={fault} name={name} /></div>;
}

const BOARD_KINDS: readonly string[] = ["studio", "ads", "social"];
const boardKind = (value: string | undefined): BoardKindId | null => (value && BOARD_KINDS.includes(value) ? (value as BoardKindId) : null);

/** The body of a screen that fills the shell's body (Home, the board, the control room); null for one that is not that kind. */
export function ScreenBody({ screen, ctx }: { screen: ScreenId; ctx: ScreenContext }): ReactNode {
  const { shell, scope, project, items, library, data } = ctx;
  switch (screen) {
    case "home":
      return (
        <Boundary what="Home" probe="home" resetKey={`home:${scope}`} fallback={(f) => <ScreenFault fault={f} name="home" />}>
          <HomeEntry scope={scope} projects={data.projects} status={data.status} error={data.error} onRetry={data.retry} onPick={ctx.projectActions.onPick}
            onCreate={ctx.onCreate} onStarter={ctx.projectActions.onStarter} now={ctx.now} />
        </Boundary>
      );
    case "board":
    case "board-ads":
    case "board-social":
      /* The board is for every workspace, so a workspace with no project yet gets Studio's first run here (New project, the starter) rather than a board that never opens. */
      if (!project && data.status === "ready") {
        return (
          <Boundary what="The board" probe="board" resetKey={`board:none`} fallback={(f) => <ScreenFault fault={f} name="board" />}>
            <div className="gx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto" }} data-testid="board-no-project"><FirstRun stage="board" lead="Open or create a project to use the board." actions={ctx.projectActions} now={ctx.now} /></div>
          </Boundary>
        );
      }
      return (
        <Boundary what="The board" probe="board" resetKey={`board:${project?.id ?? ""}:${shell.params.kind ?? ""}`} fallback={(f) => <ScreenFault fault={f} name="board" />}>
          <BoardEntry scope={scope} project={project} items={items} library={library} kind={boardKind(shell.params.kind)} frame={shell.params.frame ?? null} region={shell.params.region ?? null} />
        </Boundary>
      );
    case "control-room": {
      const page = shell.page.id;
      if (!isControlRoomPage(page)) return null;
      return (
        <Boundary what="The control room" probe="control-room" resetKey={`control-room:${page}:${project?.id ?? ""}`} fallback={(f) => <ScreenFault fault={f} name="control-room" />}>
          <ControlRoomEntry page={page} project={project} />
        </Boundary>
      );
    }
    default:
      return null;
  }
}

/** Settings, in place of Workspace's old tabs. */
export function SettingsBody({ ctx }: { ctx: ScreenContext }) {
  const { shell } = ctx;
  return (
    <Boundary what="Settings" probe="settings" resetKey={`settings:${shell.wsTab}`} fallback={(f) => <ScreenFault fault={f} name="settings" />}>
      <SettingsEntry account={ctx.account} section={shell.wsTab} open={shell.wsOpen} />
    </Boundary>
  );
}

/** Atomik's panel, over whatever is on screen. Esc closes it (SuitesShell's keymap, after ⌘K and menus). */
export function AtomikMount({ ctx }: { ctx: ScreenContext }) {
  const { shell, scope, project } = ctx;
  if (!shell.atomik) return null;
  return (
    <Boundary what="Atomik" probe="atomik-panel" resetKey={`atomik:${shell.atomik}`} fallback={(f) => (
      <aside className="gx-atomik-fault" aria-label="Atomik"><PanelFault fault={f} name="atomik-panel" actions={<button type="button" className="gx-hbtn" onClick={shell.closeAtomik}>Close</button>} /></aside>
    )}>
      <AtomikEntry mode={shell.atomik} query={shell.atomikQuery} onClose={shell.closeAtomik} scope={scope} project={project} />
    </Boundary>
  );
}

/** The phone's own screens, which replace the header, strip, body and tab bar. */
export function PhoneMount({ ctx, page }: { ctx: ScreenContext; page: { title: string; body: ReactNode } | null }) {
  const { scope, account, project, items, library, data, projectActions } = ctx;
  return (
    <Boundary what="The phone" probe="phone" resetKey={`phone:${scope}`} fallback={(f) => <ScreenFault fault={f} name="phone" />}>
      <PhoneEntry scope={scope} account={account} data={data} project={project} items={items} library={library} projectActions={projectActions} page={page} />
    </Boundary>
  );
}
