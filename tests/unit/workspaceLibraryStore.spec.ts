import { test, expect } from "@playwright/test";
import { loadProjectLibrary, projectLibraryState, refreshProjectLibrary } from "../../lib/workspace/library";

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
