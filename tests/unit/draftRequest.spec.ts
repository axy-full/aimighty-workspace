import { test, expect } from "@playwright/test";
import { newProject } from "../../lib/workbench/studio";
import {
  writeDraft,
  writeMergedDraft,
  reconcileDraftWrite,
  sameDraftContent,
  isDraftConflict,
  DraftRequestError,
  draftRequest,
  MERGE_TRIES,
  draftWriter,
} from "../../lib/workbench/draft-request";
import type { Project } from "../../lib/workbench/studio";
const nativeFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = nativeFetch;
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
test("lost save acknowledgement is reconciled once without writing twice", async () => {
  const project = newProject("Lost acknowledgement"),
    saved = {
      ...project,
      productionProjectId: "p",
      shotMappings: { node: "shot" },
    };
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "PUT") throw new TypeError("Failed to fetch");
    return json({ project: saved, revision: 8 });
  };
  expect(
    await writeDraft("/api/workbench", "scope", { project, revision: 7 }),
  ).toEqual({
    revision: 8,
    productionProjectId: "p",
    shotMappings: { node: "shot" },
  });
  expect(methods).toEqual(["PUT", "GET"]);
});
test("failed uncommitted save is retryable and never blindly resubmitted", async () => {
  const project = newProject("Still local");
  let writes = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PUT") {
      writes++;
      throw new TypeError("Failed to fetch");
    }
    return json({ project, revision: 1 });
  };
  const error = await writeDraft("/api/workbench", "scope", {
    project,
    revision: 1,
  }).catch((error) => error);
  expect(error).toBeInstanceOf(DraftRequestError);
  expect(error.retryable).toBe(true);
  expect(error.uncertain).toBe(true);
  expect(writes).toBe(1);
});
test("a competing window never gets overwritten after interrupted save", async () => {
  const project = newProject("Local"),
    remote = { ...project, name: "Other window" };
  let writes = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PUT") {
      writes++;
      throw new TypeError("Failed to fetch");
    }
    return json({ project: remote, revision: 3 });
  };
  const error = await writeDraft("/api/workbench", "scope", {
    project,
    revision: 2,
  }).catch((error) => error);
  expect(error.message).toContain("another window");
  expect(error.retryable).toBe(false);
  expect(writes).toBe(1);
});
test("canonical comparison ignores only server identities and object order", () => {
  const project = newProject("Order");
  expect(
    sameDraftContent(project, {
      ...Object.fromEntries(Object.entries(project).reverse()),
      productionProjectId: "p",
      shotMappings: {},
    } as typeof project),
  ).toBe(true);
  expect(
    sameDraftContent(project, { ...project, brief: "Different brief" }),
  ).toBe(false);
});
test("offline reconciliation preserves uncertainty instead of sending a mutation", async () => {
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? "GET");
    throw new TypeError("Failed to fetch");
  };
  await expect(
    reconcileDraftWrite("/api/workbench", "scope", {
      project: newProject("Offline"),
      revision: 1,
    }),
  ).rejects.toMatchObject({ retryable: true, uncertain: true });
  expect(methods).toEqual(["GET"]);
});
test("expired login is actionable and not automatically retried", async () => {
  globalThis.fetch = async () => json({}, 401);
  await expect(
    draftRequest("/api/workbench/projects", "scope"),
  ).rejects.toMatchObject({
    retryable: false,
    message: expect.stringContaining("session expired"),
  });
});

