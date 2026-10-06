import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The seams between streams, held where they are wired (the integration lane). Each reads the shell's source because the
 * wiring lives in one React component; the browser spec tests/demo-int-seams-workbench.spec.ts holds the behaviour.
 */
const read = (file: string) => readFileSync(join(__dirname, "..", "..", file), "utf8");
const shell = read("components/graphite/SuitesShell.tsx");

test("seam b: the phone's own screens never share the page with the desktop's Make panel or Atomik's panel", () => {
  expect(shell).toMatch(/\{shell\.make && !phoneOn \? \(/);
  expect(shell).toMatch(/\{!phoneOn \? <AtomikMount ctx=\{screenCtx\} \/> : null\}/);
  /* phoneOn is declared before the JSX that reads it. */
  expect(shell.indexOf("const phoneOn = shell.phone.on;")).toBeGreaterThan(0);
  expect(shell.indexOf("const phoneOn = shell.phone.on;")).toBeLessThan(shell.indexOf("shell.make && !phoneOn"));
});

test("seam c: ⌘K's ask seam opens Atomik's panel with the words, and the Agent page only before the panel has landed", () => {
  const ask = shell.slice(shell.indexOf("const ask = (text: string) => {"), shell.indexOf("const openProjectId"));
  expect(ask).toContain('isLanded("atomik")');
  expect(ask).toContain('shell.openAtomik("panel", text)');
  /* The old path stays for a panel that has not landed. */
  expect(ask).toContain('shell.goSuite("atomik", "agent")');
  expect(ask.indexOf("shell.openAtomik")).toBeLessThan(ask.indexOf("prefillAgentRequest"));
  expect(shell).toContain("<Palette items={items} onAsk={ask} project={project} />");
});

test("seam a: the board's source takes Atomik's run from stream 7's seam, with no second poll of its own", () => {
  const board = read("components/graphite/board/BoardView.tsx");
  expect(board).toContain("const agent = useBoardAgent().run;");
  expect(board).not.toContain("usePlanRun");
  expect(board).toMatch(/masters: rig\.masters, extra, agent, sample, now/);
  /* The poll stays for the phone's Plan screen, which has no board, and AGENT_CHANGED stays the plan card's event. */
  expect(read("components/graphite/phone/PlanScreen.tsx")).toContain("usePlanRun");
  expect(read("components/graphite/board/cards/plan/use-plan.ts")).toContain("AGENT_CHANGED");
});

test("seam f: the control room reads Settings' section ids from lib/shell/settings.ts, and the spending rules from stream 9's hook", () => {
  const approvals = read("components/graphite/control-room/ApprovalsView.tsx");
  expect(approvals).toContain('import type { SettingsSectionId } from "@/lib/shell/settings";');
  expect(approvals).not.toContain("WorkspaceTabId");
  expect(approvals).toContain("useSpendingRules");
  expect(read("components/graphite/settings/rules/spending.ts")).not.toContain("LOCAL STUB");
});

test("every stream that has a built screen has landed it: Home, the board, Ads, Social, Make, Atomik, the control room, Settings and the phone", async () => {
  const { SCREENS, isLanded } = await import("../../lib/shell/screens");
  for (const screen of SCREENS) expect(isLanded(screen.id), screen.id).toBe(true);
});

test("seam i: Make sits left of the board's dock by the one variable the shell sets (--board-dock), never a name nobody sets", () => {
  const make = read("components/graphite/make.css");
  expect(make).toContain(".gx .gx-make.gx-mk { right: var(--board-dock, 0px); }");
  expect(make).not.toContain("--gx-dock-right");
  expect(read("components/graphite/SuitesShell.tsx")).toContain('"--board-dock": `${shell.dockRight}px`');
});

test("seam g: Make tells the Rig its draft was written before it tells the board which card to light", () => {
  const make = read("components/graphite/make/use-make.ts");
  const at = make.indexOf("announceDraftWritten(made.projectId);");
  expect(at).toBeGreaterThan(0);
  expect(at).toBeLessThan(make.indexOf("announceMade({ projectId: made.projectId"));
});

test("seam j: on a phone, `view=home` is Home even with the page the shell writes beside it (suite=particl&page=brief), and the board's addresses are the Record", async () => {
  const { readPhone } = await import("../../components/graphite/phone/phone-model");
  for (const search of ["?view=home", "?project=p1&suite=particl&page=brief&view=home", "?project=p1&suite=particl&page=brief&view=home&device=phone"]) {
    expect(readPhone(search).screen, search).toBe("home");
  }
  for (const search of ["?view=board", "?project=p1&suite=particl&page=rig", "?project=p1&suite=particl&page=brief"]) {
    expect(readPhone(search).screen, search).toBe("record");
  }
  expect(readPhone("?suite=particl&page=brief&sp=stages").screen).toBe("home");
});
