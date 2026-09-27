import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

test("own-key usage exposes display settings without execution metadata", async ({ page }) => {
  const { workspace } = await signInLocally(page.request);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl: string;
  try {
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [workspace.id] })).rows[0].db_url);
    await platform.execute({ sql: "UPDATE workspaces SET uses_platform_keys=0 WHERE id=?", args: [workspace.id] });
  } finally { platform.close(); }
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const id = `gen_usage_${randomUUID()}`;
  const settings = { resolution: "720p", ratio: "16:9", duration: 4, steps: 12 };
  const params = JSON.stringify({ ...settings, paidClaim: { token: "private-test-claim" }, credentialFingerprint: "private-test-fingerprint", providerPoll: { token: "private-test-poll" }, unknownInternal: "private-test-unknown" });
  try {
    await tenant.execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,provider,cost_usd) VALUES(?,?,?,?,'succeeded',?,?,'video','byteplus',?)",
      args: [id, "dreamina-seedance-2-5-260628", "A quiet coastline", params, Date.now(), Date.now(), 0.12345],
    });
    const response = await page.request.get("/api/usage");
    expect(response.ok(), await response.text()).toBe(true);
    const body = await response.json();
    expect(body.recent.find((row: { id: string }) => row.id === id).params).toEqual(settings);
    expect(JSON.stringify(body)).not.toContain("private-test-");
    expect(String((await tenant.execute({ sql: "SELECT params FROM generations WHERE id=?", args: [id] })).rows[0].params)).toBe(params);
    await tenant.execute({ sql: "UPDATE generations SET params=? WHERE id=?", args: ["{broken", id] });
    const malformed = await page.request.get("/api/usage");
    expect(malformed.ok()).toBe(true);
    expect((await malformed.json()).recent.find((row: { id: string }) => row.id === id).params).toEqual({});
  } finally { tenant.close(); }
});
