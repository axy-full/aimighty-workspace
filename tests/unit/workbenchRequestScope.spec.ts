import * as zlib from "node:zlib";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { newProject } from "../../lib/workbench/studio";
import { saveSchema } from "../../lib/workbench/studio-schema";
import * as requestBody from "../../lib/workbench/request-body";
import * as requestScope from "../../lib/workbench/request-scope";
import * as requestOrigin from "../../lib/requestOrigin";
import * as saveProblem from "../../lib/workbench/save-problem";
import { viewOnlyRefusal } from "../../lib/workbench/view-only";

/** Execute the real route with storage spies: a rejected tab must not reach data. */
function route() {
  const calls: string[] = [];
  const record = (name: string, value: unknown) => async () => {
    calls.push(name);
    return value;
  };
  const draft = newProject("Private production");
  const mocks: Record<string, unknown> = {
    "@/lib/workbench/request-body": requestBody,
    /* The list of private boards is tests/unit/privateCanvas.spec.ts's; this spec is about what a refused save touches. */
    "@/lib/draftProject": { projectLister: async () => () => true, isSampleDraft: async () => false, DRAFT_PROJECT_PREFIX: "prj_wb_", mappedId: (prefix: string, ...parts: string[]) => prefix + parts.join(":") },
    "@/lib/demo/readonly.server": { sampleDraftRefusal: async () => null },
    "@/lib/requestOrigin": requestOrigin,
    "@/lib/auth": {
      withTenant: (handler: unknown) => handler,
      requireSession: async () => ({
        user: { id: "new-account", name: "New account" },
      }),
    },
    "@/lib/tenant": { requireTenant: () => ({ id: "current-workspace" }) },
    "@/lib/workbench/request-scope": requestScope,
    /* Who published the shared copy, as the workspace may read it: unchanged here (tests/unit/platformOwnerPrivacy.spec.ts). */
    "@/lib/platformOwnerPrivacy": { storedActorMaskHere: async () => (value: unknown) => value },
    "@/lib/db": { db: () => ({ execute: record("query", { rows: [] }) }) },
    "@/lib/workbench/studio-schema": { saveSchema },
    "@/lib/workbench/save-problem": saveProblem,
    "@/lib/workbench/studio": { newProject },
    /* Real: a large project answer leaves gzipped. */
    "node:zlib": zlib,
    "@/lib/workbench/records": {
      workbenchReady: record("ready", undefined),
      readDraft: record("read", { project: draft, revision: 1 }),
      saveDraft: record("save", { revision: 1 }),
      mapNodeShot: record("map", "shot"),
      publishBible: record("publish", { version: 1 }),
    },
    /* Teammates' boards (lib/workbench/team-boards.ts, tests/unit/teamBoards.spec.ts): none is involved here, so no board is another person's. */
    "@/lib/workbench/board-default": { defaultSharing: async () => ({ teamShared: false, teamEdit: false }) },
    "@/lib/workbench/room-rotation": { rotateRoom: async () => ({ from: "", to: "" }) },
    "@/lib/workbench/team-boards": { findTeamBoard: async () => null, listTeamBoards: async () => [], otherOwnersBoard: async () => null, boardKeyFor: async (_ws: unknown, actor: { id: string }) => ({ owner: actor.id }), AMBIGUOUS_BOARD: "ambiguous", maySetSharing: () => true, mayWriteBoard: async () => false, openingOf: async () => ({ viewOnly: { owner: { id: "x", name: "x" } } }), readTeamBoard: async () => null, viewOnlyRefusal },
    /* Studio's first run: seeding the starter production writes to the workspace, so it is gated like a save. */
    "@/lib/workbench/starter-draft": {
      openStarterDraft: record("starter", { project: draft, revision: 1, created: true, seeded: true }),
      StarterUnavailableError: class StarterUnavailableError extends Error {},
    },
  };
  /* Board sharing, PR 4. The route reads a person's own drafts through the one rule for "the drafts this person owns now" (lib/draftProject.ts ownedDraftsSql, lib/workbench/records.ts
     readOwnDraft) and hands boards over through lib/workbench/board-transfer.ts; the rule itself is tests/unit/boardTransferSurfaces.spec.ts's, the transfer's tests/unit/boardTransfer*.spec.ts.
     Here, as for readDraft above, only the signed-in person's own draft exists, and a transfer is recorded as a call. */
  (mocks["@/lib/draftProject"] as Record<string, unknown>).ownedDraftsSql = () => ({ sql: "1 = 1", args: [] });
  (mocks["@/lib/workbench/records"] as Record<string, unknown>).readOwnDraft = record("read", { project: draft, revision: 1 });
  mocks["@/lib/workbench/board-transfer"] = {
    TransferRefused: class TransferRefused extends Error { constructor(message: string, readonly status: number) { super(message); } },
    transferBoards: record("transfer", { moved: [] }),
    transferAllOf: record("transfer", { moved: [] }),
    undoTransfers: record("transfer", { restored: [] }),
  };
  const compiled = ts.transpileModule(
    readFileSync("app/api/workbench/projects/route.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const exports: Record<string, (request: Request) => Promise<Response>> = {};
  vm.runInNewContext(compiled, {
    exports,
    Response,
    URL,
    require: (name: string) => {
      if (!(name in mocks)) throw new Error(`Unexpected dependency ${name}`);
      return mocks[name];
    },
  });
  return { exports, calls, draft };
}

for (const [label, captured] of [
  [
    "another account in the same workspace",
    requestScope.workbenchScopeFor("current-workspace", "old-account"),
  ],
  [
    "another workspace for the same account",
    requestScope.workbenchScopeFor("old-workspace", "new-account"),
  ],
  ["an unstamped old browser", null],
] as const) {
  test(`${label} cannot save, publish, map, open or seed the starter before touching storage`, async () => {
    const { exports, calls, draft } = route();
    for (const [method, body] of [
      ["PUT", { project: draft, revision: 0 }],
      [
        "POST",
        { action: "publish", projectId: draft.id, expectedBibleVersion: 0 },
      ],
      ["POST", { action: "map-shot", projectId: draft.id, nodeId: "a" }],
      ["POST", { action: "open", projectId: "existing-production" }],
      ["POST", { action: "starter" }],
      /* Handing boards to another owner touches nothing either (board sharing, PR 4). */
      ["POST", { action: "transfer-boards", projectIds: ["prj_wb_x"], to: "someone" }],
      ["POST", { action: "transfer-all", from: "gone", to: "someone" }],
      ["POST", { action: "undo-transfer", projectIds: ["prj_wb_x"] }],
    ] as const) {
      const response = await exports[method](
        new Request("http://localhost/api/workbench/projects", {
          method,
          headers: captured ? { "X-Workbench-Scope": captured } : {},
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("account or workspace changed"),
      });
      expect(calls).toEqual([]);
    }
    if (captured) {
      expect(
        (
          await exports.GET(
            new Request("http://localhost/api/workbench/projects?id=private", {
              headers: { "X-Workbench-Scope": captured },
            }),
          )
        ).status,
      ).toBe(409);
      expect(calls).toEqual([]);
    }
  });
}

test("the current captured account can save, publish and open the starter; ordinary GET clients stay compatible", async () => {
  const { exports, calls, draft } = route();
  const headers = {
    "X-Workbench-Scope": requestScope.workbenchScopeFor(
      "current-workspace",
      "new-account",
    ),
  };
  expect(
    (
      await exports.PUT(
        new Request("http://localhost/api/workbench/projects", {
          method: "PUT",
          headers,
          body: JSON.stringify({ project: draft, revision: 0 }),
        }),
      )
    ).status,
  ).toBe(200);
  expect(calls).toContain("save");
  expect(
    (
      await exports.POST(
        new Request("http://localhost/api/workbench/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({
            action: "publish",
            projectId: draft.id,
            expectedBibleVersion: 0,
          }),
        }),
      )
    ).status,
  ).toBe(200);
  expect(calls).toContain("publish");
  const starter = await exports.POST(new Request("http://localhost/api/workbench/projects", { method: "POST", headers, body: JSON.stringify({ action: "starter" }) }));
  expect(starter.status).toBe(200);
  expect(await starter.json()).toMatchObject({ created: true, project: { id: draft.id } });
  expect(calls).toContain("starter");
  expect(
    (await exports.GET(new Request("http://localhost/api/workbench/projects")))
      .status,
  ).toBe(200);
});

