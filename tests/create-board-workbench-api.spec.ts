import { test, expect, request as pwRequest } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * `create_board` through the real routes on a local ENGINE_MOCK server (lib/v12/tools/create-board.ts; rule 11): a token with the render scope
 * makes a board, it is free (nothing in the ledger moves), its rail starts with the demo's steps, a read-only token is refused, and the
 * board is the caller's own: a second workspace never sees it.
 */
const BASE = process.env.PW_BASE_URL || "http://localhost:4551";

test("an agent with a render token makes a board for free; a read-only token is refused; another workspace sees nothing", async ({ request }) => {
  const account = await signInLocally(request);
  const me = await request.get("/api/me").then((r) => r.json());
  /* A paid plan, so the workspace may hold more than one board (the Invite plan holds one). */
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await platform.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [account.workspace.id] }); } finally { platform.close(); }
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const mint = async (scope: "render" | "read") => {
    const made = await request.post("/api/tokens", { headers, data: { name: `Board ${scope}`, scope } });
    expect(made.ok(), await made.text()).toBe(true);
    return String((await made.json()).token);
  };
  const [render, read] = [await mint("render"), await mint("read")];
  const before = await request.get("/api/usage/summary").then((r) => r.json());

  /* A bearer caller has no session: a fresh context carries the token alone. */
  const agent = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${render}` } });
  const made = await agent.post("/api/boards", { data: { kind: "film", name: "Agent board", brief: "A harbour wakes up.", aspect: "9:16", length: "30 s" } });
  expect(made.ok(), await made.text()).toBe(true);
  const board = (await made.json()) as { id: string; name: string; revision: number };
  expect(board).toMatchObject({ name: "Agent board", revision: 1 });

  /* It is the person's board, with the demo's steps: pitch first, treatment and locations left off, elements skipped. */
  const read1 = (await request.get(`/api/workbench/projects?id=${board.id}`, { headers }).then((r) => r.json())) as { project: { brief: string; aspect: string; boardFlavor: string; boardStages: { id: string; skipped?: boolean; removed?: boolean }[] } | null };
  expect(read1.project).toMatchObject({ brief: "A harbour wakes up.", aspect: "9:16", boardFlavor: "film" });
  expect(read1.project!.boardStages[0]).toEqual({ id: "pitch" });
  expect(read1.project!.boardStages.find((s) => s.id === "treatment")).toEqual({ id: "treatment", removed: true });
  expect(read1.project!.boardStages.find((s) => s.id === "elements")).toEqual({ id: "elements", skipped: true });

  /* Free: nothing was spent or reserved. */
  const after = await request.get("/api/usage/summary").then((r) => r.json());
  expect(after).toEqual(before);

  /* A read-only token writes nothing. */
  const reader = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${read}` } });
  const refused = await reader.post("/api/boards", { data: { name: "Nope" } });
  expect(refused.ok()).toBe(false);
  expect([401, 403]).toContain(refused.status());

  /* A browser session is checked as the draft's own save is: a foreign origin is refused, and so is a page drawn for another account or workspace. */
  const foreign = await request.post("/api/boards", { headers: { ...headers, Origin: "https://elsewhere.example" }, data: { name: "Cross-site" } });
  expect(foreign.status()).toBe(403);
  const stale = await request.post("/api/boards", { headers: { "X-Workbench-Scope": "particl-active-someone-else" }, data: { name: "Stale page" } });
  expect(stale.status()).toBe(409);
  const unscoped = await request.post("/api/boards", { data: { name: "No scope" } });
  expect(unscoped.status()).toBe(409);
  const person = await request.post("/api/boards", { headers, data: { name: "By a person" } });
  expect(person.ok(), await person.text()).toBe(true);

  /* Nonsense is refused in words, with nothing made. */
  const bad = await agent.post("/api/boards", { data: { aspect: "3:2" } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toBe("Pick 16:9, 9:16, 1:1 or 4:5.");

  /* Another workspace sees nothing of it. */
  const other = await pwRequest.newContext({ baseURL: BASE });
  try {
    const stranger = await signInLocally(other, "Another Tester");
    const strangerMe = await other.get("/api/me").then((r) => r.json());
    const theirs = await other.get(`/api/workbench/projects?id=${board.id}`, { headers: { "X-Workbench-Scope": `particl-active-${stranger.workspace.id}-${strangerMe.id}` } }).then((r) => r.json()) as { project: unknown; projects: { id: string }[] };
    expect(theirs.project).toBeNull();
    expect(theirs.projects.map((p) => p.id)).not.toContain(board.id);
  } finally {
    await other.dispose();
  }
  await agent.dispose();
  await reader.dispose();
});
