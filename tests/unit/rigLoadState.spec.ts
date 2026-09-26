import { test, expect } from "@playwright/test";
import { rigLoadState } from "../../lib/workspace/rig-load-state";

/* What the Rig's list, graph and Inspector show before the shots are in. */

test("with no project open the Rig asks for one, and never says it is loading", () => {
  /* The provider reports "idle" when no project is open: that is not loading. */
  expect(rigLoadState({ status: "idle", hasProject: false, projectId: null })).toBe("no-project");
});

test("with a project open and its draft not in yet, the Rig is loading, whatever the provider has reached", () => {
  for (const status of ["idle", "loading", "ready"] as const)
    expect(rigLoadState({ status, hasProject: false, projectId: "p1" })).toBe("loading");
});

test("a failed load is the error, and the draft in hand is ready", () => {
  expect(rigLoadState({ status: "error", hasProject: false, projectId: "p1" })).toBe("error");
  expect(rigLoadState({ status: "ready", hasProject: true, projectId: "p1" })).toBe("ready");
});
