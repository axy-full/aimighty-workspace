import { test, expect } from "@playwright/test";
import { newInterfaceOn } from "../../lib/newInterface";
import { HOUSE_WORKSPACE_ID } from "../../lib/houseWorkspace";
import { DEFAULT_SITE, cleanSite, sitePatch } from "../../lib/site/settings";

/* The redesign switch (lib/newInterface.ts): on for every workspace (the owner's decision of 11 October 2026, which replaces "off for
   every customer workspace, on for the house workspace and the ones the owner lists"), except the workspaces the platform owner lists
   as off (`newInterfaceOff`: the owner's no-deploy way back). A signed-in person always has a workspace, so the only other "off" is none. */

test("the new interface is on for every workspace, off for the ones listed off, and off with none", () => {
  expect(newInterfaceOn(null)).toBe(false);
  expect(newInterfaceOn(undefined)).toBe(false);
  expect(newInterfaceOn({ id: "ws_customer" })).toBe(true);
  expect(newInterfaceOn({ id: "ws_customer" }, DEFAULT_SITE.newInterfaceOff)).toBe(true);
  expect(newInterfaceOn({ id: HOUSE_WORKSPACE_ID })).toBe(true);
  expect(newInterfaceOn({ id: "ws_listed" }, ["ws_listed"])).toBe(false);
  expect(newInterfaceOn({ id: "ws_other" }, ["ws_listed"])).toBe(true);
  expect(newInterfaceOn(null, ["ws_listed"])).toBe(false);
});

test("the off list is empty by default, cleaned when read and checked when changed", () => {
  expect(DEFAULT_SITE.newInterfaceOff).toEqual([]);
  expect(cleanSite({ newInterfaceOff: "ws_a" }).newInterfaceOff).toEqual([]);
  expect(cleanSite({ newInterfaceOff: ["ws_a", "ws_a", 3, "bad id; drop", "ws_b"] }).newInterfaceOff).toEqual(["ws_a", "ws_b"]);
  expect(cleanSite({ newInterfaceOff: Array.from({ length: 80 }, (_, i) => `ws_${i}`) }).newInterfaceOff).toHaveLength(50);
  expect(sitePatch({ newInterfaceOff: ["ws_a", "ws_a"] })).toEqual({ patch: { newInterfaceOff: ["ws_a"] } });
  expect(sitePatch({ newInterfaceOff: [] })).toEqual({ patch: { newInterfaceOff: [] } });
  expect(sitePatch({ newInterfaceOff: "ws_a" })).toHaveProperty("error");
  expect(sitePatch({ newInterfaceOff: ["bad id; drop"] })).toHaveProperty("error");
  expect(sitePatch({ newInterfaceOff: Array.from({ length: 51 }, (_, i) => `ws_${i}`) })).toHaveProperty("error");
  /* The old list ("on for") is not a setting any more. */
  expect(sitePatch({ newInterfaceWorkspaces: ["ws_a"] })).toHaveProperty("error");
});
