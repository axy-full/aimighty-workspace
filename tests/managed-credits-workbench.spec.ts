import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/* The Higgsfield sign-in is retired (lib/higgsfield-consumer/retired.ts): every request for new work on the account
   answers this, before anything is read or priced. */
const RETIRED = { code: "retired", error: "The connected account is no longer used. Past results stay in your Library." };

test("an old workspace flag cannot authorize provider-wallet spending after migration", async ({ page }) => {
  const { workspace } = await signInLocally(page.request);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "UPDATE workspaces SET uses_platform_keys=0 WHERE id=?", args: [workspace.id] });
    /* The old own-key flag: the workspace still pays in credits. */
    const me = await page.request.get("/api/me").then(r => r.json());
    expect(me.rates.unit).toBe("cr");
    const headers = { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` };
    /* Nor does it reach the account's diagnostics, a provider-wallet quote or a build. */
    for (const action of ["capabilities", "qualification", "analysis-qualification"]) {
      const diagnostics = await page.request.post(`/api/higgsfield/consumer/${action}`, { headers, data: {} });
      expect(diagnostics.status(), await diagnostics.text()).toBe(410);
      expect(await diagnostics.json()).toEqual(RETIRED);
    }
    const response = await page.request.post("/api/higgsfield/consumer/video", {
      headers,
      data: { action: "quote", draftId: "not-created", idempotencyKey: randomUUID(), input: {
        prompt: "A plain bottle on a studio plinth", duration: 15, resolution: "720p", aspectRatio: "16:9", generateAudio: true,
      } },
    });
    expect(response.status(), await response.text()).toBe(410);
    expect(await response.json()).toEqual(RETIRED);
    /* Release 1: the account's saved-job list is retired too (past results are read from the Library, not from this route). */
    const jobs = await page.request.get("/api/higgsfield/consumer/video", { headers });
    expect(jobs.status(), await jobs.text()).toBe(410);
    expect(await jobs.json()).toEqual(RETIRED);
    for (const data of [
      { action: "characters-create", name: "Wren", type: "soul_2", sources: Array.from({ length: 5 }, (_, i) => ({ uploadId: `original-${i}` })) },
      { action: "elements-create", name: "Harbour", category: "environment", sources: [{ uploadId: "original-0" }] },
    ]) {
      const build = await page.request.post("/api/higgsfield/consumer/generation", { headers, data });
      expect(build.status(), await build.text()).toBe(410);
      expect(await build.json()).toEqual(RETIRED);
    }
  } finally { platform.close(); }
});
