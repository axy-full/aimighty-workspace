import { test, expect } from "@playwright/test";
import {
  ASSET_PARAM, assetLinkHref, assetParam, linkWorkspace, readAssetLink, selectHistory, selectedTakeParam, stillCurrent, withAsset, withoutLink,
} from "../../lib/shell/asset-link";
import { validAssetId } from "../../lib/preview";
import { INITIAL_STATE, applyUrl, fromSearch, toSearch } from "../../lib/workspace/navigation";

/* Idea 26: a take in the address bar and in a copied link. Pure — the browser specs drive the same functions through the shell. */

test("an asset id is a Library id with a plain id: anything else is ignored, never looked up", () => {
  for (const good of ["generation:gen_1", "upload:up-2", "generation:" + "a".repeat(160)]) expect(validAssetId(good), good).toBe(good);
  for (const bad of ["", "generation:", "upload:", "take:gen_1", "gen_1", "generation:../x", "generation:a/b", "generation:a b", "generation:a%2Fb",
    "generation:" + "a".repeat(161), "GENERATION:gen_1", " generation:gen_1", "generation:gen_1\n", "generation:gen:1", null, undefined, 42, { id: "generation:x" }])
    expect(validAssetId(bad), String(bad)).toBeNull();
  expect(assetParam("?asset=generation%3Agen_1")).toBe("generation:gen_1");
  expect(assetParam("?asset=generation:gen_1&asset=generation:gen_2"), "two takes name none").toBeNull();
  expect(assetParam("?asset=generation:..%2Fetc")).toBeNull();
  expect(assetParam("?asset=javascript:alert(1)")).toBeNull();
});

test("the older sel=take:<id> still selects a take; an asset wins over a sel that disagrees", () => {
  expect(selectedTakeParam("?sel=take:generation:gen_1")).toBe("generation:gen_1");
  expect(selectedTakeParam("?sel=take:upload:up_1&asset=generation:gen_2")).toBe("generation:gen_2");
  expect(selectedTakeParam("?sel=take:not-a-library-id")).toBeNull();
  expect(selectedTakeParam("?sel=shot:s1")).toBeNull();
  /* The state layer reads it the same way, and writes sel back for the one selection. */
  const both = fromSearch("?project=p1&page=takes&sel=take:upload:up_1&asset=generation:gen_2");
  expect(both.sel).toEqual({ kind: "take", id: "generation:gen_2" });
  const state = applyUrl(INITIAL_STATE, both);
  expect([state.selKind, state.selId]).toEqual(["take", "generation:gen_2"]);
  expect(new URLSearchParams(toSearch(state)).get("sel")).toBe("take:generation:gen_2");
  /* A malformed take in sel is dropped; shots and cast are read as before. */
  expect(fromSearch("?page=takes&sel=take:bad id").sel).toBeNull();
  expect(fromSearch("?page=rig&sel=shot:a:b").sel).toEqual({ kind: "shot", id: "a:b" });
  expect(fromSearch("?page=rig&sel=take:generation:g1").sel).toEqual({ kind: "take", id: "generation:g1" });
});

test("a link with a take and no page opens Takes with that take selected", () => {
  const url = fromSearch("?sp=takes&asset=generation:gen_9");
  expect([url.view, url.page, url.suite]).toEqual(["studio", "takes", "particl"]);
  const state = applyUrl(INITIAL_STATE, url);
  expect([state.page, state.selKind, state.selId]).toEqual(["takes", "take", "generation:gen_9"]);
  /* Not a take: no page is implied. */
  expect(fromSearch("?asset=nope").view).toBe("home");
});

test("Back to an entry that names no take leaves the take; a shot a URL leaves out is kept for its list to repair", () => {
  const open = applyUrl(INITIAL_STATE, fromSearch("?project=p1&page=takes&sel=take:generation:gen_1&asset=generation:gen_1"));
  expect(open.selId).toBe("generation:gen_1");
  const grid = applyUrl(open, fromSearch("?project=p1&page=takes"));
  expect([grid.selKind, grid.selId]).toEqual(["take", null]);
  const forward = applyUrl(grid, fromSearch("?project=p1&page=takes&asset=generation:gen_1"));
  expect(forward.selId).toBe("generation:gen_1");
  const rig = applyUrl({ ...INITIAL_STATE, view: "studio", page: "rig", selKind: "shot", selId: "s2" }, fromSearch("?project=p1&page=rig"));
  expect([rig.selKind, rig.selId]).toEqual(["shot", "s2"]);
});