test("a failed reconciliation read retains the exact uncertain write across retry and never sends a second PUT", async () => {
  const project = newProject("Captured before new edits"),
    write = { project, revision: 3 };
  let reads = 0;
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "PUT") throw new TypeError("Lost acknowledgement");
    if (++reads === 1) return json({ error: "Temporarily unavailable" }, 503);
    return json({
      project: {
        ...project,
        productionProjectId: "production",
        shotMappings: {},
      },
      revision: 4,
    });
  };
  await expect(
    writeDraft("/api/workbench", "scope", write),
  ).rejects.toMatchObject({ retryable: true, uncertain: true });
  // Studio retains the captured write even if the editable project has advanced.
  expect(await reconcileDraftWrite("/api/workbench", "scope", write)).toEqual({
    revision: 4,
    productionProjectId: "production",
    shotMappings: {},
  });
  expect(methods).toEqual(["PUT", "GET", "GET"]);
});
test("direct failed reconciliation retains uncertainty for 5xx and refused auth while preserving retry policy", async () => {
  for (const status of [401, 403, 409, 503]) {
    globalThis.fetch = async () => json({ error: "Unavailable" }, status);
    await expect(
      reconcileDraftWrite("/api/workbench", "scope", {
        project: newProject("Read refused"),
        revision: 1,
      }),
    ).rejects.toMatchObject({ uncertain: true, retryable: status >= 500 });
  }
});
test("malformed successful PUT receipts reconcile rather than advancing or clearing server identities", async () => {
  const project = newProject("Receipt validation");
  const valid = {
    revision: 2,
    productionProjectId: "production",
    shotMappings: { node: "shot" },
  };
  for (const malformed of [
    {},
    { ...valid, revision: 1 },
    { ...valid, revision: 3 },
    { ...valid, revision: 2.5 },
    { ...valid, productionProjectId: "" },
    { ...valid, productionProjectId: null },
    { ...valid, shotMappings: [] },
    { ...valid, shotMappings: { node: 12 } },
    { ...valid, shotMappings: { node: "" } },
  ]) {
    const methods: string[] = [];
    globalThis.fetch = async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return init?.method === "PUT"
        ? json(malformed)
        : json({
            project: {
              ...project,
              productionProjectId: "production",
              shotMappings: { node: "shot" },
            },
            revision: 2,
          });
    };
    expect(
      await writeDraft("/api/workbench", "scope", { project, revision: 1 }),
    ).toEqual(valid);
    expect(methods).toEqual(["PUT", "GET"]);
  }
});
test("malformed reconciliation data never gets mistaken for a definitive competing revision", async () => {
  const project = newProject("Read validation");
  for (const data of [
    {},
    { revision: "1", project },
    { revision: -1, project },
    { revision: 1.5, project },
    { revision: 1, project: null },
    { revision: 1 },
    { revision: 1, project: { ...project, id: "wrong" } },
    { revision: 1, project: { ...project, nodes: null } },
    { revision: 2, project },
    {
      revision: 2,
      project: {
        ...project,
        productionProjectId: "production",
        shotMappings: { node: 4 },
      },
    },
  ]) {
    globalThis.fetch = async () => json(data);
    await expect(
      reconcileDraftWrite("/api/workbench", "scope", { project, revision: 1 }),
    ).rejects.toMatchObject({ retryable: true, uncertain: true });
  }
});
test("an uncreated draft can safely retry, while explicit PUT rejection never triggers recovery GET", async () => {
  const project = newProject("New draft");
  globalThis.fetch = async () => json({ project: null, revision: 0 });
  expect(
    await reconcileDraftWrite("/api/workbench", "scope", {
      project,
      revision: 0,
    }),
  ).toBeNull();
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? "GET");
    return json({ error: "Conflicting revision" }, 409);
  };
  await expect(
    writeDraft("/api/workbench", "scope", { project, revision: 1 }),
  ).rejects.toMatchObject({ retryable: false, uncertain: false });
  expect(methods).toEqual(["PUT"]);
});

/* writeMergedDraft: a save that another save beat is merged into the newer version, never replayed. */
type Tag = { writer: string; seq: number };
/**
 * A revision-checked server that records each tagged save under its writer (lib/workbench/records.ts):
 * `check-write` answers whether a save landed, and fences one that did not, so it never lands late.
 */
function server(start: { project: Project; revision: number }, options: { onPut?: (body: { project: Project; revision: number; write?: Tag }, count: number) => Response | "drop" | undefined } = {}) {
  const state = { ...start, calls: [] as string[], puts: 0, writes: new Map<string, { seq: number; revision: number | null }>() };
  globalThis.fetch = async (_url, init) => {
    const method = init?.method ?? "GET";
    state.calls.push(method);
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { project: Project; revision: number; write?: Tag };
      const special = options.onPut?.(body, ++state.puts);
      if (special && special !== "drop") return special;
      const seen = body.write ? state.writes.get(body.write.writer) : undefined;
      if (body.revision !== state.revision || (seen && seen.seq >= body.write!.seq)) return json({ error: "This project changed in another window.", code: "revision_conflict" }, 409);
      state.project = { ...body.project, productionProjectId: "production", shotMappings: {} };
      state.revision += 1;
      if (body.write) state.writes.set(body.write.writer, { seq: body.write.seq, revision: state.revision });
      if (special === "drop") throw new TypeError("Failed to fetch");
      return json({ revision: state.revision, productionProjectId: "production", shotMappings: {} });
    }
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as { action: string; write: Tag };
      const row = state.writes.get(body.write.writer);
      const landed = row && row.seq === body.write.seq && row.revision !== null ? row.revision : null;
      if (landed === null && (!row || row.seq < body.write.seq)) state.writes.set(body.write.writer, { seq: body.write.seq, revision: null });
      return json({ landed, project: state.project, revision: state.revision });
    }
    return json({ project: state.project, revision: state.revision });
  };
  return state;
}
const node = (id: string, title = id) => ({ id, title, type: "scene" as const, x: 0, y: 0, width: 238, linked: [] as string[] });

