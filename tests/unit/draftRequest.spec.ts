import { test, expect } from "@playwright/test";
import { newProject } from "../../lib/workbench/studio";
import {
  writeDraft,
  reconcileDraftWrite,
  sameDraftContent,
  DraftRequestError,
  draftRequest,
} from "../../lib/workbench/draft-request";
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
