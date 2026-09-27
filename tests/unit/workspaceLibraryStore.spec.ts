import { test, expect } from "@playwright/test";
import { findProjectTake, loadProjectLibrary, projectLibraryState, refreshProjectLibrary } from "../../lib/workspace/library";

/* The project library store over a fake /api/workbench/library: one read in flight, a change, a refresh. */
type Pending = { source: string; resolve: (body: unknown) => void; fail: () => void };
function fakeLibrary() {
  const pending: Pending[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const source = new URL(String(input), "http://x").searchParams.get("source")!;
    return new Promise<Response>((resolve) => {
      pending.push({
        source,
        resolve: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })),
        fail: () => resolve(new Response(JSON.stringify({ error: "The library is resting." }), { status: 503 })),
      });
    });
  }) as typeof fetch;
  const settle = async (answer: (p: Pending) => void) => {
    for (let i = 0; i < 20 && pending.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    pending.splice(0).forEach(answer);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const page = (ids: string[]) => (p: Pending) => p.resolve(p.source === "uploads"
    ? { uploads: [], nextCursor: null }
    : { generations: ids.map((id) => ({ id, createdAt: 1, params: {}, status: "succeeded", kind: "image", model: "m", prompt: "" })), nextPageCursor: null });
  return { pending, settle, page, restore: () => { globalThis.fetch = original; } };
}

test("a refresh asked for while a read is in flight reads again once that read lands", async () => {
  const lib = fakeLibrary();
  try {
    const first = loadProjectLibrary("scope-a", "p1");
    await lib.settle(lib.page(["g1"]));
    await first;
    expect(projectLibraryState("scope-a", "p1").generations.map((g) => g.id)).toEqual(["g1"]);

    /* A render landed and asked for a refresh; before that read answers, a take is deleted and asks again. */
    const renderRefresh = refreshProjectLibrary("scope-a", "p1");
    const deleteRefresh = refreshProjectLibrary("scope-a", "p1");
    await lib.settle(lib.page(["g1", "g2"]));
    await renderRefresh;
    /* The first read was issued before the delete: its answer is not the last word. */
    await lib.settle(lib.page(["g2"]));
    await deleteRefresh;
    expect(projectLibraryState("scope-a", "p1").generations.map((g) => g.id)).toEqual(["g2"]);
    expect(lib.pending).toHaveLength(0);
  } finally { lib.restore(); }
});

test("a failed first read is an error that a refresh clears, not 'Reading…' for the session", async () => {
  const lib = fakeLibrary();
  try {
    const first = loadProjectLibrary("scope-b", "p2");
    await lib.settle((p) => p.fail());
    await first;
    expect(projectLibraryState("scope-b", "p2")).toMatchObject({ status: "error", error: "The library is resting." });
    /* Try again (or a render landing) reads it again. */
    const again = refreshProjectLibrary("scope-b", "p2");
    expect(projectLibraryState("scope-b", "p2").status).toBe("loading");
    await lib.settle(lib.page(["g9"]));
    await again;
    expect(projectLibraryState("scope-b", "p2")).toMatchObject({ status: "ready", error: null });
  } finally { lib.restore(); }
});

/* A library over a fake route that answers at once: 60 a page, newest first, and one asset by `id` under the same membership. */
function routeLibrary(generations: string[], opts: { lookup?: "answer" | "fail" | "ignore" } = {}) {
  const original = globalThis.fetch;
  const asked: string[] = [];
  const row = (id: string) => ({ id, createdAt: 1_000 - generations.indexOf(id), params: {}, status: "succeeded", kind: "image", model: "m", prompt: "" });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    asked.push(url.search);
    const source = url.searchParams.get("source")!, id = url.searchParams.get("id"), offset = Number(url.searchParams.get("cursor") ?? 0);
    if (source === "uploads") return new Response(JSON.stringify({ uploads: [], nextCursor: null }), { status: 200 });
    if (id !== null && opts.lookup !== "ignore") {
      if (opts.lookup === "fail") return new Response(JSON.stringify({ error: "Resting." }), { status: 503 });
      return new Response(JSON.stringify({ generations: generations.includes(id) ? [row(id)] : [], nextPageCursor: null }), { status: 200 });
    }
    const page = generations.slice(offset, offset + 60).map(row);
    return new Response(JSON.stringify({ generations: page, nextPageCursor: offset + 60 < generations.length ? String(offset + 60) : null }), { status: 200 });
  }) as typeof fetch;
  return { asked, restore: () => { globalThis.fetch = original; } };
}
const many = (n: number) => Array.from({ length: n }, (_, i) => `g${String(i).padStart(4, "0")}`);