test("a save the schema refuses says which rule it broke, not a generic line", async () => {
  const { exports, calls, draft } = route();
  const headers = { "X-Workbench-Scope": requestScope.workbenchScopeFor("current-workspace", "new-account") };
  const put = async (project: unknown) => {
    const response = await exports.PUT(new Request("http://localhost/api/workbench/projects", { method: "PUT", headers, body: JSON.stringify({ project, revision: 0 }) }));
    return { status: response.status, error: ((await response.json()) as { error: string }).error };
  };
  expect(await put({ ...draft, name: "x".repeat(101) })).toEqual({ status: 400, error: "Check the project's name: keep it to 100 characters." });
  expect(await put({ ...draft, scriptSource: { assetId: "missing", filename: "script.pdf", sha256: "a".repeat(64), pages: [], importedAt: "2026-09-25", edited: false, acknowledgedEmptyPages: [] } })).toEqual({ status: 400, error: "Keep the uploaded screenplay source in the asset library." });
  expect(await put({ ...draft, fps: 23 })).toEqual({ status: 400, error: "Check the project's fps: it is not valid." });
  expect(calls).not.toContain("save");
});

test("the current captured account's board hand-overs reach the transfer code, as themselves; a refusal there is its own answer", async () => {
  const { exports, calls } = route();
  const headers = { "X-Workbench-Scope": requestScope.workbenchScopeFor("current-workspace", "new-account") };
  const post = (body: unknown) => exports.POST(new Request("http://localhost/api/workbench/projects", { method: "POST", headers, body: JSON.stringify(body) }));
  expect((await post({ action: "transfer-boards", projectIds: ["prj_wb_x"], to: "someone" })).status).toBe(200);
  expect((await post({ action: "transfer-all", from: "gone", to: "someone" })).status).toBe(200);
  expect((await post({ action: "undo-transfer", projectIds: ["prj_wb_x"] })).status).toBe(200);
  expect(calls.filter((c) => c === "transfer")).toHaveLength(3);
});