test("a save another save beat is merged into the newer version: both edits kept, sent at its revision", async () => {
  const base = { ...newProject("Merge on conflict"), nodes: [node("n1")] };
  const theirs = { ...base, brief: "Written in another tab", nodes: [...base.nodes, node("t1")] };
  const state = server({ project: theirs, revision: 5 });
  const mine = { ...base, nodes: [{ ...base.nodes[0], text: "A fox on the ice" }, node("m1")] };
  const saved = await writeMergedDraft("/api/workbench", "scope", { base, mine, revision: 4 });
  expect(state.calls).toEqual(["PUT", "GET", "PUT"]);
  expect(saved.revision).toBe(6);
  expect(saved.project.brief).toBe("Written in another tab");
  expect(saved.project.nodes.map((n) => n.id)).toEqual(["n1", "m1", "t1"]);
  expect(saved.project.nodes[0].text).toBe("A fox on the ice");
  expect(state.project.nodes.map((n) => n.id)).toEqual(["n1", "m1", "t1"]);
});

test("a save whose reply was lost is checked, not guessed: it landed, so nothing is sent again over what was built on it", async () => {
  const base = { ...newProject("Lost reply"), nodes: [node("n1")] };
  const mine = { ...base, nodes: [...base.nodes, node("m1")] };
  const state = server({ project: base, revision: 1 }, { onPut: (_body, count) => (count === 1 ? "drop" : undefined) });
  /* After our PUT lands and its reply is lost, another tab saves on top of it before the check. */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      state.project = { ...state.project, brief: "Another tab, on top of ours" };
      state.revision += 1;
    }
    return realFetch(url, init);
  };
  const saved = await writeMergedDraft("/api/workbench", "scope", { base, mine, revision: 1 });
  expect(state.calls).toEqual(["PUT", "POST"]);
  expect(saved.revision).toBe(3);
  expect(saved.project.nodes.map((n) => n.id)).toEqual(["n1", "m1"]);
  expect(saved.project.brief).toBe("Another tab, on top of ours");
});

test("a save that never arrived is fenced when checked, then sent again, once", async () => {
  const base = { ...newProject("Not landed"), nodes: [node("n1")] };
  const mine = { ...base, nodes: [...base.nodes, node("m1")] };
  let first: { project: Project; revision: number; write?: Tag } | null = null;
  const state = server({ project: base, revision: 2 }, {
    onPut: (body) => {
      if (first) return undefined;
      first = body;
      throw new TypeError("Failed to fetch");
    },
  });
  const saved = await writeMergedDraft("/api/workbench", "scope", { base, mine, revision: 2 });
  expect(state.calls).toEqual(["PUT", "POST", "PUT"]);
  expect(saved.revision).toBe(3);
  expect(state.project.nodes.map((n) => n.id)).toEqual(["n1", "m1"]);
  /* The first PUT arriving late (the network held it) is refused: the check fenced it. */
  const late = await globalThis.fetch("/api/workbench/projects", { method: "PUT", body: JSON.stringify({ ...first!, revision: state.revision }) });
  expect(late.status).toBe(409);
});

test("a network that stays down keeps the save unknown, on the writer, for the caller to retry", async () => {
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? "GET");
    throw new TypeError("Failed to fetch");
  };
  const project = newProject("Offline");
  const writer = draftWriter();
  await expect(writeMergedDraft("/api/workbench", "scope", { base: project, mine: { ...project, brief: "Offline edit" }, revision: 1, writer }))
    .rejects.toMatchObject({ retryable: true, uncertain: true });
  expect(methods).toEqual(["PUT", "POST"]);
  expect(writer.unconfirmed).toMatchObject({ projectId: project.id, seq: 1 });
});

test("conflicts that keep coming stop after a few merges, as a conflict; other refusals are never merged", async () => {
  const base = newProject("Busy");
  let revision = 1;
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "PUT") return json({ error: "This project changed in another window.", code: "revision_conflict" }, 409);
    revision += 1;
    return json({ project: { ...base, brief: `Other save ${revision}` }, revision });
  };
  const error = await writeMergedDraft("/api/workbench", "scope", { base, mine: { ...base, name: "Mine" }, revision: 1 }).catch((e) => e);
  expect(isDraftConflict(error)).toBe(true);
  expect(methods.filter((m) => m === "PUT")).toHaveLength(MERGE_TRIES + 1);

  const refused: string[] = [];
  globalThis.fetch = async (_url, init) => {
    refused.push(init?.method ?? "GET");
    return json({ error: "A draft cannot change its project. Open a separate space." }, 409);
  };
  await expect(writeMergedDraft("/api/workbench", "scope", { base, mine: { ...base, name: "Mine" }, revision: 1 }))
    .rejects.toMatchObject({ retryable: false, uncertain: false, status: 409 });
  expect(refused).toEqual(["PUT"]);
});

test("nothing is sent when the newer version already holds every edit", async () => {
  const base = { ...newProject("Same edit"), nodes: [node("n1")] };
  const mine = { ...base, brief: "Both tabs typed this" };
  const state = server({ project: { ...mine, productionProjectId: "production", shotMappings: {} }, revision: 9 });
  const saved = await writeMergedDraft("/api/workbench", "scope", { base, mine, revision: 8 });
  expect(state.calls).toEqual(["PUT", "GET"]);
  expect(saved).toMatchObject({ revision: 9, project: { brief: "Both tabs typed this" } });
});
