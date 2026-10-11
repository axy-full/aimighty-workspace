import { test, expect } from "@playwright/test";
import { OLD_TO_NEW, PENDING, shellPage, SHELL_SUITES } from "../../lib/shell/ia";
import { route, sameSearch, screenAt } from "../../lib/shell/screens";
import { STAGE_REDIRECTS, STAGE_ROWS, isStageId, stageAddress, stagePlace, type StageId } from "../../lib/shell/stage-redirects";
import { STUDIO_RAIL } from "../../lib/board/regions";

/**
 * The ten Studio stage pages are deleted (owner, 5 Oct night: the canvas is the whole production). Every address that named one
 * opens the board, on the region that took its job, for every workspace: the switch on or off. Pure, over the real registry.
 */
const TEN: StageId[] = ["brief", "beats", "boards", "environment", "cast", "astra", "rig", "takes", "edit", "deliver"];
const params = (search: string) => Object.fromEntries(new URLSearchParams(search));

test("the table names exactly the ten stages, each once, and every target is a board address on a region the board has", () => {
  expect(STAGE_REDIRECTS.map((s) => s.id)).toEqual(TEN);
  expect(new Set(STAGE_REDIRECTS.map((s) => s.from)).size).toBe(10);
  const regions = new Set(STUDIO_RAIL.map((r) => r.id as string));
  for (const stage of STAGE_REDIRECTS) {
    const to = params(stage.to);
    expect(to.view, stage.id).toBe("board");
    if (to.region) expect(regions.has(to.region), `${stage.id} → ${to.region}`).toBe(true);
    expect(stagePlace(stage.id)).toBeTruthy();
    expect(stageAddress(stage.id)).toBe(stage.to);
  }
  expect(isStageId("rig")).toBe(true);
  expect(isStageId("stages")).toBe(false);
  expect(isStageId("home")).toBe(false);
  expect(isStageId("__proto__")).toBe(false);
  expect(isStageId(null)).toBe(false);
});

test("the redirect table, row by row: the app's address opens its region with the switch on or off, and keeps what matters", () => {
  const expected: Record<StageId, string> = {
    brief: "?view=board&region=brief", beats: "?view=board&region=storyboard", boards: "?view=board&region=storyboard",
    environment: "?view=board&region=cast", cast: "?view=board&region=cast", astra: "?view=board&region=shots", rig: "?view=board",
    takes: "?view=board&region=shots", edit: "?view=board&region=cut", deliver: "?view=board&region=deliver",
  };
  for (const stage of STAGE_REDIRECTS) {
    expect(stage.to, stage.id).toBe(expected[stage.id]);
    for (const on of [false, true]) {
      expect(sameSearch(route(stage.from), stage.to), `${stage.id} (switch ${on ? "on" : "off"})`).toBe(true);
      /* The project, a selected take, Make and Atomik's panel ride along; the shell's own `sp` for the page leaves with it. */
      const kept = route(`${stage.from}&sp=${stage.id}&project=ws-9&asset=generation:g1&make=image&atomik=1`);
      expect(params(kept), `${stage.id} keeps its project`).toMatchObject({ view: "board", project: "ws-9", asset: "generation:g1", make: "image", atomik: "1" });
      expect(params(kept).page, stage.id).toBeUndefined();
      expect(params(kept).suite, stage.id).toBeUndefined();
      expect(screenAt(route(stage.from)), stage.id).toBe("board");
    }
  }
  /* The two sub-views with a board form of their own. */
  expect(sameSearch(route("?suite=particl&page=rig&rig=list"), "?view=board&list=1")).toBe(true);
  expect(sameSearch(route("?suite=particl&page=brief&sp=beats&beats=graph"), "?view=board")).toBe(true);
  expect(STAGE_ROWS).toHaveLength(24);
});

