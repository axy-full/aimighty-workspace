import { test, expect } from "@playwright/test";
import { rigLoadState } from "../../lib/workspace/rig-load-state";

/* What the Rig's list, graph and Inspector show before the shots are in. */

test("with no project open the Rig asks for one, and never says it is loading", () => {
  /* The provider reports "idle" when no project is open: that is not loading. */
  expect(rigLoadState({ status: "idle", hasProject: false, projectId: null })).toBe("no-project");
});

test("with a project named and its load not finished, the Rig is loading", () => {
  /* "idle" with a project: the first render, before the load starts. */
  for (const status of ["idle", "loading"] as const)
    expect(rigLoadState({ status, hasProject: false, projectId: "p1" })).toBe("loading");
});

test("a finished load with no draft asks for a project instead of loading for good", () => {
  /* A shared link to a draft this person cannot open, with no project of their own to fall back to:
     GET /api/workbench/projects?id= answers project: null and the provider settles on "ready". */
  expect(rigLoadState({ status: "ready", hasProject: false, projectId: "someone-elses-draft" })).toBe("no-project");
});

test("a failed load is the error, and the draft in hand is ready", () => {
  expect(rigLoadState({ status: "error", hasProject: false, projectId: "p1" })).toBe("error");
  expect(rigLoadState({ status: "ready", hasProject: true, projectId: "p1" })).toBe("ready");
});