test("a take older than every loaded page is asked for by id, kept beside the pages, and kept through a re-read", async () => {
  const lib = routeLibrary(many(1500));
  try {
    expect(await findProjectTake("scope-c", "p3", "generation:g1499")).toBe(true);
    const state = projectLibraryState("scope-c", "p3");
    /* One page and one lookup: no paging back through twenty-five pages. */
    expect(state.generations).toHaveLength(61);
    expect(state.generations.at(-1)!.id).toBe("g1499");
    expect(lib.asked.filter((q) => q.includes("cursor="))).toEqual([]);
    expect(lib.asked.filter((q) => q.includes("id=g1499"))).toHaveLength(1);
    /* A refresh re-reads the range and keeps the pinned take. */
    await refreshProjectLibrary("scope-c", "p3");
    expect(projectLibraryState("scope-c", "p3").generations.map((g) => g.id)).toContain("g1499");
    expect(projectLibraryState("scope-c", "p3").generations).toHaveLength(61);
  } finally { lib.restore(); }
});

test("a take the project does not hold is answered at once, without paging back and without pinning anything", async () => {
  const lib = routeLibrary(many(300));
  try {
    expect(await findProjectTake("scope-d", "p4", "generation:someone-elses")).toBe(false);
    expect(projectLibraryState("scope-d", "p4").generations).toHaveLength(60);
    expect(lib.asked.filter((q) => q.includes("cursor="))).toEqual([]);
    /* A malformed id is never asked for. */
    expect(await findProjectTake("scope-d", "p4", "generation:../x")).toBe(false);
    expect(await findProjectTake("scope-d", "p4", "take:g0001")).toBe(false);
    expect(lib.asked.some((q) => q.includes("..%2Fx") || q.includes("../x"))).toBe(false);
  } finally { lib.restore(); }
});

test("when the lookup cannot answer, the search pages back as before, and still stops after twenty pages", async () => {
  const lib = routeLibrary(many(1500), { lookup: "fail" });
  try {
    expect(await findProjectTake("scope-e", "p5", "generation:g0200")).toBe(true);
    expect(lib.asked.filter((q) => q.includes("cursor="))).toHaveLength(3);
    expect(await findProjectTake("scope-e", "p5", "generation:g1499")).toBe(false);
    expect(projectLibraryState("scope-e", "p5").generations.length).toBeLessThan(1500);
  } finally { lib.restore(); }
});

test("a server that does not know the lookup yet answers its first page: that is not taken as an answer, and the search pages back", async () => {
  const lib = routeLibrary(many(300), { lookup: "ignore" });
  try {
    expect(await findProjectTake("scope-f", "p6", "generation:g0130")).toBe(true);
    expect(lib.asked.filter((q) => q.includes("cursor="))).toHaveLength(2);
    expect(projectLibraryState("scope-f", "p6").generations).toHaveLength(180);
  } finally { lib.restore(); }
});

test("two surfaces looking for the same take at once ask once", async () => {
  const lib = routeLibrary(many(500));
  try {
    const [a, b] = await Promise.all([findProjectTake("scope-g", "p7", "generation:g0400"), findProjectTake("scope-g", "p7", "generation:g0400")]);
    expect([a, b]).toEqual([true, true]);
    expect(lib.asked.filter((q) => q.includes("id=g0400"))).toHaveLength(1);
  } finally { lib.restore(); }
});