test("a copied take link never named its suite, and still opens the board's Shots region with the take", () => {
  /* Links teammates copied before the Takes page was deleted: `?page=takes&sp=takes&ws=…&production=…&asset=…`. */
  for (const on of [false, true]) {
    const out = params(route("?page=takes&sp=takes&ws=ws_1&production=prj_9&asset=generation%3Agen_1"));
    expect(out, `switch ${on ? "on" : "off"}`).toEqual({ view: "board", region: "shots", ws: "ws_1", production: "prj_9", asset: "generation:gen_1" });
  }
  /* The same without a suite for every stage; `suite` leaves with the page when it is named. */
  for (const stage of STAGE_REDIRECTS) {
    const bare = stage.from.replace("?suite=particl&", "?");
    expect(sameSearch(route(`${bare}&project=p1`), `${stage.to}&project=p1`), stage.id).toBe(true);
  }
  expect(params(route("?suite=particl&page=takes&sp=takes")).suite).toBeUndefined();
  /* A page of another suite is not a stage: Atomik's Agent is `page=agent` (its panel over Home), Business's is `page=marketing`. */
  expect(params(route("?page=agent&sp=agent"))).toEqual({ atomik: "1", view: "home" });
  expect(params(route("?suite=moleculr&page=marketing&sp=hooks")).view).toBe("board");
});

test("the design file's spellings of the stages open the same regions", () => {
  const spellings: [string, string][] = [
    ["?suite=studio&page=brief", "?view=board&region=brief"], ["?suite=studio&page=beats", "?view=board&region=storyboard"],
    ["?suite=studio&page=boards", "?view=board&region=storyboard"], ["?suite=studio&page=env", "?view=board&region=cast"],
    ["?suite=studio&page=environment", "?view=board&region=cast"], ["?suite=studio&page=cast", "?view=board&region=cast"],
    ["?suite=studio&page=astra", "?view=board&region=shots"], ["?suite=studio&page=rig", "?view=board"],
    ["?suite=studio&page=takes", "?view=board&region=shots"], ["?suite=studio&page=edit", "?view=board&region=cut"],
    ["?suite=studio&page=deliver", "?view=board&region=deliver"], ["?suite=studio&page=rig&rig=list", "?view=board&list=1"],
    ["?suite=studio&page=beats&beats=graph", "?view=board"],
  ];
  for (const [from, to] of spellings) for (const on of [false, true]) expect(sameSearch(route(`${from}&project=p1`), `${to}&project=p1`), `${from} (${on})`).toBe(true);
});

test("every old Studio address the README, the redirect rows or the pending list ever named lands on the board, never on a page", () => {
  const old = [...OLD_TO_NEW.map((r) => r.from), ...PENDING.map((p) => p.from)].filter((from) => from.startsWith("?") && /suite=(studio|particl)/.test(from) && !/sp=(stages|home)/.test(from) && !/page=(stages|home)/.test(from));
  expect(old.length).toBeGreaterThanOrEqual(10);
  for (const from of old) for (const on of [false, true]) {
    const out = route(from);
    expect(params(out).view, `${from} (${on}) → ${out}`).toBe("board");
    expect(params(out).page, from).toBeUndefined();
  }
});

test("the board's own address is left alone, even with the state layer's suite and page beside it", () => {
  /* The shell's state layer writes `suite` and `page` on every landing: they are not a second place to go. */
  for (const on of [false, true]) {
    expect(sameSearch(route("?view=board&region=cut&suite=particl&page=brief&project=p1"), "?view=board&region=cut&suite=particl&page=brief&project=p1")).toBe(true);
    expect(params(route("?view=board&suite=particl&page=rig")).region).toBeUndefined();
  }
  expect(params(route("?view=workspace&tab=team&suite=particl&page=brief")).view).toBe("workspace");
  expect(params(route("?view=home&suite=particl&page=brief")).view).toBe("home");
});

test("Studio has no stage pages left: the ten ids are not pages, and Studio keeps one backing page that nothing draws", () => {
  for (const id of TEN) expect(shellPage("studio", id), id).toBeNull();
  expect(SHELL_SUITES.find((suite) => suite.id === "studio")!.pages.map((page) => [page.id, page.phoneOnly])).toEqual([["board", true]]);
  /* The stages' labels (Home's shortcuts, a toast's Open) carry no retired name. */
  for (const stage of STAGE_REDIRECTS) expect(stage.label, "no retired name on a stage").not.toMatch(/\b(Rig|Astra)\b/);
});
