import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

test("an old workspace flag cannot authorize provider-wallet spending after migration", async ({ page }) => {
  const { workspace } = await signInLocally(page.request);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "UPDATE workspaces SET uses_platform_keys=0 WHERE id=?", args: [workspace.id] });
    const me = await page.request.get("/api/me").then(r => r.json());
    expect(me.rates.unit).toBe("cr");
    const response = await page.request.post("/api/higgsfield/consumer/video", {
      headers: { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` },
      data: { action: "quote", draftId: "not-created", idempotencyKey: randomUUID(), input: {
        prompt: "A plain bottle on a studio plinth", duration: 15, resolution: "720p", aspectRatio: "16:9", generateAudio: true,
      } },
    });
    expect(response.status(), await response.text()).toBe(409);
    expect(await response.json()).toMatchObject({ code: "particl_quote_unavailable" });
    const jobs = await page.request.get("/api/higgsfield/consumer/video", {
      headers: { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` },
    });
    expect(jobs.ok(), await jobs.text()).toBe(true);
    expect((await jobs.json()).jobs).toEqual([]);
    for (const data of [
      { action: "characters-create", name: "Mira", type: "soul_2", sources: Array.from({ length: 5 }, (_, i) => ({ uploadId: `original-${i}` })) },
      { action: "elements-create", name: "Harbour", category: "environment", sources: [{ uploadId: "original-0" }] },
    ]) {
      const build = await page.request.post("/api/higgsfield/consumer/generation", {
        headers: { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` }, data,
      });
      expect(build.status(), await build.text()).toBe(409);
      expect(await build.json()).toMatchObject({ code: "particl_quote_unavailable" });
    }
  } finally { platform.close(); }
});
