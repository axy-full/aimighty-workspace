import { test, expect } from "@playwright/test";
import {
  INITIAL_STATE, applyUrl, fromSearch, generateAvailability, go, switchSuite, toSearch, withLibFilter, withLists,
} from "../../lib/workspace/navigation";
import type { AppState, SelectableItem } from "../../lib/workspace/types";

const shots: SelectableItem[] = [{ id: "s1", name: "Wide", status: "approved" }, { id: "s2", name: "Close", status: "ready" }];
const takes: SelectableItem[] = [
  { id: "t1", name: "Wide v1", kind: "generation" },
  { id: "u1", name: "Plate", kind: "upload" },
];
const cast: SelectableItem[] = [{ id: "c1", name: "Lead", group: "cast" }];
const loaded = (over: Partial<AppState> = {}): AppState => ({ ...INITIAL_STATE, lists: { shots, takes, cast }, ...over });

test("arriving at Rig from Takes repairs the selection to a shot", () => {
  const onTakes = go(loaded(), "particl", "takes");
  expect([onTakes.selKind, onTakes.selId]).toEqual(["take", "t1"]);
  const onRig = go(onTakes, "particl", "rig");
  expect([onRig.view, onRig.page, onRig.selKind, onRig.selId]).toEqual(["studio", "rig", "shot", "s1"]);
  expect(generateAvailability(onRig, true)).toEqual({ enabled: true, reason: null });
});

test("a valid selection survives; a stale one falls back to the first item", () => {
  const onRig = go(loaded({ selKind: "shot", selId: "s2" }), "particl", "rig");
  expect(onRig.selId).toBe("s2");
  expect(go(loaded({ selKind: "shot", selId: "gone" }), "particl", "rig").selId).toBe("s1");
  expect(go(loaded({ selKind: "take", selId: "t1" }), "particl", "cast").selId).toBe("c1");
  const page = go(loaded({ selKind: "shot", selId: "s2" }), "particl", "brief");
  expect([page.selKind, page.inspTab]).toEqual(["page", "Controls"]);
});

test("empty lists clear the selection and Generate says why", () => {
  const empty = go({ ...INITIAL_STATE, selKind: "take", selId: "t1", lists: { shots: [], takes: [], cast: [] } }, "particl", "rig");
  expect([empty.selKind, empty.selId]).toEqual(["shot", null]);
  expect(generateAvailability(empty, true)).toEqual({ enabled: false, reason: "Add a shot before generating." });
  expect(go(empty, "particl", "takes").selId).toBeNull();
  expect(go(empty, "particl", "cast").selId).toBeNull();
});

test("lists not loaded: keep a same-kind selection, drop a foreign one, repair on arrival", () => {
  const fromUrl = applyUrl(INITIAL_STATE, fromSearch("?suite=particl&page=rig&sel=shot:s2"));
  expect([fromUrl.selKind, fromUrl.selId]).toEqual(["shot", "s2"]);
  expect(generateAvailability(fromUrl, false).reason).toBe("Generation is not connected to this view yet.");
  const foreign = go({ ...INITIAL_STATE, selKind: "take", selId: "t1" }, "particl", "rig");
  expect(foreign.selId).toBeNull();
  expect(generateAvailability(foreign, true)).toEqual({ enabled: false, reason: "Select a shot to generate." });
  const arrived = withLists(foreign, { shots });
  expect(arrived.selId).toBe("s1");
  expect(withLists(fromUrl, { shots: [{ id: "s9", name: "Other" }] }).selId).toBe("s9");
  expect(withLists(fromUrl, { shots: [] }).selId).toBeNull();
});

test("the Takes filter repairs selection against the visible list", () => {
  const onTakes = go(loaded({ selKind: "take", selId: "t1" }), "particl", "takes");
  const uploads = withLibFilter(onTakes, "Uploads");
  expect(uploads.selId).toBe("u1");
  expect(withLibFilter(onTakes, "Generations").selId).toBe("t1");
});

test("unknown and aliased pages; suite switching", () => {
  expect(go(INITIAL_STATE, "particl", "nope").page).toBe("brief");
  expect(go(INITIAL_STATE, "particl", "canvas").page).toBe("rig");
  expect(go(INITIAL_STATE, "particl", "agent").page).toBe("brief");
  const atomik = switchSuite(go(INITIAL_STATE, "particl", "rig"), "atomik");
  expect([atomik.view, atomik.suite, atomik.page]).toEqual(["studio", "atomik", "agent"]);
  const home = switchSuite(INITIAL_STATE, "subatomik");
  expect([home.view, home.suite, home.page]).toEqual(["home", "subatomik", "motion"]);
});

test("URL round trip, aliases and the home view", () => {
  const state = go(loaded({ projectId: "draft-1", selKind: "shot", selId: "s2" }), "particl", "rig");
  const search = toSearch(state);
  expect(search).toBe("?project=draft-1&suite=particl&page=rig&sel=shot%3As2");
  const back = applyUrl(loaded(), fromSearch(search));
  expect([back.projectId, back.suite, back.page, back.view, back.selKind, back.selId]).toEqual(["draft-1", "particl", "rig", "studio", "shot", "s2"]);
  expect(toSearch({ ...state, view: "home" })).toBe("?project=draft-1&suite=particl");
  expect(fromSearch("?suite=atomik")).toMatchObject({ view: "home", suite: "atomik", page: "agent", sel: null });
  expect(fromSearch("?page=motion-transfer")).toMatchObject({ view: "studio", suite: "subatomik", page: "motion" });
  /* The page is the more specific claim. */
  expect(fromSearch("?suite=atomik&page=storyboard")).toMatchObject({ suite: "particl", page: "boards" });
  expect(fromSearch("?suite=subatomic&page=")).toMatchObject({ suite: "subatomik", page: "motion", view: "studio" });
  expect(fromSearch("?page=rig&sel=bogus")).toMatchObject({ sel: null });
  expect(fromSearch("?page=rig&sel=shot:a:b")).toMatchObject({ sel: { kind: "shot", id: "a:b" } });
  const pageSel = go(loaded({ selKind: "shot", selId: "s1" }), "particl", "brief");
  expect(toSearch(pageSel)).not.toContain("sel=");
});
