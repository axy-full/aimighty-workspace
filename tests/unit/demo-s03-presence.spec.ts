import { test, expect } from "@playwright/test";
import { whoIsHere } from "../../lib/board/presence";
import type { RoomPeer } from "../../lib/workbench/team-canvas-model";

/* Stream 3 · live presence on the board: who is here. (Cursors need a live room, which no local run has.) */
let next = 0;
const peer = (name: string, extra: Partial<RoomPeer> = {}): RoomPeer => ({ id: ++next, name, color: "#0A84FF", cursor: null, selected: null, drag: null, ...extra });

test("the who's-here row names the people on the board, and Atomik first while it works", () => {
  const here = whoIsHere([peer("Rowan Field"), peer("Sky Park"), peer("Atomik", { agent: true, doing: "building the shots" })])!;
  expect(here.label).toBe("On this board: Rowan Field, Sky Park, Atomik");
  expect(here.faces.map((f) => [f.initials, f.agent])).toEqual([["AT", true], ["RF", false], ["SP", false]]);
  expect(here.faces[0].title).toBe("Atomik · building the shots");
  expect(here.more).toBeNull();
  expect(whoIsHere([])).toBeNull();
});

test("more than five people collapse into a count", () => {
  const here = whoIsHere(Array.from({ length: 7 }, (_, i) => peer(`Person ${String.fromCharCode(65 + i)}`)))!;
  expect(here.faces).toHaveLength(5);
  expect(here.more).toEqual({ count: 2, title: "2 more" });
});
