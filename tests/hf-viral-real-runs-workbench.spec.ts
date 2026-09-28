import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";

/**
 * Viral's account runs (idea 17) after the Higgsfield sign-in was retired
 * (lib/higgsfield-consumer/retired.ts): the Viral pages meet the retired card
 * (tests/hf-role-aware-connected-workbench.spec.ts), and each run's result is
 * a take in the Library like any other. The runs themselves stay readable on
 * the real route — the runs view still pages by cursor and the saved-jobs
 * list is unchanged — while pricing or starting a run answers 410. Nothing
 * here is priced or sent.
 */

test("the real route: the runs view pages runs by cursor and the saved-jobs list is unchanged; a quote or a submit is retired", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one server check is enough");
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; owner?: boolean; workspace: { id: string } };
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const base = "/api/higgsfield/consumer/genjutsu?draftId=ws-runs-real";
  const runs = await page.request.get(`${base}&view=runs`, { headers });
  expect(runs.status(), await runs.text()).toBe(200);
  expect(await runs.json()).toMatchObject({ jobs: [], nextCursor: null, connection: { connected: false } });
  const saved = await page.request.get(base, { headers });
  expect(saved.status()).toBe(200);
  const body = await saved.json();
  expect(body.jobs).toEqual([]);
  expect(body).not.toHaveProperty("nextCursor");
  const swaps = await page.request.get(`${base}&view=runs&variant=object-swap`, { headers });
  expect(swaps.status(), await swaps.text()).toBe(200);
  expect(await swaps.json()).toMatchObject({ jobs: [], nextCursor: null });
  for (const query of ["&view=runs&cursor=nope", "&cursor=1700000000000.abc", "&view=everything", "&variant=object-swap", "&view=runs&variant=lip-sync"])
    expect((await page.request.get(`${base}${query}`, { headers })).status(), query).toBe(400);

  /* New work is retired on the real server, whatever the body holds; a status read still reaches the ledger. */
  const post = (data: Record<string, unknown>) => page.request.post("/api/higgsfield/consumer/genjutsu", { headers, data });
  for (const action of ["quote", "submit"]) {
    const refused = await post({ action, draftId: "ws-runs-real" });
    expect(refused.status(), action).toBe(410);
    expect(await refused.json()).toEqual({ code: "retired", error: "Particl no longer signs in to Higgsfield. Past results stay in your Library." });
  }
  const status = await post({ action: "status", draftId: "ws-runs-real", id: "44444444-4444-4444-8444-000000000001" });
  expect(status.status()).not.toBe(410);
});
