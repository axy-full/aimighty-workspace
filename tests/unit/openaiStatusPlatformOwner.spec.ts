import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantToken, TenantUser, TenantWorkspace } from "../../lib/tenant";
import { loadRouteModule } from "../helpers/vendorCostScan";

/*
 * GET /api/openai/status lists the language account's models (owner, 24 Oct 2026, item 14 (c)): the platform's owner alone reads it, never a
 * member, a workspace's own owner or a token. The route's real gate runs here (lib/auth.ts requireSuperAdmin); only the tenant wrapper is
 * unwrapped. Under ENGINE_MOCK nothing is asked of any account.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-openai-status-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const PLATFORM_OWNER = "platform-owner@example.test";
const prior = process.env.SUPER_ADMIN_EMAIL;
test.beforeAll(() => { process.env.SUPER_ADMIN_EMAIL = PLATFORM_OWNER; });
test.afterAll(() => { if (prior === undefined) delete process.env.SUPER_ADMIN_EMAIL; else process.env.SUPER_ADMIN_EMAIL = prior; });

type Handler = (req: Request) => Promise<Response>;
const workspace = (): TenantWorkspace => {
  const id = `ws_oas_${randomUUID().slice(0, 8)}`;
  return { id, slug: id, name: "Status", legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null,
    gatewayKeyId: null, ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null };
};
const user = (id: string, email: string, role: "admin" | "member", owner: boolean) =>
  ({ id, email, name: id, role, owner, disabled: false, lastSeen: null, createdAt: 0 }) as TenantUser;

async function asks(ws: TenantWorkspace, who: TenantUser, token?: TenantToken): Promise<{ status: number; body: Record<string, unknown> }> {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformReady } = await import("../../lib/platform");
  await platformReady();
  const route = loadRouteModule<{ GET: Handler }>("app/api/openai/status/route.ts", { "@/lib/auth": { ...(await import("../../lib/auth")), withTenant: (fn: Handler) => fn } });
  return runInTenant(ws, async () => {
    const res = await route.GET(new Request("https://particl.test/api/openai/status"));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }, { user: who, ...(token ? { token } : {}) });
}

test("a member, a workspace's own owner and a token are refused; the platform's owner reads it", async () => {
  const ws = workspace();
  const member = await asks(ws, user("u_member", "member@example.test", "member", false));
  expect(member.status).toBe(403);
  expect(member.body).not.toHaveProperty("models");
  const owner = await asks(ws, user("u_owner", "owner@example.test", "admin", true));
  expect(owner.status, "the workspace's owner is not the platform's").toBe(403);
  expect(owner.body).not.toHaveProperty("models");
  /* A token is refused before anything else, even one made by the platform's owner. */
  for (const scope of ["read", "render", "prepare"] as const) {
    const token = await asks(ws, user("u_platform", PLATFORM_OWNER, "admin", true), { id: `tok_${scope}`, name: "Token", scope, capUsd: null } as TenantToken);
    expect(token.status, scope).toBe(403);
    expect(token.body, scope).not.toHaveProperty("models");
  }
  const platform = await asks(ws, user("u_platform", PLATFORM_OWNER, "admin", true));
  expect(platform.status).toBe(200);
  expect(platform.body).toHaveProperty("models");
});
