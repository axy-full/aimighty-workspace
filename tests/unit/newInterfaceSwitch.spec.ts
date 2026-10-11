import { test, expect } from "@playwright/test";
import { newInterfaceOn } from "../../lib/newInterface";
import { HOUSE_WORKSPACE_ID } from "../../lib/houseWorkspace";
import { DEFAULT_SITE, cleanSite, sitePatch } from "../../lib/site/settings";

/* The redesign switch (lib/newInterface.ts): off for every customer workspace, on for the house workspace and for
   workspaces the platform owner lists. */

test("the new interface is on for the house workspace and listed workspaces only", () => {
  expect(newInterfaceOn(null)).toBe(false);
  expect(newInterfaceOn({ id: "ws_customer" })).toBe(false);
  expect(newInterfaceOn({ id: "ws_customer" }, DEFAULT_SITE.newInterfaceWorkspaces)).toBe(false);
  expect(newInterfaceOn({ id: HOUSE_WORKSPACE_ID })).toBe(true);
  expect(newInterfaceOn({ id: "ws_listed" }, ["ws_listed"])).toBe(true);
  expect(newInterfaceOn({ id: "ws_other" }, ["ws_listed"])).toBe(false);
});

test("the list is empty by default, cleaned when read and checked when changed", () => {
  expect(DEFAULT_SITE.newInterfaceWorkspaces).toEqual([]);
  expect(cleanSite({ newInterfaceWorkspaces: "ws_a" }).newInterfaceWorkspaces).toEqual([]);
  expect(cleanSite({ newInterfaceWorkspaces: ["ws_a", "ws_a", 3, "bad id; drop", "ws_b"] }).newInterfaceWorkspaces).toEqual(["ws_a", "ws_b"]);
  expect(cleanSite({ newInterfaceWorkspaces: Array.from({ length: 80 }, (_, i) => `ws_${i}`) }).newInterfaceWorkspaces).toHaveLength(50);
  expect(sitePatch({ newInterfaceWorkspaces: ["ws_a", "ws_a"] })).toEqual({ patch: { newInterfaceWorkspaces: ["ws_a"] } });
  expect(sitePatch({ newInterfaceWorkspaces: [] })).toEqual({ patch: { newInterfaceWorkspaces: [] } });
  expect(sitePatch({ newInterfaceWorkspaces: "ws_a" })).toHaveProperty("error");
  expect(sitePatch({ newInterfaceWorkspaces: ["bad id; drop"] })).toHaveProperty("error");
  expect(sitePatch({ newInterfaceWorkspaces: Array.from({ length: 51 }, (_, i) => `ws_${i}`) })).toHaveProperty("error");
});