test("setting and clearing the take keeps every other param, in its place", () => {
  const search = "?project=p1&suite=particl&page=takes&sel=take%3Ageneration%3Ag1&view=gen&sp=takes&cp=room&room=r1&level=page&x=1";
  const set = withAsset(search, "generation:g2");
  const q = new URLSearchParams(set);
  expect(q.get(ASSET_PARAM)).toBe("generation:g2");
  for (const key of ["project", "suite", "page", "sel", "view", "sp", "cp", "room", "level", "x"]) expect(q.get(key), key).toBe(new URLSearchParams(search).get(key));
  expect(new URLSearchParams(withAsset(set, null)).has(ASSET_PARAM)).toBe(false);
  expect(new URLSearchParams(withAsset(set, "generation:../x")).has(ASSET_PARAM), "a bad id clears, never writes").toBe(false);
  expect(withAsset("", null)).toBe("");
  /* A resolved link sheds its own params and keeps the take; a dismissed one sheds the take too, sel=take included. */
  const link = "?page=takes&sp=takes&ws=w1&production=p9&asset=generation%3Ag1&sel=take%3Ageneration%3Ag1&project=d1";
  expect(Object.fromEntries(new URLSearchParams(withoutLink(link)))).toEqual({ page: "takes", sp: "takes", asset: "generation:g1", sel: "take:generation:g1", project: "d1" });
  expect(Object.fromEntries(new URLSearchParams(withoutLink(link, true)))).toEqual({ page: "takes", sp: "takes", project: "d1" });
  expect(new URLSearchParams(withoutLink("?sel=shot%3As1&asset=generation%3Ag1", true)).get("sel"), "a shot selection is not the link's").toBe("shot:s1");
});

test("opening and leaving a take are history entries; stepping, a link and a repair rewrite the one they are on", () => {
  expect(selectHistory("open")).toBe("push");
  expect(selectHistory("close")).toBe("push");
  expect(selectHistory("step")).toBe("replace");
  expect(selectHistory("link")).toBe("replace");
  expect(selectHistory("repair")).toBe("replace");
});

test("a copied link carries the workspace, the production and the take, and never a draft", () => {
  const href = assetLinkHref({ origin: "https://studio.example/", workspace: "ws_1", production: "prj_wb_abc", asset: "generation:gen_1" })!;
  const url = new URL(href);
  expect(url.pathname).toBe("/suites");
  expect(Object.fromEntries(url.searchParams)).toEqual({ page: "takes", sp: "takes", ws: "ws_1", production: "prj_wb_abc", asset: "generation:gen_1" });
  expect(url.searchParams.has("project")).toBe(false);
  expect(readAssetLink(url.search)).toEqual({ asset: "generation:gen_1", workspace: "ws_1", production: "prj_wb_abc", project: null, broken: false });
  /* Nothing to link: no production (an unsaved project), no workspace, or not a take. */
  expect(assetLinkHref({ origin: "https://s", workspace: "ws_1", production: null, asset: "generation:g" })).toBeNull();
  expect(assetLinkHref({ origin: "https://s", workspace: null, production: "p", asset: "generation:g" })).toBeNull();
  expect(assetLinkHref({ origin: "https://s", workspace: "ws_1", production: "p", asset: "take:g" })).toBeNull();
  expect(assetLinkHref({ origin: "https://s", workspace: "ws 1", production: "p", asset: "generation:g" })).toBeNull();
});

test("a link reads its parts strictly: a malformed workspace or production breaks it rather than being ignored", () => {
  expect(readAssetLink("?page=takes")).toBeNull();
  expect(readAssetLink("?asset=generation:g1&project=d1")).toEqual({ asset: "generation:g1", workspace: null, production: null, project: "d1", broken: false });
  expect(readAssetLink("?asset=generation:g1&ws=a%2Fb")!.broken).toBe(true);
  expect(readAssetLink("?asset=generation:g1&ws=w1&ws=w2")!.broken).toBe(true);
  expect(readAssetLink("?asset=generation:g1&production=")!.broken).toBe(true);
  expect(readAssetLink("?asset=generation:g1&production=" + "p".repeat(101))!.broken).toBe(true);
});

test("a link opens only in its own workspace: another of this account's offers a switch, one it is not in offers nothing", () => {
  const memberOf = [{ id: "ws_a" }, { id: "ws_b" }];
  expect(linkWorkspace({ workspace: "ws_a" }, "ws_a", memberOf)).toBe("here");
  expect(linkWorkspace({ workspace: null }, "ws_a", memberOf), "an address-bar URL resolves in the active workspace's own reads").toBe("here");
  expect(linkWorkspace({ workspace: "ws_b" }, "ws_a", memberOf)).toBe("switch");
  expect(linkWorkspace({ workspace: "ws_z" }, "ws_a", memberOf)).toBe("elsewhere");
  expect(linkWorkspace({ workspace: "ws_z" }, null, [])).toBe("elsewhere");
});

test("a late answer for another scope or project is not the current one", () => {
  const captured = { scope: "particl-active-w1-u1", projectId: "d1" };
  expect(stillCurrent(captured, { ...captured })).toBe(true);
  expect(stillCurrent(captured, { scope: captured.scope, projectId: "d2" })).toBe(false);
  expect(stillCurrent(captured, { scope: "particl-active-w2-u1", projectId: "d1" })).toBe(false);
  expect(stillCurrent(captured, { scope: captured.scope, projectId: null })).toBe(false);
});
